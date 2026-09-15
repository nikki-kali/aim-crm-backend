// src/services/evidentReport/pdf.js
const chromium = require('@sparticuz/chromium')
const puppeteer = require('puppeteer-core')

// puppeteer-core + @sparticuz/chromium instead of full puppeteer's own
// bundled Chromium: aim-crm-backend deploys to Render as a native Node
// web service (no Dockerfile), which is missing the system shared
// libraries (libnss3, libgbm1, libatk-bridge2.0-0, etc.) full puppeteer's
// Chromium needs to launch — @sparticuz/chromium is a Chromium build made
// specifically for restricted/serverless Linux environments like this one,
// and avoids migrating this shared production service to a Docker deploy
// just for one feature.
async function renderPdf(html) {
  // This report renders plain HTML/CSS to a PDF, not canvas/WebGL content,
  // so it has no need for @sparticuz/chromium's default graphics:true mode
  // (--use-gl=angle/--use-angle=swiftshader/--enable-unsafe-swiftshader).
  // That mode's supporting library archive is only extracted when the
  // package detects an AWS Lambda environment, which Render's native Node
  // runtime never signals — disabling it removes one more dependency on
  // Lambda-gated library extraction this environment may not provide.
  chromium.setGraphicsMode = false

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    // puppeteer-core@24.43.1's page.pdf() resolves to a Uint8Array, not a
    // Node Buffer — wrap it so callers (Task 6's orchestrator, which feeds
    // this straight into services/email.js's attachments) get the real
    // Buffer the interface promises.
    return Buffer.from(await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
    }))
  } finally {
    await browser.close()
  }
}

module.exports = { renderPdf }
