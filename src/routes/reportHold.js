const express = require('express')
const rateLimiter = require('../middleware/rateLimiter')
const { verifyHold, holdDay } = require('../services/reportHold')

const router = express.Router()

const esc = (str) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const page = (title, body) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7faf9;padding:60px 20px;text-align:center">
  <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:36px 30px;box-shadow:0 4px 20px rgba(0,0,0,.06)">${body}</div>
</body></html>`

// GET only DESCRIBES the hold (like GET /api/reports/approve): email scanners
// pre-open links, and a hold performed by a GET would silently block the
// day's report. The hold itself happens only on the POST from this page's button.
router.get('/', rateLimiter({ windowMs: 10 * 60 * 1000, max: 20 }), (req, res) => {
  const { day, sig } = req.query
  if (!verifyHold(day, sig)) return res.status(400).send(page('Invalid link', '<h1 style="margin:0 0 10px;font-size:19px;color:#10353f">This link is not valid</h1><p style="margin:0;font-size:14px;color:#5b7a86">It may be incomplete or for a different day.</p>'))
  res.send(page('Hold today\'s send', `
    <h1 style="margin:0 0 10px;font-size:19px;color:#10353f">Hold today's send?</h1>
    <p style="margin:0 0 22px;font-size:14px;color:#5b7a86;line-height:1.5">The Daily Leadership Dashboard for ${esc(day)} will <b>not</b> go to leadership automatically. You can still send it yourself from the preview email with Approve &amp; Send.</p>
    <form method="POST" action="/api/report-hold">
      <input type="hidden" name="day" value="${esc(day)}"><input type="hidden" name="sig" value="${esc(sig)}">
      <button type="submit" style="padding:12px 28px;background:#b45309;color:#fff;border:none;font-weight:600;font-size:14px;border-radius:10px;cursor:pointer">Hold today's send</button>
    </form>`))
})

router.post('/', rateLimiter({ windowMs: 10 * 60 * 1000, max: 20 }), express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { day, sig } = req.body || {}
    if (!verifyHold(day, sig)) return res.status(400).send(page('Invalid link', '<h1 style="margin:0;font-size:19px;color:#10353f">This link is not valid</h1>'))
    await holdDay(day)
    res.send(page('Held', `<h1 style="margin:0 0 10px;font-size:19px;color:#10353f">Held</h1><p style="margin:0;font-size:14px;color:#5b7a86;line-height:1.5">Nothing will go to leadership automatically for ${esc(day)}. You can still send it from the preview email whenever you're ready.</p>`))
  } catch (err) {
    console.error('[report-hold] failed:', err)
    res.status(500).send(page('Something went wrong', '<h1 style="margin:0 0 10px;font-size:19px;color:#10353f">Could not hold the send</h1><p style="margin:0;font-size:14px;color:#5b7a86">Please try again, or turn off the automatic send in Render.</p>'))
  }
})

module.exports = router
