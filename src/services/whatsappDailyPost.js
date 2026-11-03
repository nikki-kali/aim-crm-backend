const db = require('../config/db')
const {
  DAILY_REPORT_REP_EMAILS,
  computeMonthlySalesGoal,
  computeMonthlyDoctorsGoal,
  businessDaysLeftInMonth,
  lastBusinessDayEasternDateString,
  eviSmartNewDoctorsForRep,
  evidentMtdForRep,
} = require('./salesRepDailyReport')
const { PUSH_QUOTES } = require('./email')
const { buildTeamProgressChartUrl } = require('./evidentReport/chart')

const whole = (n) => '$' + Math.round(Number(n)).toLocaleString('en-US')
// Sales come from Evident's MTD billed email; null = that email wasn't
// available, shown as "—" rather than a made-up $0.
const money = (n) => (n === null || n === undefined ? '—' : whole(n))
const pctOf = (cur, target) => (cur !== null && cur !== undefined && target > 0 ? Math.min(Math.round((Number(cur) / Number(target)) * 100), 100) : 0)
const pctText = (cur, target) => (cur === null || cur === undefined ? '—' : `${pctOf(cur, target)}%`)

// Shown only in the first 5 calendar days of a new month — the team's
// numbers are near-zero then by definition, so the usual rotating
// PUSH_QUOTES (written for mid/late-month pacing) read oddly next to a
// bar at 2%. A separate, small set themed around a fresh start (user
// request, 2026-10-02): "made up" quotes, explicitly not attributed to
// anyone real.
const START_OF_MONTH_QUOTES = [
  "A new month is a blank scoreboard — the plays we make this week set the pace for all of it.",
  "The reps who win big months are the ones who sprint on day one, not day twenty.",
  "Strategize now, chase hard today — early moves compound all month long.",
  "Fresh month, fresh target. The first week decides how easy the last one feels.",
  "Every big month was won in its opening days. Set the tone now and make it count.",
]

// Picks the caption/image quote for a given day of the month — the single
// source both buildWhatsappDailyPost's caption and any caller rendering the
// static image should use, so the two never drift out of sync.
function pickDailyMessage(dayOfMonth) {
  if (dayOfMonth <= 5) return START_OF_MONTH_QUOTES[dayOfMonth % START_OF_MONTH_QUOTES.length]
  return PUSH_QUOTES[dayOfMonth % PUSH_QUOTES.length]
}

const previousWeekday = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`)
  do d.setUTCDate(d.getUTCDate() - 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6)
  return d.toISOString().slice(0, 10)
}

// Doctors whose first booking falls after the previous weekday's post, up to
// the report day (so a weekend first booking is congratulated on Monday).
function newDoctorsSinceLastPost(list, dateStr) {
  const after = previousWeekday(dateStr)
  return (list || []).filter((d) => d.firstCaseIso > after && d.firstCaseIso <= dateStr)
}

// Weekdays in dateStr's month up to and including dateStr.
function businessDaysElapsed(dateStr) {
  let count = 0
  const cur = new Date(`${dateStr.slice(0, 7)}-01T00:00:00Z`)
  for (const end = new Date(`${dateStr}T00:00:00Z`); cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
    if (cur.getUTCDay() !== 0 && cur.getUTCDay() !== 6) count += 1
  }
  return count
}

// On track = month-to-date billed is at least 90% of where an even pace
// across the month's weekdays would put it by the report day.
const PACE_TOLERANCE = 0.9
function isOnPace(rep, dateStr) {
  if (rep.salesCur === null || rep.salesCur === undefined || !(rep.salesTarget > 0)) return false
  const elapsed = businessDaysElapsed(dateStr)
  const share = elapsed / (elapsed + businessDaysLeftInMonth(dateStr))
  return rep.salesCur / rep.salesTarget >= PACE_TOLERANCE * share
}

const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

// The caption carries no figures (user request, 2026-11-03: the picture
// already shows them). A good-morning line, congratulations for doctors
// signed since the last post, "good work" for a rep on pace for the monthly
// sales goal, and one neutral team-wide nudge when anyone is behind pace.
// The nudge never names a rep, so no one is singled out negatively.
function buildCaption({ reps, dateStr, monthName }) {
  const lines = ['*Good morning, team!*', '']
  for (const r of reps) {
    if (r.signedSinceLastPost && r.signedSinceLastPost.length) lines.push(`Congratulations, ${r.firstName}, on bringing in ${joinNames(r.signedSinceLastPost)}!`)
  }
  const onPace = reps.filter((r) => isOnPace(r, dateStr))
  for (const r of onPace) lines.push(`Great work, ${r.firstName}: you're on track for your ${monthName} sales goal. Keep it going!`)
  if (onPace.length < reps.length) {
    lines.push("Some of our numbers are moving slower than we'd like. Let's use today to follow up with our doctors and get more cases booked.")
  } else {
    lines.push("Let's keep the momentum going today!")
  }
  return lines.join('\n')
}

// The daily team post for the reps' WhatsApp group (Elizabeth relaying Ben,
// 2026-09-26): one picture with the team's combined progress plus each rep,
// and a short caption with a little motivation. Pure text and a picture URL,
// so it can be delivered by any channel. Every number is the same real
// month-to-date figure the reps' own Daily Sales Report shows (same
// computeMonthlySalesGoal / computeMonthlyDoctorsGoal). The tone is always
// positive and team-first; no rep is singled out negatively.
async function buildWhatsappDailyPost(dateStr = lastBusinessDayEasternDateString(), dayOfMonth = new Date().getDate()) {
  const { rows: users } = await db.query(
    `SELECT id, name, email FROM users WHERE email = ANY($1::text[]) ORDER BY name`,
    [DAILY_REPORT_REP_EMAILS]
  )
  const reps = []
  for (const u of users) {
    // The CRM goal rows supply only the TARGETS; the sales figures
    // themselves are Evident's MTD billed — "sales = billed" (Elizabeth,
    // 2026-10-02) — the same number the Leadership Dashboard and the reps'
    // own daily report show.
    // Booked is also Evident's MTD figure (Report #12) and is shown beside
    // billed (#40) on each card (user request, 2026-10-06); billed alone
    // drives the Monthly sales bar.
    const [sales, doctors, salesBilled, salesBooked, newDoctors] = await Promise.all([
      computeMonthlySalesGoal(u.email, dateStr),
      computeMonthlyDoctorsGoal(u.email, dateStr),
      evidentMtdForRep(u.email, dateStr, 'billed'),
      evidentMtdForRep(u.email, dateStr, 'booked'),
      eviSmartNewDoctorsForRep(u.email, dateStr),
    ])
    if (!sales || !doctors) continue
    reps.push({
      firstName: u.name.split(' ')[0],
      salesCur: salesBilled, bookedCur: salesBooked, salesTarget: Number(sales.target),
      docsCur: Number(doctors.current_value), docsTarget: Number(doctors.target),
      newDoctorNames: (newDoctors || []).map((d) => d.name),
      signedSinceLastPost: newDoctorsSinceLastPost(newDoctors, dateStr).map((d) => d.name),
    })
  }
  if (reps.length === 0) return null

  const team = reps.reduce((t, r) => ({
    salesCur: t.salesCur === null || r.salesCur === null ? null : t.salesCur + r.salesCur, salesTarget: t.salesTarget + r.salesTarget,
    bookedCur: t.bookedCur === null || r.bookedCur === null ? null : Math.round((t.bookedCur + r.bookedCur) * 100) / 100,
    docsCur: t.docsCur + r.docsCur, docsTarget: t.docsTarget + r.docsTarget,
  }), { salesCur: 0, bookedCur: 0, salesTarget: 0, docsCur: 0, docsTarget: 0 })

  const monthName = new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
  const caption = buildCaption({ reps, dateStr, monthName })

  const rowFor = (label, salesCur, salesTarget, docsCur, docsTarget) => ({
    label, salesPct: pctOf(salesCur, salesTarget), doctorsPct: pctOf(docsCur, docsTarget),
  })
  const chartUrl = buildTeamProgressChartUrl([
    rowFor('Team', team.salesCur, team.salesTarget, team.docsCur, team.docsTarget),
    ...reps.map((r) => rowFor(r.firstName, r.salesCur, r.salesTarget, r.docsCur, r.docsTarget)),
  ], `${monthName} progress toward goals`)

  return { caption, chartUrl, team, reps, dateStr }
}

const esc = (str) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// A screenshot-ready card for the WhatsApp group: frosted-glass panels over
// a deep teal backdrop with soft glowing light, thin rounded bars and one
// light sans-serif family (Manrope). Text carries every number (white on
// deep teal), so nothing depends on color alone. Each rep's card is the live
// "this month" bars only. The "last month" recap and the "acquired this
// week" list were shown while the month was turning over and removed
// 2026-10-05 at the user's request. The canvas height is not a fixed
// square: the body sizes to its real content and the caller crops the
// screenshot to it.
function buildWhatsappImageHtml(post, message) {
  const dateLabel = new Date(`${post.dateStr}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const glass = 'background:linear-gradient(145deg,rgba(255,255,255,.26),rgba(255,255,255,.10));backdrop-filter:blur(22px) saturate(140%);-webkit-backdrop-filter:blur(22px) saturate(140%);border:1px solid rgba(255,255,255,.42);box-shadow:0 14px 32px rgba(4,32,45,.28),inset 0 1px 0 rgba(255,255,255,.55)'
  const eyebrow = (text, opacity = .75) => `<div style="font:500 10px 'Manrope',sans-serif;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,${opacity})">${text}</div>`
  const metric = (label, big, ofText, pct, barPct) => `
    <div style="margin-top:16px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">${eyebrow(label)}<span style="color:#fff;font-size:12px;font-weight:600;letter-spacing:.02em">${pct}</span></div>
      <div style="margin-top:6px;font:300 34px/1 'Manrope',sans-serif;color:#fff;letter-spacing:-.02em;font-variant-numeric:tabular-nums">${big}<span style="font:400 12px 'Manrope',sans-serif;color:rgba(255,255,255,.72);letter-spacing:0"> ${ofText}</span></div>
      <div style="margin-top:10px;height:6px;border-radius:99px;background:rgba(255,255,255,.22);box-shadow:inset 0 1px 2px rgba(4,32,45,.25)"><div style="width:${barPct === 0 ? 0 : Math.max(barPct, 3)}%;height:100%;border-radius:99px;background:linear-gradient(90deg,#8ff3f5,#ffffff);box-shadow:0 0 12px rgba(143,243,245,.9)"></div></div>
    </div>`
  // Month-to-date booked next to billed (the bar above is billed).
  const bookedBilled = (r) => `
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,.2);display:flex;gap:12px">
      <div style="flex:1">${eyebrow('Booked')}<div style="margin-top:5px;font:400 19px/1 'Manrope',sans-serif;color:#fff;letter-spacing:-.01em;font-variant-numeric:tabular-nums">${money(r.bookedCur)}</div></div>
      <div style="flex:1">${eyebrow('Billed')}<div style="margin-top:5px;font:400 19px/1 'Manrope',sans-serif;color:#fff;letter-spacing:-.01em;font-variant-numeric:tabular-nums">${money(r.salesCur)}</div></div>
    </div>`
  // The new doctors' or practices' names, so the card says who was signed.
  const newDoctorNames = (r) => (r.newDoctorNames && r.newDoctorNames.length ? `
    <div style="margin-top:14px">${r.newDoctorNames.map((n) => `<div style="margin-top:4px;font:500 13px/1.35 'Manrope',sans-serif;color:#fff">${esc(n)}</div>`).join('')}</div>` : '')
  const card = (r) => `
    <div style="${glass};flex:1;border-radius:26px;padding:22px 22px 24px">
      <div style="font:600 17px 'Manrope',sans-serif;color:#fff;letter-spacing:.01em">${esc(r.firstName)}</div>
      <div style="margin-top:10px;height:1px;background:linear-gradient(90deg,rgba(255,255,255,.55),rgba(255,255,255,0))"></div>
      <div style="margin-top:14px">${eyebrow('This month', .6)}</div>
      ${metric('Monthly sales', money(r.salesCur), `of ${whole(r.salesTarget)}`, pctText(r.salesCur, r.salesTarget), pctOf(r.salesCur, r.salesTarget))}
      ${bookedBilled(r)}
      ${metric('New doctors', String(r.docsCur), `of ${r.docsTarget}`, `${pctOf(r.docsCur, r.docsTarget)}%`, pctOf(r.docsCur, r.docsTarget))}
      ${newDoctorNames(r)}
    </div>`
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap" rel="stylesheet">
</head><body style="margin:0;background:#0b3a4c;font-family:'Manrope',sans-serif">
<div style="position:relative;width:600px;overflow:hidden;background:linear-gradient(165deg,#207290 0%,#124f64 45%,#0a3345 100%)">
  <div style="position:absolute;top:-110px;left:-80px;width:340px;height:340px;border-radius:50%;background:#06babe;opacity:.55;filter:blur(70px)"></div>
  <div style="position:absolute;top:220px;right:-130px;width:320px;height:320px;border-radius:50%;background:#a9cfe3;opacity:.36;filter:blur(80px)"></div>
  <div style="position:absolute;bottom:-110px;left:60px;width:300px;height:260px;border-radius:50%;background:#06babe;opacity:.4;filter:blur(80px)"></div>
  <div style="position:relative;padding:60px 32px 48px">
    <div style="font:500 10px 'Manrope',sans-serif;letter-spacing:.26em;text-transform:uppercase;color:rgba(255,255,255,.75)">AIM Dental Laboratory</div>
    <div style="margin-top:8px;font:300 32px/1.1 'Manrope',sans-serif;color:#fff;letter-spacing:-.02em">Sales Team Progress</div>
    <div style="margin-top:6px;font:400 12px 'Manrope',sans-serif;color:rgba(255,255,255,.8)">${dateLabel}</div>
    <div style="display:flex;gap:16px;margin-top:18px;align-items:stretch">${post.reps.map(card).join('')}</div>
    <div style="${glass};margin-top:16px;border-radius:22px;padding:15px 24px;text-align:center;font:400 14px/1.45 'Manrope',sans-serif;color:#fff;letter-spacing:.005em">${esc(message)}</div>
  </div>
</div></body></html>`
}

module.exports = { buildWhatsappDailyPost, buildWhatsappImageHtml, pickDailyMessage, buildCaption, isOnPace, newDoctorsSinceLastPost }
