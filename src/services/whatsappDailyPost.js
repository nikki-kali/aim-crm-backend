const db = require('../config/db')
const {
  DAILY_REPORT_REP_EMAILS,
  computeMonthlySalesGoal,
  computeMonthlyDoctorsGoal,
  businessDaysLeftInMonth,
  lastBusinessDayEasternDateString,
  listNewDoctorNamesOnDate,
  listNewDoctorNamesThisWeek,
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

// First/last day of the calendar month BEFORE the one dateStr falls in —
// e.g. '2026-10-05' -> '2026-09-30'. Reuses computeMonthlySalesGoal /
// computeMonthlyDoctorsGoal's own month-resolution (they key off whatever
// calendar month a date falls in), so passing this date back into them
// computes last month's real totals with no separate code path.
function lastMonthDateStr(dateStr) {
  const [y, m] = dateStr.split('-').map(Number)
  const prevMonth = m === 1 ? 12 : m - 1
  const prevYear = m === 1 ? y - 1 : y
  const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate()
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
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
  const priorMonthDateStr = lastMonthDateStr(dateStr)
  const reps = []
  for (const u of users) {
    // The CRM goal rows supply only the TARGETS; the sales figures
    // themselves are Evident's MTD billed — "sales = billed" (Elizabeth,
    // 2026-10-02) — the same number the Leadership Dashboard and the reps'
    // own daily report show.
    const [sales, doctors, wonToday, doctorsThisWeek, lastMonthSales, lastMonthDoctors, salesBilled, lastMonthBilled] = await Promise.all([
      computeMonthlySalesGoal(u.email, dateStr),
      computeMonthlyDoctorsGoal(u.email, dateStr),
      listNewDoctorNamesOnDate(u.id, dateStr),
      listNewDoctorNamesThisWeek(u.id, dateStr),
      computeMonthlySalesGoal(u.email, priorMonthDateStr),
      computeMonthlyDoctorsGoal(u.email, priorMonthDateStr),
      evidentMtdForRep(u.email, dateStr, 'billed'),
      evidentMtdForRep(u.email, priorMonthDateStr, 'billed'),
    ])
    if (!sales || !doctors) continue
    reps.push({
      firstName: u.name.split(' ')[0],
      salesCur: salesBilled, salesTarget: Number(sales.target),
      docsCur: Number(doctors.current_value), docsTarget: Number(doctors.target),
      wonToday,
      doctorsThisWeek,
      // Best-effort, like every other figure here: a failed lookup omits
      // the whole summary for that rep rather than showing a fabricated 0.
      lastMonth: (lastMonthSales && lastMonthDoctors) ? {
        salesCur: lastMonthBilled, salesTarget: Number(lastMonthSales.target),
        docsCur: Number(lastMonthDoctors.current_value), docsTarget: Number(lastMonthDoctors.target),
      } : null,
    })
  }
  if (reps.length === 0) return null

  const team = reps.reduce((t, r) => ({
    salesCur: t.salesCur === null || r.salesCur === null ? null : t.salesCur + r.salesCur, salesTarget: t.salesTarget + r.salesTarget,
    docsCur: t.docsCur + r.docsCur, docsTarget: t.docsTarget + r.docsTarget,
  }), { salesCur: 0, salesTarget: 0, docsCur: 0, docsTarget: 0 })

  const monthName = new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
  const daysLeft = businessDaysLeftInMonth(dateStr)
  const quote = pickDailyMessage(dayOfMonth)
  // "Won today" names (Ben's request, 2026-10-01) — only for today's real
  // wins, not a month-to-date list, so it's omitted entirely on a quiet
  // day rather than padded out with repeated names.
  const line = (r) => [
    `*${r.firstName}*`,
    `Sales: ${money(r.salesCur)} of ${whole(r.salesTarget)} (${pctText(r.salesCur, r.salesTarget)})`,
    `New doctors: ${r.docsCur} of ${r.docsTarget} (${pctOf(r.docsCur, r.docsTarget)}%)`,
    ...(r.wonToday.length ? [`Won today: ${r.wonToday.join(', ')}`] : []),
    ...(r.doctorsThisWeek.length ? [`This week: ${r.doctorsThisWeek.join(', ')}`] : []),
  ].join('\n')

  const caption = [
    `*Good morning, team!* Here is where we stand for ${monthName}.`,
    '',
    `*Team*\nSales: ${money(team.salesCur)} of ${whole(team.salesTarget)} (${pctText(team.salesCur, team.salesTarget)})\nNew doctors: ${team.docsCur} of ${team.docsTarget} (${pctOf(team.docsCur, team.docsTarget)}%)`,
    '',
    ...reps.flatMap((r) => [line(r), '']),
    `"${quote}"`,
    '',
    `Every doctor we sign and every case we book moves these bars${daysLeft > 0 ? `, and we still have ${daysLeft} business day${daysLeft === 1 ? '' : 's'} this month` : ''}. Let's make today count!`,
  ].join('\n')

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
// deep teal), so nothing depends on color alone. Each rep's card has three
// clearly separated, independently labeled zones so "this month" (the live
// bars), "this week" (recent acquisitions) and "last month" (a closed,
// historical recap) never blur into one confusing block (user feedback,
// 2026-10-02) — each gets its own eyebrow label, and "Last month" is set
// off with a dashed divider and dimmer styling to read as past, not
// current. The canvas height is no longer a fixed square: with up to three
// sections per card it would otherwise clip or overlap content, so the
// body sizes to its real content and the caller screenshots the full page
// rather than a fixed viewport.
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
  const thisWeekSection = (r) => (r.doctorsThisWeek || []).length ? `
    <div style="margin-top:18px">
      ${eyebrow('Acquired this week')}
      <div style="margin-top:6px;font:400 13px/1.5 'Manrope',sans-serif;color:#fff">${esc(r.doctorsThisWeek.join(', '))}</div>
    </div>` : ''
  const lastMonthSection = (r) => r.lastMonth ? `
    <div style="margin-top:18px;padding-top:14px;border-top:1px dashed rgba(255,255,255,.35)">
      ${eyebrow('Last month', .55)}
      <div style="margin-top:6px;font:400 13px/1.5 'Manrope',sans-serif;color:rgba(255,255,255,.85)">${money(r.lastMonth.salesCur)} sales &middot; ${r.lastMonth.docsCur} new doctor${r.lastMonth.docsCur === 1 ? '' : 's'}</div>
    </div>` : ''
  const card = (r) => `
    <div style="${glass};flex:1;border-radius:26px;padding:22px 22px 24px">
      <div style="font:600 17px 'Manrope',sans-serif;color:#fff;letter-spacing:.01em">${esc(r.firstName)}</div>
      <div style="margin-top:10px;height:1px;background:linear-gradient(90deg,rgba(255,255,255,.55),rgba(255,255,255,0))"></div>
      <div style="margin-top:14px">${eyebrow('This month', .6)}</div>
      ${metric('Monthly sales', money(r.salesCur), `of ${whole(r.salesTarget)}`, pctText(r.salesCur, r.salesTarget), pctOf(r.salesCur, r.salesTarget))}
      ${metric('New doctors', String(r.docsCur), `of ${r.docsTarget}`, `${pctOf(r.docsCur, r.docsTarget)}%`, pctOf(r.docsCur, r.docsTarget))}
      ${thisWeekSection(r)}
      ${lastMonthSection(r)}
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
    <div style="display:flex;gap:16px;margin-top:18px;align-items:flex-start">${post.reps.map(card).join('')}</div>
    <div style="${glass};margin-top:16px;border-radius:22px;padding:15px 24px;text-align:center;font:400 14px/1.45 'Manrope',sans-serif;color:#fff;letter-spacing:.005em">${esc(message)}</div>
  </div>
</div></body></html>`
}

module.exports = { buildWhatsappDailyPost, buildWhatsappImageHtml, pickDailyMessage }
