// Renders the Sales Rep Daily Report's animated progress-bar GIF and
// uploads it to Supabase Storage. Best-effort by design: renderGoalBarsGif
// returns null on ANY failure (Chrome not launching, encoding error,
// upload error) rather than throwing, so a bad render never blocks the
// report — salesRepDailyReport.js falls back to the existing static bars
// when this returns null. See docs/superpowers/specs/ (none written for
// this — approved conversationally, 2026-09-28, "Bounded" per the
// brainstorming skill) for the design this implements.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { createCanvas, Image } = require('canvas')
const GIFEncoder = require('gif-encoder-2')
const gifsiclePath = require('gifsicle')
const { execFileSync } = require('child_process')
const { createStorageClient } = require('../config/supabaseStorage')
const {
  renderGoalBarFrameHtml, framePlan,
  salesGoalFrameInput, doctorsGoalFrameInput, casesGoalFrameInput,
} = require('./goalBarAnimation')

const BUCKET = 'report-assets'

// Local dev (this Mac) has no Linux Chrome binary to launch; production
// (Render) has no system Chrome at all, hence @sparticuz/chromium's
// bundled one. Same dev/prod split this codebase already documents for
// other headless-Chrome scripts (scripts/whatsapp-progress-image.js uses
// a hardcoded local Chrome path for the same reason, one-off/manual
// rather than server-side).
const LOCAL_CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
]

async function resolveLaunchOptions() {
  if (process.env.RENDER || process.env.NODE_ENV === 'production') {
    // Lazy require: @sparticuz/chromium's bundled binary is Linux-only and
    // this module must still load (and its pure-JS parts stay usable) on a
    // developer's Mac, where require()'ing it is fine but launching it
    // would not be.
    const chromium = require('@sparticuz/chromium')
    return {
      executablePath: await chromium.executablePath(),
      args: chromium.args,
      headless: true,
    }
  }
  const found = LOCAL_CHROME_CANDIDATES.find((p) => fs.existsSync(p))
  if (!found) throw new Error('no local Chrome found for goal-bar GIF rendering (checked: ' + LOCAL_CHROME_CANDIDATES.join(', ') + ')')
  return { executablePath: found, args: ['--disable-gpu'], headless: 'new' }
}

// Renders every frame in one Chrome page session (not one launch per
// frame — the original prototype's per-frame `execFileSync` launch took
// ~40s for 25 frames; one session with in-page DOM updates renders 55
// frames in well under 15s).
async function renderFramesPng(goals, width) {
  const puppeteer = require('puppeteer-core')
  const { html, height } = renderGoalBarFrameHtml(goals, 0, { width })
  const launchOptions = await resolveLaunchOptions()
  const browser = await puppeteer.launch(launchOptions)
  try {
    const page = await browser.newPage()
    await page.setViewport({ width, height, deviceScaleFactor: 1 })
    await page.setContent(html, { waitUntil: 'networkidle0' })
    await page.evaluate(() => document.fonts.ready).catch(() => {})

    const { progresses, delaysMs } = framePlan()
    const pngs = []
    for (const progress of progresses) {
      const frame = renderGoalBarFrameHtml(goals, progress, { width })
      await page.setContent(frame.html, { waitUntil: 'domcontentloaded' })
      pngs.push(await page.screenshot({ type: 'png' }))
    }
    return { pngs, delaysMs, width, height }
  } finally {
    await browser.close()
  }
}

function encodeGif({ pngs, delaysMs, width, height }) {
  const encoder = new GIFEncoder(width, height, 'neuquant', false)
  encoder.setRepeat(0)
  encoder.setQuality(1)
  encoder.start()
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  pngs.forEach((buf, i) => {
    const img = new Image()
    img.src = buf
    ctx.drawImage(img, 0, 0)
    encoder.setDelay(delaysMs[i])
    encoder.addFrame(ctx)
  })
  encoder.finish()
  return encoder.out.getData()
}

// gif-encoder-2's own optimizer barely shrinks a genuinely-changing-every-
// frame animation like this one (measured: ~2.6MB either way, see the
// design conversation, 2026-09-28) — gifsicle's palette reduction and
// lossy compression is what actually gets this to a real email-sized file
// (measured: ~2.6MB -> ~780KB at these settings, visually verified). Runs
// as a real subprocess against the gifsicle package's bundled binary, no
// system install required.
function compressGif(buffer) {
  const tmpIn = path.join(os.tmpdir(), `goalbar-${crypto.randomUUID()}.gif`)
  const tmpOut = path.join(os.tmpdir(), `goalbar-${crypto.randomUUID()}-opt.gif`)
  fs.writeFileSync(tmpIn, buffer)
  try {
    execFileSync(gifsiclePath.default || gifsiclePath, ['-O3', '--colors', '192', '--lossy=20', tmpIn, '-o', tmpOut], { stdio: 'ignore' })
    return fs.readFileSync(tmpOut)
  } finally {
    fs.rmSync(tmpIn, { force: true })
    fs.rmSync(tmpOut, { force: true })
  }
}

async function ensurePublicBucket(supabase) {
  const { data: buckets } = await supabase.storage.listBuckets()
  if (buckets && buckets.some((b) => b.name === BUCKET)) return
  // idempotent: a concurrent create from another request racing this one
  // fails with "already exists", which is fine to ignore.
  await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {})
}

async function uploadGif(buffer, repEmail, dateStr) {
  const supabase = createStorageClient()
  await ensurePublicBucket(supabase)
  const storagePath = `sales-rep-daily-report/${dateStr}/${repEmail}-${crypto.randomUUID()}.gif`
  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: 'image/gif',
    upsert: false,
  })
  if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`)
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath)
  return data.publicUrl
}

// The only function most callers need: renders the animated GIF for this
// rep's real goals and returns its public URL, or null if anything at all
// went wrong (never throws — see file header). `salesGoal`/`doctorsGoal`/
// `casesGoal` are goalProgress.js's computeProgress() results (or null);
// only the non-null ones become bars, same as the static meter() calls in
// email.js already do.
async function renderGoalBarsGif({ salesGoal, doctorsGoal, casesGoal, repEmail, dateStr }) {
  const goals = [salesGoalFrameInput(salesGoal), doctorsGoalFrameInput(doctorsGoal), casesGoalFrameInput(casesGoal)].filter(Boolean)
  if (goals.length === 0) return null
  try {
    const frames = await renderFramesPng(goals, 600)
    const raw = encodeGif(frames)
    const compressed = compressGif(raw)
    return await uploadGif(compressed, repEmail, dateStr)
  } catch (err) {
    console.error(`[goal-bar-gif] render failed for ${repEmail} (falling back to static bars):`, err.message)
    return null
  }
}

module.exports = { renderGoalBarsGif, BUCKET }
