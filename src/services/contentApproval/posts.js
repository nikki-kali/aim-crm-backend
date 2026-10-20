// The posts listed on Marketing OS's /content-approvals page, with their
// scheduled dates, so the automatic follow-up can say which ones still need a
// decision. Keep in sync with Marketing OS's src/data/octoberApprovals.js
// (ids must match the ones the approvals page saves decisions under).
const APPROVAL_POSTS = [
  { id: 'oct05', date: '2026-10-09', title: 'Real Cost of a Remake (carousel)', note: 'We refreshed the visuals and restored the approved guarantee wording on the last slide.' },
  { id: 'oct11', date: '2026-10-11', title: 'Rush Cases' },
  { id: 'oct13', date: '2026-10-13', title: '7 Questions to Ask Before Choosing a Lab' },
  { id: 'oct09', date: '2026-10-15', title: 'Team Shout-Out' },
  { id: 'scanner', date: '2026-10-17', title: 'Scanner (carousel)' },
  { id: 'oct21-howto-reel', date: '2026-10-21', title: 'How to Send Us a Case (reel)' },
  { id: 'oct23-video', date: '2026-10-23', title: '75 Years: 1951 to 2026 (video)' },
  { id: 'oct27', date: '2026-10-27', title: 'Zirconia or e.max' },
  { id: 'oct31', date: '2026-10-31', title: 'Lab or Natural?' },
  // Blog articles. `date` is when the article is needed by (the post that
  // links to it, or its publish date).
  { id: 'art-7questions', date: '2026-10-16', title: 'Article: 7 Questions to Ask Before You Send a Case', note: 'The Oct 13 post already links to it.' },
  { id: 'art-guarantee', date: '2026-10-24', title: "Article update: What Happens If a Case Doesn't Fit?" },
  { id: 'art-zirconia', date: '2026-10-26', title: 'Article: Zirconia or e.max' },
  { id: 'art-turnaround', date: '2026-10-30', title: 'Article update: Turnaround Times and Our 2% Remake Rate' },
  { id: 'art-diabetes', date: '2026-11-03', title: 'Article: What Diabetes Means for Restorative Case Planning' },
]

// A follow-up only goes out for posts that are coming up soon or missed
// their date recently; older undecided posts are assumed to be handled.
const LOOKBACK_DAYS = 3
const LOOKAHEAD_DAYS = 10

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// decisions: rows from content_approval_decisions ({ post_id, status }).
function pendingPosts(decisions, todayStr) {
  const decided = new Set(decisions.filter((d) => d.status).map((d) => d.post_id))
  const pending = APPROVAL_POSTS.filter((p) => !decided.has(p.id))
  const from = addDays(todayStr, -LOOKBACK_DAYS)
  const to = addDays(todayStr, LOOKAHEAD_DAYS)
  const due = pending.filter((p) => p.date >= from && p.date <= to).sort((a, b) => a.date.localeCompare(b.date))
  return { total: APPROVAL_POSTS.length, pendingCount: pending.length, due }
}

module.exports = { APPROVAL_POSTS, pendingPosts }
