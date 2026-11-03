// The daily WhatsApp team progress post: builds the picture and caption and
// emails them to the person who posts it in the group. Started by cron-job.org
// (see docs/scheduled-jobs.md) through routes/cron.js. The post always uses the
// day's EviSmart report, which can arrive late, so an early attempt with no
// report just waits and a later attempt tries again; only the final attempt
// raises an alert. Gated behind WHATSAPP_POST_ENABLED, once per day.
const { buildWhatsappDailyPost, buildWhatsappImageHtml, pickDailyMessage } = require('../services/whatsappDailyPost')
const { renderWhatsappPng } = require('../services/whatsappPostImage')
const { eviSmartReportAvailable, lastBusinessDayEasternDateString } = require('../services/salesRepDailyReport')
const { sendEmail } = require('../services/email')
const { APPROVER_EMAIL } = require('../services/reportApproval')
const { claimJobRun, releaseJobRun, todayEt } = require('../services/cronRuns')

// Standing rule (2026-10-02): every generated post goes to this address.
const WHATSAPP_POST_RECIPIENT = 'nadinekate.d.limjoco@gmail.com'

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// The picture shows every figure, so a rep's billed or booked figure that
// Evident didn't provide (null) must stop the post. The caption carries no
// figures, but "undefined" or "NaN" in it still means something broke.
const hasMissingNumbers = (post) => (post.reps || []).some((r) => [r.salesCur, r.bookedCur].some((v) => v === null || v === undefined || Number.isNaN(v)))
  || /undefined|NaN/.test(String(post.caption))

// Pure orchestration (every dependency passed in) so each outcome is tested.
// Returns 'waiting-for-evismart' | 'held' | 'failed' | 'sent'.
async function runWhatsappPost({ dateStr, hasEviSmart, buildPost, buildImageHtml, pickMessage, render, send, alertApprover, final }) {
  if (!(await hasEviSmart(dateStr))) {
    if (!final) return 'waiting-for-evismart'
    await alertApprover(`The WhatsApp post for ${dateStr} was not made: the EviSmart Daily Sales Report for that day never arrived. Nothing was sent. Once it is in, ask me to run it, or trigger the job again.`)
    return 'held'
  }
  try {
    const post = await buildPost()
    if (!post) throw new Error('there is no rep goal data to build the post from')
    if (hasMissingNumbers(post)) throw new Error('a figure in the post is unavailable (it would show a dash), so it was not sent')
    const png = await render(buildImageHtml(post, pickMessage()))
    await send({
      to: [WHATSAPP_POST_RECIPIENT],
      subject: `WhatsApp progress post - ${post.dateStr}`,
      html: `<p style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(post.caption)}</p><p style="font-family:sans-serif;color:#5b7a86">Image attached.</p>`,
      attachments: [{ filename: `sales-rep-progress-${post.dateStr}.png`, content: png, contentType: 'image/png' }],
    })
    return 'sent'
  } catch (err) {
    console.error('[whatsapp-post] failed:', err)
    await alertApprover(`The WhatsApp post for ${dateStr} was not sent: ${err.message}`)
    return 'failed'
  }
}

const enabled = () => process.env.WHATSAPP_POST_ENABLED === 'true'

async function runWhatsappPostJob({ source = 'cron', force = false, final = false } = {}) {
  if (!enabled()) {
    console.log('[whatsapp-post] run skipped, WHATSAPP_POST_ENABLED is not set to true')
    return 'disabled'
  }
  const day = todayEt()
  if (!force && !(await claimJobRun('whatsapp-post', day, source))) {
    console.log(`[whatsapp-post] already ran for ${day}, skipping (${source})`)
    return 'already-ran'
  }
  const dateStr = lastBusinessDayEasternDateString()
  try {
    const outcome = await runWhatsappPost({
      dateStr, final,
      hasEviSmart: eviSmartReportAvailable,
      buildPost: () => buildWhatsappDailyPost(dateStr),
      buildImageHtml: buildWhatsappImageHtml,
      pickMessage: () => pickDailyMessage(new Date().getDate()),
      render: renderWhatsappPng,
      send: sendEmail,
      alertApprover: (reason) => sendEmail({ to: [APPROVER_EMAIL], subject: 'WhatsApp post was NOT sent', html: `<p>${escapeHtml(reason)}</p>` }),
    })
    // Only a sent post (or a final alert) uses up the day; the rest may retry.
    if (outcome === 'waiting-for-evismart' || outcome === 'failed') await releaseJobRun('whatsapp-post', day)
    return outcome
  } catch (err) {
    console.error('[whatsapp-post] run failed:', err)
    await releaseJobRun('whatsapp-post', day)
    return 'failed'
  }
}

module.exports = { runWhatsappPost, runWhatsappPostJob, WHATSAPP_POST_RECIPIENT }
