// Renders the WhatsApp team progress card (HTML from whatsappDailyPost.js) to
// a PNG, on the server (Render) or locally. Same Chrome as the goal-bar GIFs
// (@sparticuz/chromium in production, the local Chrome on a developer's Mac).
// The page is 600px wide and the picture is cropped to the card's real height,
// at 2x for a sharp image in WhatsApp.
const { resolveLaunchOptions } = require('./goalBarGifRenderer')

async function renderWhatsappPng(html) {
  const puppeteer = require('puppeteer-core')
  const browser = await puppeteer.launch(await resolveLaunchOptions())
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 600, height: 900, deviceScaleFactor: 2 })
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 })
    await page.evaluate(() => document.fonts.ready).catch(() => {})
    const height = await page.evaluate(() => Math.ceil(document.querySelector('body > div').getBoundingClientRect().height))
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 600, height } })
    return Buffer.from(png)
  } finally {
    await browser.close()
  }
}

module.exports = { renderWhatsappPng }
