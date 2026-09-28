// Renders today's sales-rep progress picture for the WhatsApp group and saves
// it as a PNG. Usage: node scripts/whatsapp-progress-image.js [outputFolder]
require('dotenv').config()
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { buildWhatsappDailyPost, buildWhatsappImageHtml } = require('../src/services/whatsappDailyPost')

const MESSAGE = "Every doctor we sign and every case we book moves these bars. Let's make today count, team!"
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

;(async () => {
  const outDir = process.argv[2] || path.join(os.homedir(), 'Desktop', 'SALES REP PROGRESS REPORTS WA')
  fs.mkdirSync(outDir, { recursive: true })
  const post = await buildWhatsappDailyPost()
  if (!post) throw new Error('no rep goal data available')
  const html = path.join(os.tmpdir(), 'wa-progress.html')
  fs.writeFileSync(html, buildWhatsappImageHtml(post, MESSAGE))
  const png = path.join(outDir, `sales-rep-progress-${post.dateStr}.png`)
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=600,600', '--virtual-time-budget=6000', '--virtual-time-budget=6000', `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' })
  fs.unlinkSync(html)
  console.log(png)
  process.exit(0)
})().catch((e) => { console.error(e.message); process.exit(1) })
