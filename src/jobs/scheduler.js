const cron = require('node-cron')
const { runAutomationLogic } = require('../services/automations')
const db = require('../config/db')
const { sendEmail } = require('../services/email')
const { getMondayDate } = require('../routes/weeklyTodos')

async function sendScheduledReports(frequency) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM report_schedules WHERE frequency=$1 AND enabled=true`, [frequency]
    )
    if (rows.length === 0) return

    // Build report summary data
    const yearStart = `${new Date().getFullYear()}-01-01`
    const coldThreshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const [kpiRes, ytdRes, brandRes, coldRes] = await Promise.all([
      db.query(`SELECT (SELECT COUNT(*) FROM leads WHERE status NOT IN ('Won','Lost') AND is_archived=false) AS active_leads, (SELECT COALESCE(SUM(total_revenue),0) FROM clients) AS total_revenue, (SELECT COUNT(*) FROM clients) AS total_clients`),
      db.query(`SELECT COUNT(*) AS ytd_leads, COUNT(*) FILTER (WHERE status='Won') AS ytd_won FROM leads WHERE created_at >= $1`, [yearStart]),
      db.query(`SELECT brand, COALESCE(SUM(total_revenue),0) AS revenue FROM clients GROUP BY brand`),
      db.query(`SELECT COUNT(*) AS count FROM leads WHERE status NOT IN ('Won','Lost') AND is_archived=false AND COALESCE(last_contacted_at,created_at) < $1`, [coldThreshold]),
    ])

    const kpi = kpiRes.rows[0]
    const ytd = ytdRes.rows[0]
    const total = Number(ytd.ytd_leads)
    const won = Number(ytd.ytd_won)
    const convRate = total > 0 ? Math.round((won / total) * 100) : 0
    const now = new Date()
    const month = now.toLocaleString('en-US', { month: 'long', year: 'numeric' })
    const freqLabel = frequency.charAt(0).toUpperCase() + frequency.slice(1)

    const brandRows = brandRes.rows.map(b =>
      `<tr><td style="padding:6px 12px;border-bottom:1px solid #f3f4f6">${b.brand}</td><td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;font-weight:600;color:#06babe">$${Number(b.revenue).toLocaleString()}</td></tr>`
    ).join('')

    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,sans-serif">
<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#06babe,#207290);padding:24px 32px">
    <p style="color:rgba(255,255,255,0.8);font-size:12px;margin:0 0 4px">${freqLabel} Report — Aim Dental Laboratory</p>
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">${month} Summary</h1>
  </div>
  <div style="display:flex;padding:20px 32px;background:#f9fafb;border-bottom:1px solid #f3f4f6">
    ${[['Active Leads',kpi.active_leads,'#06babe'],['Total Clients',kpi.total_clients,'#207290'],['YTD Revenue',`$${Number(kpi.total_revenue).toLocaleString()}`,'#16a34a'],['Conversion',`${convRate}%`,convRate>=50?'#16a34a':'#f59e0b']].map(([l,v,c])=>`<div style="flex:1;text-align:center"><p style="margin:0;font-size:20px;font-weight:700;color:${c}">${v}</p><p style="margin:4px 0 0;font-size:10px;color:#9ca3af;text-transform:uppercase">${l}</p></div>`).join('')}
  </div>
  <div style="padding:24px 32px">
    <h2 style="font-size:14px;color:#111;margin:0 0 12px;padding-bottom:6px;border-bottom:2px solid #06babe">Revenue by Brand</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px"><tbody>${brandRows}</tbody></table>
    <div style="background:#fff8f0;border:1px solid #fed7aa;border-radius:10px;padding:14px 18px">
      <p style="margin:0;font-size:13px;color:#92400e">⚠ <strong>${Number(coldRes.rows[0].count)} cold lead${Number(coldRes.rows[0].count)!==1?'s':''}</strong> need follow-up · <strong>${total} leads</strong> YTD · <strong>${won} won</strong></p>
    </div>
  </div>
  <div style="padding:0 32px 24px"><a href="${process.env.FRONTEND_URL||'#'}/dashboard" style="display:inline-block;background:#06babe;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">Open Dashboard →</a></div>
  <div style="background:#f9fafb;padding:14px 32px;font-size:11px;color:#9ca3af;border-top:1px solid #f3f4f6">Aim Dental CRM · ${freqLabel} automated report</div>
</div></body></html>`

    for (const schedule of rows) {
      for (const recipient of schedule.recipients) {
        await sendEmail({ to: recipient, subject: `Aim Dental CRM — ${freqLabel} Report — ${month}`, html }).catch(console.error)
      }
      await db.query('UPDATE report_schedules SET last_sent_at=NOW() WHERE id=$1', [schedule.id]).catch(() => {})
      console.log(`[scheduler] Sent ${frequency} report: ${schedule.name} → ${schedule.recipients.join(', ')}`)
    }
  } catch (err) {
    console.error('[scheduler] Report send error:', err.message)
  }
}

async function carryOverTodos() {
  try {
    const currentWeek = getMondayDate()
    const nextMonday = new Date(currentWeek + 'T00:00:00Z')
    nextMonday.setUTCDate(nextMonday.getUTCDate() + 7)
    const nextWeek = nextMonday.toISOString().split('T')[0]

    // Archive completed, carry over incomplete
    await db.query(
      `UPDATE weekly_todos SET archived=true WHERE week_start=$1 AND completed=true`,
      [currentWeek]
    )

    const { rows: incomplete } = await db.query(
      `SELECT * FROM weekly_todos WHERE week_start=$1 AND completed=false AND archived=false`,
      [currentWeek]
    )

    for (const todo of incomplete) {
      await db.query(`
        INSERT INTO weekly_todos (owner_id, created_by, description, due_date, rock_id, week_start, carried_over)
        VALUES ($1,$2,$3,$4,$5,$6,true)
        ON CONFLICT DO NOTHING
      `, [todo.owner_id, todo.owner_id, todo.description,
          new Date(nextWeek + 'T00:00:00Z').toISOString().split('T')[0],
          todo.rock_id, nextWeek])
      await db.query('UPDATE weekly_todos SET archived=true WHERE id=$1', [todo.id])
    }

    // Send wrap-up emails
    const { rows: users } = await db.query("SELECT id, name, email FROM users WHERE role='staff'")
    for (const user of users) {
      const { rows: summary } = await db.query(`
        SELECT
          COUNT(*) FILTER (WHERE completed=true) AS done,
          COUNT(*) AS total
        FROM weekly_todos
        WHERE owner_id=$1 AND week_start=$2
      `, [user.id, currentWeek])
      const { done, total } = summary[0]
      const carried = incomplete.filter(t => t.owner_id === user.id).length

      const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,sans-serif">
<div style="max-width:540px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#06babe,#207290);padding:24px 32px">
    <p style="color:rgba(255,255,255,0.8);font-size:12px;margin:0 0 4px">Aim Dental CRM — EOS</p>
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">Weekly Wrap-Up</h1>
  </div>
  <div style="padding:28px 32px">
    <p style="font-size:16px;color:#111;margin:0 0 16px">Good work this week, ${user.name?.split(' ')[0] || 'there'}!</p>
    <div style="display:flex;gap:16px;margin-bottom:20px">
      <div style="flex:1;text-align:center;background:#f0fdf4;border-radius:12px;padding:16px">
        <p style="margin:0;font-size:28px;font-weight:700;color:#16a34a">${done}</p>
        <p style="margin:4px 0 0;font-size:12px;color:#6b7280">Completed</p>
      </div>
      <div style="flex:1;text-align:center;background:#fff8f0;border-radius:12px;padding:16px">
        <p style="margin:0;font-size:28px;font-weight:700;color:#d97706">${carried}</p>
        <p style="margin:4px 0 0;font-size:12px;color:#6b7280">Carried over</p>
      </div>
    </div>
    ${carried > 0 ? `<p style="font-size:13px;color:#6b7280;margin:0 0 20px">${carried} to-do${carried !== 1 ? 's' : ''} moved to next week.</p>` : '<p style="font-size:13px;color:#16a34a;margin:0 0 20px;font-weight:600">All to-dos complete — great week!</p>'}
    <a href="${process.env.FRONTEND_URL||''}/eos" style="display:inline-block;background:#06babe;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">View Next Week's To-Dos →</a>
  </div>
  <div style="background:#f9fafb;padding:14px 32px;font-size:11px;color:#9ca3af;border-top:1px solid #f3f4f6">Aim Dental CRM · EOS System</div>
</div></body></html>`

      await sendEmail({
        to: user.email,
        subject: `Weekly Wrap-Up — ${done}/${total} To-Dos complete`,
        html,
      }).catch(console.error)
    }

    console.log(`[cron] EOS carry-over complete: ${incomplete.length} todos moved to ${nextWeek}`)
  } catch (err) {
    console.error('[cron] EOS carry-over error:', err.message)
  }
}

async function sendTodoReminders() {
  try {
    const weekStart = getMondayDate()
    const { rows: users } = await db.query("SELECT id, name, email FROM users WHERE role='staff'")

    for (const user of users) {
      const { rows: todos } = await db.query(
        `SELECT description, carried_over FROM weekly_todos WHERE owner_id=$1 AND week_start=$2 AND archived=false ORDER BY carried_over DESC, created_at ASC`,
        [user.id, weekStart]
      )
      if (todos.length === 0) continue

      const todoRows = todos.map(t =>
        `<li style="padding:6px 0;font-size:14px;color:#374151">${t.carried_over ? '↩ ' : ''}${t.description}</li>`
      ).join('')

      const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,sans-serif">
<div style="max-width:540px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#06babe,#207290);padding:24px 32px">
    <p style="color:rgba(255,255,255,0.8);font-size:12px;margin:0 0 4px">Aim Dental CRM — EOS</p>
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">Your To-Dos This Week</h1>
  </div>
  <div style="padding:28px 32px">
    <p style="font-size:15px;color:#111;margin:0 0 16px">Good morning, ${user.name?.split(' ')[0] || 'there'}! Here's your list for the week:</p>
    <ul style="margin:0;padding:0 0 0 20px;border-left:3px solid #06babe">${todoRows}</ul>
    <div style="margin-top:24px">
      <a href="${process.env.FRONTEND_URL||''}/eos" style="display:inline-block;background:#06babe;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">Open EOS →</a>
    </div>
  </div>
  <div style="background:#f9fafb;padding:14px 32px;font-size:11px;color:#9ca3af;border-top:1px solid #f3f4f6">Aim Dental CRM · EOS System</div>
</div></body></html>`

      await sendEmail({
        to: user.email,
        subject: `Your ${todos.length} To-Do${todos.length !== 1 ? 's' : ''} This Week`,
        html,
      }).catch(console.error)
    }

    console.log('[cron] EOS Monday To-Do reminders sent')
  } catch (err) {
    console.error('[cron] EOS To-Do reminders error:', err.message)
  }
}

function startScheduler() {
  // Daily at 8:00 AM — cold leads + case due reminders + daily reports
  cron.schedule('0 8 * * *', async () => {
    console.log('[cron] Running cold_lead check')
    await runAutomationLogic('cold_lead').catch(console.error)
    console.log('[cron] Running case_due check')
    await runAutomationLogic('case_due').catch(console.error)
    await sendScheduledReports('daily')
  })

  // Every Monday at 9:00 AM — lost recovery + win streak + weekly reports + EOS To-Do reminders
  cron.schedule('0 9 * * 1', async () => {
    console.log('[cron] Running lost_recovery check')
    await runAutomationLogic('lost_recovery').catch(console.error)
    console.log('[cron] Running win_streak check')
    await runAutomationLogic('win_streak').catch(console.error)
    await sendScheduledReports('weekly')
    await sendTodoReminders().catch(console.error)
  })

  // Every Friday at 5:00 PM — EOS To-Do carry-over + weekly wrap-up emails
  cron.schedule('0 17 * * 5', async () => {
    console.log('[cron] Running EOS Friday todo carry-over')
    await carryOverTodos().catch(console.error)
  })

  // 1st of every month at 8:00 AM — monthly reports
  cron.schedule('0 8 1 * *', async () => {
    await sendScheduledReports('monthly')
  })

  console.log('[scheduler] Cron jobs registered')
}

module.exports = { startScheduler }
