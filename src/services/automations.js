const db = require('../config/db')
const { sendEmail, coldLeadEmail, caseDueEmail, lostRecoveryEmail, winStreakEmail } = require('./email')

// Individually notifies each sales_rep assigned to one of `leads` (leaving
// leads assigned to a 'staff' or unassigned rep untouched — only sales_rep
// gets per-lead notifications, per the Sales Rep role's whole purpose).
// Deliberately additive to the company-wide digest above each call site,
// which stays admin-only (user_id IS NULL) and unconditionally
// deleted+reinserted every run; these per-rep rows instead dedupe on
// (type, user_id, entityId) so a still-cold lead doesn't re-notify daily.
async function notifyAssignedReps(type, title, leads, messageFn) {
  const assignedIds = [...new Set(leads.map(l => l.assigned_to).filter(Boolean))]
  if (!assignedIds.length) return
  const { rows: reps } = await db.query(
    `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND role='sales_rep'`,
    [assignedIds]
  )
  const repIds = new Set(reps.map(r => r.id))
  for (const lead of leads) {
    if (!repIds.has(lead.assigned_to)) continue
    const { rows: existing } = await db.query(
      `SELECT id FROM alerts WHERE type=$1 AND user_id=$2 AND metadata->>'entityId'=$3 AND read=false`,
      [type, lead.assigned_to, lead.id]
    )
    if (existing.length) continue
    await db.query(
      `INSERT INTO alerts (type, title, message, metadata, user_id) VALUES ($1,$2,$3,$4,$5)`,
      [type, title, messageFn(lead), JSON.stringify({ entityType: 'lead', entityId: lead.id }), lead.assigned_to]
    )
  }
}

async function runAutomationLogic(key) {
  const now = Date.now()

  if (key === 'cold_lead') {
    const threshold = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString()
    const { rows } = await db.query(
      `SELECT id, doctor_name, clinic_name, assigned_to, last_contacted_at, created_at, status FROM leads
       WHERE status NOT IN ('Won','Lost')
         AND COALESCE(last_contacted_at, created_at) < $1`,
      [threshold]
    )
    if (rows.length > 0) {
      await db.query(`DELETE FROM alerts WHERE type='cold_lead' AND user_id IS NULL AND read=false`)
      const names = rows.slice(0, 3).map(l => l.doctor_name).join(', ')
      const extra = rows.length > 3 ? ` +${rows.length - 3} more` : ''
      await db.query(
        `INSERT INTO alerts (type, title, message, metadata) VALUES ($1,$2,$3,$4)`,
        ['cold_lead', `${rows.length} Cold Lead${rows.length > 1 ? 's' : ''} Need Follow-up`,
         `${names}${extra} — no contact in 14+ days`, JSON.stringify({ count: rows.length })]
      )
      if (process.env.ALERT_EMAIL) {
        await sendEmail({ subject: `⚠ ${rows.length} Cold Leads Need Follow-up`, html: coldLeadEmail(rows) })
      }
      await notifyAssignedReps('cold_lead', 'Cold Lead Needs Follow-up', rows,
        (l) => `${l.doctor_name}${l.clinic_name ? ' — ' + l.clinic_name : ''} — no contact in 14+ days`)
      return { message: `${rows.length} cold lead${rows.length > 1 ? 's' : ''} flagged`, found: true }
    }
    return { message: 'No cold leads right now', found: false }
  }

  if (key === 'case_due') {
    // Not scoped to a rep: cases have no assigned_to (or any owner link at
    // all — client_name is free text, not even a client_id FK), so there's
    // no reliable way to attribute a case to a specific sales rep. Stays a
    // company-wide, admin-only digest.
    const today = new Date().toISOString().split('T')[0]
    const in2days = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const { rows } = await db.query(
      `SELECT id, case_number, client_name, due_date FROM cases
       WHERE status != 'Delivered' AND due_date >= $1 AND due_date <= $2`,
      [today, in2days]
    )
    if (rows.length > 0) {
      await db.query(`DELETE FROM alerts WHERE type='case_due' AND read=false`)
      const names = rows.slice(0, 2).map(c => c.case_number).join(', ')
      const extra = rows.length > 2 ? ` +${rows.length - 2} more` : ''
      await db.query(
        `INSERT INTO alerts (type, title, message, metadata) VALUES ($1,$2,$3,$4)`,
        ['case_due', `${rows.length} Case${rows.length > 1 ? 's' : ''} Due Within 2 Days`,
         `${names}${extra} — check status and prepare for delivery`, JSON.stringify({ count: rows.length })]
      )
      if (process.env.ALERT_EMAIL) {
        await sendEmail({ subject: `📅 ${rows.length} Cases Due Within 2 Days`, html: caseDueEmail(rows) })
      }
      return { message: `${rows.length} case${rows.length > 1 ? 's' : ''} due soon`, found: true }
    }
    return { message: 'No upcoming deadlines', found: false }
  }

  if (key === 'lost_recovery') {
    const threshold30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { rows } = await db.query(
      `SELECT id, doctor_name, assigned_to, updated_at FROM leads WHERE status='Lost' AND updated_at < $1`,
      [threshold30]
    )
    if (rows.length > 0) {
      await db.query(`DELETE FROM alerts WHERE type='lost_recovery' AND user_id IS NULL AND read=false`)
      const names = rows.slice(0, 3).map(l => l.doctor_name).join(', ')
      const extra = rows.length > 3 ? ` +${rows.length - 3} more` : ''
      await db.query(
        `INSERT INTO alerts (type, title, message, metadata) VALUES ($1,$2,$3,$4)`,
        ['lost_recovery', `${rows.length} Lead${rows.length > 1 ? 's' : ''} Ready for Recovery`,
         `${names}${extra} — lost 30+ days ago, consider re-engaging`, JSON.stringify({ count: rows.length })]
      )
      if (process.env.ALERT_EMAIL) {
        await sendEmail({ subject: `🔄 ${rows.length} Leads Ready for Recovery`, html: lostRecoveryEmail(rows) })
      }
      await notifyAssignedReps('lost_recovery', 'Lead Ready for Recovery', rows,
        (l) => `${l.doctor_name} — lost 30+ days ago, consider re-engaging`)
      return { message: `${rows.length} lead${rows.length > 1 ? 's' : ''} ready for recovery`, found: true }
    }
    return { message: 'No recovery candidates', found: false }
  }

  if (key === 'win_streak') {
    // Company-wide digest (admin view) — unchanged.
    const { rows } = await db.query(
      `SELECT status FROM leads WHERE status IN ('Won','Lost') ORDER BY updated_at DESC LIMIT 10`
    )
    let streak = 0
    for (const row of rows) {
      if (row.status === 'Won') streak++
      else break
    }
    let found = false
    if (streak >= 3) {
      found = true
      const { rows: existing } = await db.query(
        `SELECT id FROM alerts WHERE type='win_streak' AND user_id IS NULL AND read=false LIMIT 1`
      )
      if (!existing.length) {
        await db.query(
          `INSERT INTO alerts (type, title, message, metadata) VALUES ($1,$2,$3,$4)`,
          ['win_streak', `Win Streak: ${streak} in a Row!`,
           `The team's last ${streak} resolved leads are all wins — keep the momentum going!`,
           JSON.stringify({ streak })]
        )
        if (process.env.ALERT_EMAIL) {
          await sendEmail({ subject: `🏆 Win Streak: ${streak} in a Row!`, html: winStreakEmail(streak) })
        }
      }
    }

    // Per-rep streaks — only sales reps get notified about their own.
    const { rows: reps } = await db.query(`SELECT id FROM users WHERE role='sales_rep'`)
    for (const rep of reps) {
      const { rows: repRows } = await db.query(
        `SELECT status FROM leads WHERE assigned_to=$1 AND status IN ('Won','Lost') ORDER BY updated_at DESC LIMIT 10`,
        [rep.id]
      )
      let repStreak = 0
      for (const row of repRows) {
        if (row.status === 'Won') repStreak++
        else break
      }
      if (repStreak < 3) continue
      const { rows: existingRep } = await db.query(
        `SELECT id FROM alerts WHERE type='win_streak' AND user_id=$1 AND read=false LIMIT 1`,
        [rep.id]
      )
      if (existingRep.length) continue
      await db.query(
        `INSERT INTO alerts (type, title, message, metadata, user_id) VALUES ($1,$2,$3,$4,$5)`,
        ['win_streak', `Win Streak: ${repStreak} in a Row!`,
         `Your last ${repStreak} resolved leads are all wins — keep the momentum going!`,
         JSON.stringify({ streak: repStreak }), rep.id]
      )
    }

    return found
      ? { message: `Active streak: ${streak} wins in a row!`, found: true }
      : { message: streak > 0 ? `Streak at ${streak} (need 3+)` : 'No active win streak', found: false }
  }

  return { message: 'Unknown automation key', found: false }
}

module.exports = { runAutomationLogic }
