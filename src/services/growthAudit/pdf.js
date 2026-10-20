// Prints the Growth Audit report (reportEmail in print mode) to a US Letter
// PDF that's attached to the report email. Same Chrome as the WhatsApp card
// and goal-bar GIFs (@sparticuz/chromium on Render, local Chrome on a Mac).
const { resolveLaunchOptions } = require('../goalBarGifRenderer')

async function renderReportPdf(html) {
  const puppeteer = require('puppeteer-core')
  const browser = await puppeteer.launch(await resolveLaunchOptions())
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 })
    const pdf = await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true })
    return Buffer.from(pdf)
  } finally {
    await browser.close()
  }
}

// "Smile Co Dental" -> "AIM-Growth-Audit-Smile-Co-Dental.pdf"
function reportPdfFilename(practice) {
  const slug = String(practice || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  return `AIM-Growth-Audit${slug ? `-${slug}` : ''}.pdf`
}

module.exports = { renderReportPdf, reportPdfFilename }
