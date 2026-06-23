const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

// GET /api/eos/suggestions — rule-based productivity suggestions for the logged-in rep
router.get('/suggestions', auth, async (req, res, next) => {
  try {
    const userId = req.user.id
    const now = new Date()
    const dayOfWeek = now.getDay() // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
    const isWedOrLater = dayOfWeek >= 3 && dayOfWeek !== 0

    const weekStartDate = new Date(now)
    const d = weekStartDate.getDay()
    weekStartDate.setDate(weekStartDate.getDate() - (d === 0 ? 6 : d - 1))
    weekStartDate.setHours(0, 0, 0, 0)
    const weekStartISO  = weekStartDate.toISOString()
    const weekStartSQL  = weekStartDate.toISOString().split('T')[0]
    const monthStart    = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const coldThreshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const dueSoonSQL    = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const sevenDaysAgo  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000)
    const fiveDaysAgo   = new Date(Date.now() - 5  * 24 * 60 * 60 * 1000)

    const [rocksRes, todosRes, issuesRes, coldRes, winsRes, monthRes] = await Promise.all([
      db.query(
        `SELECT id, title, status, due_date FROM rocks
         WHERE owner_id=$1 AND status != 'Done'`,
        [userId]
      ),
      db.query(
        `SELECT completed, carried_over FROM weekly_todos
         WHERE owner_id=$1 AND week_start=$2 AND archived=false`,
        [userId, weekStartSQL]
      ),
      db.query(
        `SELECT id, title, status, created_at, updated_at FROM issues
         WHERE (raised_by=$1 OR owner_id=$1) AND status != 'Solved'
         ORDER BY created_at ASC`,
        [userId]
      ),
      db.query(
        `SELECT COUNT(*) AS count FROM leads
         WHERE assigned_to=$1 AND status NOT IN ('Won','Lost') AND is_archived=false
           AND COALESCE(last_contacted_at, created_at) < $2`,
        [userId, coldThreshold]
      ).catch(() => ({ rows: [{ count: 0 }] })),
      db.query(
        `SELECT COUNT(*) AS count FROM leads
         WHERE assigned_to=$1 AND status='Won' AND created_at >= $2`,
        [userId, weekStartISO]
      ).catch(() => ({ rows: [{ count: 0 }] })),
      db.query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='Won') AS won
         FROM leads WHERE assigned_to=$1 AND created_at >= $2`,
        [userId, monthStart]
      ).catch(() => ({ rows: [{ total: 0, won: 0 }] })),
    ])

    const suggestions = []

    // ── Rock rules ──────────────────────────────────────────────────────────────
    const rocks = rocksRes.rows

    if (rocks.length === 0) {
      suggestions.push({
        type: 'rock', priority: 'medium',
        message: 'You have no rocks this quarter — connect with your team to set your 90-day priorities.',
        action: 'Go to Rocks',
      })
    } else {
      rocks.forEach(r => {
        if (r.status === 'Off Track') {
          suggestions.push({
            type: 'rock', priority: 'high',
            message: `Rock "${r.title}" is Off Track — add a milestone or update your plan this week.`,
            action: 'Go to Rocks',
          })
        } else if (r.due_date && r.due_date <= dueSoonSQL) {
          const daysLeft = Math.ceil((new Date(r.due_date) - now) / (1000 * 60 * 60 * 24))
          suggestions.push({
            type: 'rock', priority: 'high',
            message: `Rock "${r.title}" is due in ${daysLeft} day${daysLeft !== 1 ? 's' : ''} — make sure your milestones are on schedule.`,
            action: 'Go to Rocks',
          })
        }
      })

      const allOnTrack = rocks.every(r => r.status === 'On Track')
      if (allOnTrack && rocks.length > 0) {
        suggestions.push({
          type: 'rock', priority: 'low',
          message: `All ${rocks.length} of your rocks are On Track — keep the momentum going!`,
          action: null,
        })
      }
    }

    // ── To-Do rules ─────────────────────────────────────────────────────────────
    const todos = todosRes.rows
    const total     = todos.length
    const done      = todos.filter(t => t.completed).length
    const carried   = todos.filter(t => t.carried_over).length

    if (total === 0) {
      suggestions.push({
        type: 'todo', priority: 'medium',
        message: "You haven't added any to-dos this week — plan your week to stay on track.",
        action: 'Go to To-Dos',
      })
    } else {
      if (carried >= 3) {
        suggestions.push({
          type: 'todo', priority: 'medium',
          message: `${carried} to-dos were carried over from last week — consider whether these are still priorities.`,
          action: 'Review To-Dos',
        })
      }
      if (isWedOrLater && done / total < 0.5) {
        suggestions.push({
          type: 'todo', priority: 'medium',
          message: `You've completed ${done} of ${total} to-dos so far this week — focus on finishing what's open.`,
          action: 'Go to To-Dos',
        })
      }
      if (done === total) {
        suggestions.push({
          type: 'todo', priority: 'low',
          message: `All ${total} to-dos complete this week — great discipline!`,
          action: null,
        })
      }
    }

    // ── Issue rules ─────────────────────────────────────────────────────────────
    const issues = issuesRes.rows

    if (issues.length >= 3) {
      suggestions.push({
        type: 'issue', priority: 'high',
        message: `You have ${issues.length} open issues — prioritize bringing these to your next team meeting.`,
        action: 'Go to Issues',
      })
    }

    issues.forEach(issue => {
      if (issue.status === 'Identified' && new Date(issue.created_at) < sevenDaysAgo) {
        const daysOpen = Math.floor((now - new Date(issue.created_at)) / (1000 * 60 * 60 * 24))
        suggestions.push({
          type: 'issue', priority: 'medium',
          message: `Issue "${issue.title}" has been open for ${daysOpen} days — bring it to IDS before it stalls.`,
          action: 'Go to Issues',
        })
      }
      if (issue.status === 'Discussed' && new Date(issue.updated_at) < fiveDaysAgo) {
        suggestions.push({
          type: 'issue', priority: 'medium',
          message: `Issue "${issue.title}" is in Discussed — is a solution ready to be confirmed?`,
          action: 'Go to Issues',
        })
      }
    })

    // ── Lead rules ──────────────────────────────────────────────────────────────
    const coldCount = Number(coldRes.rows[0]?.count || 0)
    if (coldCount > 0) {
      suggestions.push({
        type: 'lead', priority: 'high',
        message: `You have ${coldCount} lead${coldCount !== 1 ? 's' : ''} with no contact in 14+ days — schedule follow-ups before Friday.`,
        action: 'Go to Leads',
      })
    }

    const weekWins = Number(winsRes.rows[0]?.count || 0)
    if (weekWins === 0 && isWedOrLater) {
      suggestions.push({
        type: 'lead', priority: 'medium',
        message: 'No wins yet this week — review your pipeline for leads ready to close.',
        action: 'Go to Pipeline',
      })
    }

    const mTotal = Number(monthRes.rows[0]?.total || 0)
    const mWon   = Number(monthRes.rows[0]?.won   || 0)
    const convRate = mTotal > 0 ? Math.round(mWon / mTotal * 100) : 0
    if (mTotal >= 5 && convRate < 30) {
      suggestions.push({
        type: 'lead', priority: 'medium',
        message: `Your conversion rate this month is ${convRate}% — review your proposal and follow-up approach.`,
        action: 'Go to My Report',
      })
    }

    // ── Sort + filter ───────────────────────────────────────────────────────────
    const ORDER = { high: 0, medium: 1, low: 2 }
    suggestions.sort((a, b) => ORDER[a.priority] - ORDER[b.priority])

    const hasUrgent = suggestions.some(s => s.priority !== 'low')
    const filtered = hasUrgent ? suggestions.filter(s => s.priority !== 'low') : suggestions

    res.json(filtered.slice(0, 4))
  } catch (err) { next(err) }
})

module.exports = router
