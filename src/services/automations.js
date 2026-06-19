const db = require('../config/db')
const { sendEmail, coldLeadEmail, caseDueEmail, lostRecoveryEmail, winStreakEmail } = require('./email')

async function runAutomationLogic(key) {
  const now = Date.now()

  if (key === 'cold_lead') {
    const threshold = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString()
    const { rows } = await db.query(
      `SELECT id, doctor_name, clinic_name, last_contacted_at, created_at, status FROM leads
       WHERE status NOT IN ('Won','Lost')
         AND COALESCE(last_contacted_at, created_at) < $1`,
      [threshold]
    )
    if (rows.length > 0) {
      await db.query(`DELETE FROM alerts WHERE type='cold_lead' AND read=false`)
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
      return { message: `${rows.length} cold lead${rows.length > 1 ? 's' : ''} flagged`, found: true }
    }
    return { message: 'No cold leads right now', found: false }
  }

  if (key === 'case_due') {
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
      `SELECT id, doctor_name, updated_at FROM leads WHERE status='Lost' AND updated_at < $1`,
      [threshold30]
    )
    if (rows.length > 0) {
      await db.query(`DELETE FROM alerts WHERE type='lost_recovery' AND read=false`)
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
      return { message: `${rows.length} lead${rows.length > 1 ? 's' : ''} ready for recovery`, found: true }
    }
    return { message: 'No recovery candidates', found: false }
  }

  if (key === 'win_streak') {
    const { rows } = await db.query(
      `SELECT status FROM leads WHERE status IN ('Won','Lost') ORDER BY updated_at DESC LIMIT 10`
    )
    let streak = 0
    for (const row of rows) {
      if (row.status === 'Won') streak++
      else break
    }
    if (streak >= 3) {
      const { rows: existing } = await db.query(
        `SELECT id FROM alerts WHERE type='win_streak' AND read=false LIMIT 1`
      )
      if (!existing.length) {
        await db.query(
          `INSERT INTO alerts (type, title, message, metadata) VALUES ($1,$2,$3,$4)`,
          ['win_streak', `Win Streak: ${streak} in a Row!`,
           `Your last ${streak} resolved leads are all wins — keep the momentum going!`,
           JSON.stringify({ streak })]
        )
        if (process.env.ALERT_EMAIL) {
          await sendEmail({ subject: `🏆 Win Streak: ${streak} in a Row!`, html: winStreakEmail(streak) })
        }
      }
      return { message: `Active streak: ${streak} wins in a row!`, found: true }
    }
    return { message: streak > 0 ? `Streak at ${streak} (need 3+)` : 'No active win streak', found: false }
  }

  return { message: 'Unknown automation key', found: false }
}

module.exports = { runAutomationLogic }
