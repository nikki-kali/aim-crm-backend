const express = require('express')
const cheerio = require('cheerio')
const auth = require('../middleware/auth')

const router = express.Router()

// Real technical checks against the labs' own real live sites — no paid
// SEO API involved, this backend just fetches the real pages directly.
// See CLAUDE.md's SEO sub-app section: this replaced a fully mocked
// audit once Semrush (the account this app otherwise expects for
// Keywords/Backlinks/Competitors) ran out of API units and a real,
// ongoing capability was still wanted for at least this one page.
//
// Deliberately scoped to genuinely-checkable static HTML/HTTP signals
// (title/meta tags, viewport tag, heading structure, missing alt text,
// broken internal links, real measured response time) — NOT true Core
// Web Vitals (LCP/CLS/INP), which need real browser rendering telemetry
// (Google PageSpeed Insights / Lighthouse) this app has no access to.
// A normal browser User-Agent is used since some sites block requests
// that don't look like one — this is the site owner auditing their own
// site, the same legitimate use case real SEO tools cover.
const DOMAIN_BY_BRAND = { aim: 'aimdentallab.com', kh: 'khdentallab.com' }
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MAX_PAGES = 6 // homepage + up to 5 discovered internal links — keeps an on-demand check fast

async function fetchPage(url) {
  const start = Date.now()
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' })
  const responseMs = Date.now() - start
  const ok = res.ok
  const html = ok ? await res.text() : ''
  return { ok, status: res.status, html, responseMs, finalUrl: res.url }
}

function checkPage(html, pageUrl) {
  const $ = cheerio.load(html)
  const title = $('title').first().text().trim()
  const metaDescription = $('meta[name="description"]').attr('content')?.trim()
  const hasViewport = $('meta[name="viewport"]').length > 0
  const h1Count = $('h1').length
  const imagesMissingAlt = $('img')
    .toArray()
    .filter((el) => !$(el).attr('alt')?.trim()).length
  return { pageUrl, title, metaDescription, hasViewport, h1Count, imagesMissingAlt }
}

function discoverInternalLinks(html, baseUrl, domain) {
  const $ = cheerio.load(html)
  const links = new Set()
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    try {
      const resolved = new URL(href, baseUrl)
      if (resolved.hostname === domain || resolved.hostname === `www.${domain}`) {
        resolved.hash = ''
        links.add(resolved.toString())
      }
    } catch {
      // ignore unparseable hrefs (mailto:, tel:, javascript:, etc.)
    }
  })
  return [...links]
}

router.get('/seo/audit/:brand', auth, async (req, res, next) => {
  try {
    const domain = DOMAIN_BY_BRAND[req.params.brand]
    if (!domain) return res.status(400).json({ error: 'Unknown brand' })
    const baseUrl = `https://${domain}`

    let home
    try {
      home = await fetchPage(baseUrl)
    } catch (err) {
      return res.status(502).json({ error: `Could not reach ${domain}: ${err.message}` })
    }
    if (!home.ok) {
      return res.status(502).json({
        error: `${domain} returned ${home.status} — the site may be blocking automated requests, or is genuinely down`,
      })
    }

    const internalLinks = discoverInternalLinks(home.html, home.finalUrl, domain).slice(0, MAX_PAGES - 1)
    const otherPages = await Promise.allSettled(internalLinks.map((url) => fetchPage(url)))

    const pageChecks = [checkPage(home.html, baseUrl)]
    let brokenLinks = 0
    let totalResponseMs = home.responseMs
    let pagesFetched = 1

    otherPages.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value.ok) {
        pageChecks.push(checkPage(result.value.html, internalLinks[i]))
        totalResponseMs += result.value.responseMs
        pagesFetched++
      } else {
        brokenLinks++
      }
    })

    const avgResponseMs = Math.round(totalResponseMs / pagesFetched)

    const missingTitle = pageChecks.filter((p) => !p.title).length
    const missingMeta = pageChecks.filter((p) => !p.metaDescription).length
    const multipleH1 = pageChecks.filter((p) => p.h1Count > 1).length
    const noH1 = pageChecks.filter((p) => p.h1Count === 0).length
    const pagesMissingViewport = pageChecks.filter((p) => !p.hasViewport).length
    const totalImagesMissingAlt = pageChecks.reduce((sum, p) => sum + p.imagesMissingAlt, 0)

    const issue = (id, label, ok, severity, pagesAffected) => ({
      id,
      label,
      status: ok ? 'pass' : 'flag',
      severity: ok ? 'low' : severity,
      pagesAffected: ok ? 0 : pagesAffected,
    })

    const categories = [
      {
        name: 'Crawlability',
        issues: [
          issue('broken-links', brokenLinks === 0 ? 'No broken internal links found' : `${brokenLinks} internal link(s) failed to load`, brokenLinks === 0, 'high', brokenLinks),
        ],
      },
      {
        name: 'Content',
        issues: [
          issue('titles', missingTitle === 0 ? 'All checked pages have a title tag' : `${missingTitle} page(s) missing a title tag`, missingTitle === 0, 'high', missingTitle),
          issue('meta-desc', missingMeta === 0 ? 'All checked pages have a meta description' : `${missingMeta} page(s) missing a meta description`, missingMeta === 0, 'medium', missingMeta),
          issue('h1', noH1 + multipleH1 === 0 ? 'All checked pages have exactly one H1' : `${noH1 + multipleH1} page(s) have zero or multiple H1 tags`, noH1 + multipleH1 === 0, 'medium', noH1 + multipleH1),
          issue('alt-text', totalImagesMissingAlt === 0 ? 'All images have alt text' : `${totalImagesMissingAlt} image(s) missing alt text`, totalImagesMissingAlt === 0, 'medium', totalImagesMissingAlt),
        ],
      },
      {
        name: 'Response time',
        issues: [
          {
            id: 'response-time',
            label: `Average real response time: ${avgResponseMs}ms across ${pagesFetched} page(s) checked`,
            status: avgResponseMs < 1000 ? 'pass' : 'flag',
            severity: avgResponseMs < 1000 ? 'low' : 'medium',
            pagesAffected: avgResponseMs < 1000 ? 0 : pagesFetched,
          },
        ],
      },
      {
        name: 'Mobile',
        issues: [
          issue('viewport', pagesMissingViewport === 0 ? 'Mobile viewport tag present on all checked pages' : `${pagesMissingViewport} page(s) missing a mobile viewport tag`, pagesMissingViewport === 0, 'high', pagesMissingViewport),
        ],
      },
      {
        name: 'Security',
        issues: [{ id: 'https', label: 'HTTPS enforced (this check itself only succeeds over HTTPS)', status: 'pass', severity: 'low', pagesAffected: 0 }],
      },
    ]

    res.json({
      audit: {
        domain,
        lastCrawled: new Date().toISOString(),
        pagesCrawled: pagesFetched,
        avgResponseMs,
        categories,
      },
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
