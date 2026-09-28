// Pure HTML/easing for the Sales Rep Daily Report's animated progress-bar
// GIF (user request, 2026-09-28: bars and numbers count up together, then
// hold on the real values for ~15s before looping). Kept DB-free and
// Chrome-free — same "pure renderer" boundary as evidentReport/buildReport.js
// and chart.js — so goalBarGifRenderer.js (which drives real Chrome) can
// stay a thin orchestration layer, and this file's output is directly
// unit-testable.
//
// Colors/fonts match the light Leadership Dashboard theme already used by
// salesRepDailyReportEmail (src/services/email.js's BRAND/FONT_DATA), per
// user request to keep the animation "near the design of the current
// report" rather than the darker WhatsApp-picture look.
const FONT_LINK = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&family=DM+Mono:wght@500&display=swap"
const TEAL = '#06babe'
const TEAL_LIGHT = '#3fd6da'
const INK = '#10353f'
const SLATE = '#5b7a86'
const DEEP = '#207290'

// Ease-in-out quint: gentle start, gentle landing — smoother than a linear
// or plain ease-out count-up (user request, 2026-09-28: "move smoothly and
// elegantly").
function ease(t) {
  return t < 0.5 ? 16 * t ** 5 : 1 - ((-2 * t + 2) ** 5) / 2
}

// One goal's numbers at a given animation progress (0..1). `fmt` renders
// the interpolated value the same way the real static bar does (whole
// dollars, whole doctors, whole cases — see email.js's meter() fmtMoney for
// the dollar case).
function goalBarFrameValues(goal, progress) {
  const current = Number(goal.current_value) || 0
  const target = Number(goal.target) || 0
  const value = current * progress
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0
  return { value, pct }
}

// Renders one full HTML page for one animation frame: three stacked glass
// cards, matching salesRepDailyReportEmail's meter() styling. `goals` is
// [{ label, current_value, target, fmt, ofText }], in display order — the
// caller (goalBarGifRenderer.js) decides which real goals to include (2 or
// 3, once a cases goal exists). `progress` is 0..1; 1 renders the true
// final values, which is also what a viewer sees if their mail client only
// ever shows a GIF's first frame incorrectly cached as the last (Gmail
// doesn't do this, but it's a reason frame 0 is never in the exported set).
function renderGoalBarFrameHtml(goals, progress, { width = 600 } = {}) {
  const rows = goals.map((g, i) => {
    const { value, pct } = goalBarFrameValues(g, progress)
    const shown = Math.round(pct)
    const fillPct = pct > 0 ? Math.max(pct, 1) : 0
    const valueText = g.fmt ? g.fmt(value) : String(Math.round(value))
    return `
    <div style="background-color:#ffffff;background-color:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.9);box-shadow:0 8px 24px rgba(32,114,144,.12);border-radius:16px;padding:16px 22px 18px;margin-top:${i === 0 ? 0 : 12}px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;font:500 11px 'DM Mono',monospace;letter-spacing:.09em;text-transform:uppercase;color:${SLATE}"><span>${g.label}</span><span style="color:${DEEP};font-size:14px;font-variant-numeric:tabular-nums">${shown}%</span></div>
      <div style="margin-top:6px;font:500 28px/1.15 'DM Mono',monospace;color:${INK};letter-spacing:-.02em">${valueText}<span style="font:400 14px 'DM Sans',sans-serif;color:${SLATE};letter-spacing:0"> ${g.ofText}</span></div>
      <div style="position:relative;margin-top:13px;height:9px;border-radius:99px;background:#e6efee;box-shadow:inset 0 1px 2px rgba(32,114,144,.18)">
        <div style="position:absolute;left:0;top:0;height:100%;width:${fillPct}%;border-radius:99px;background:linear-gradient(90deg,${TEAL},${TEAL_LIGHT});box-shadow:0 0 9px rgba(6,186,190,.75),0 0 20px rgba(6,186,190,.35)"></div>
      </div>
    </div>`
  }).join('')
  const height = 90 + goals.length * 108
  return {
    width,
    height,
    html: `<!doctype html><html><head><meta charset="utf-8">
<link href="${FONT_LINK}" rel="stylesheet"></head>
<body style="margin:0;background:#e9f6f6">
<div style="position:relative;width:${width}px;height:${height}px;overflow:hidden;background:linear-gradient(160deg,#ffffff 0%,#e6f9f9 48%,#eaf3f7 100%)">
  <div style="position:relative;padding:26px 30px">${rows}</div>
</div></body></html>`,
  }
}

// The frame plan: how many frames, how long each is shown, and how long the
// final frame holds — shared between the real renderer and its tests so
// the two can never drift. Count-up ≈2.7s at 20fps (54 frames), then a
// 15s hold on the true final values before the GIF loops (user request,
// 2026-09-28: "Hold it for up to 15 seconds if possible").
const COUNT_FRAMES = 54
const FRAME_DELAY_MS = 50
const HOLD_MS = 15000

function framePlan() {
  const progresses = []
  for (let i = 0; i <= COUNT_FRAMES; i++) {
    progresses.push(i === COUNT_FRAMES ? 1 : ease(i / COUNT_FRAMES))
  }
  const delaysMs = progresses.map((_, i) => (i === progresses.length - 1 ? HOLD_MS : FRAME_DELAY_MS))
  return { progresses, delaysMs }
}

// Goal builders matching the real static bars' own value formatting (see
// email.js's meter() calls) — shared so the GIF and the static fallback
// never show conflicting number formats for the same goal.
const fmtMoney = (n) => '$' + Math.round(n).toLocaleString('en-US')
const fmtWhole = (n) => String(Math.round(n))

function salesGoalFrameInput(salesGoal) {
  if (!salesGoal) return null
  return {
    label: 'Monthly Sales', current_value: salesGoal.current_value, target: salesGoal.target,
    fmt: fmtMoney, ofText: `of ${fmtMoney(salesGoal.target)}`,
  }
}
function doctorsGoalFrameInput(doctorsGoal) {
  if (!doctorsGoal) return null
  return {
    label: 'New Doctors This Month', current_value: doctorsGoal.current_value, target: doctorsGoal.target,
    fmt: fmtWhole, ofText: `of ${doctorsGoal.target} doctors`,
  }
}
function casesGoalFrameInput(casesGoal) {
  if (!casesGoal) return null
  return {
    label: 'Cases This Month', current_value: casesGoal.current_value, target: casesGoal.target,
    fmt: fmtWhole, ofText: `of ${casesGoal.target} cases`,
  }
}

module.exports = {
  ease, goalBarFrameValues, renderGoalBarFrameHtml, framePlan,
  salesGoalFrameInput, doctorsGoalFrameInput, casesGoalFrameInput,
  COUNT_FRAMES, FRAME_DELAY_MS, HOLD_MS,
}
