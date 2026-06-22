const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')
const { sendEmail } = require('../services/email')

const router = express.Router()

// GET /api/rocks
router.get('/', auth, async (req, res, next) => {
  try {
    let where = ''
    const params = []
    if (req.user.role === 'staff') {
      params.push(req.user.id)
      where = `WHERE r.rock_type = 'company' OR r.owner_id = $${params.length}`
    }

    const { rows } = await db.query(`
      SELECT r.*, u.name AS owner_name, cb.name AS created_by_name,
        COALESCE(json_agg(
          json_build_object(
            'id', rm.id,
            'description', rm.description,
            'due_date', rm.due_date,
            'completed', rm.completed,
            'completed_at', rm.completed_at,
            'sort_order', rm.sort_order
          ) ORDER BY rm.sort_order, rm.created_at
        ) FILTER (WHERE rm.id IS NOT NULL), '[]') AS milestones
      FROM rocks r
      LEFT JOIN users u ON u.id = r.owner_id
      LEFT JOIN users cb ON cb.id = r.created_by
      LEFT JOIN rock_milestones rm ON rm.rock_id = r.id
      ${where}
      GROUP BY r.id, u.name, cb.name
      ORDER BY
        CASE r.rock_type WHEN 'company' THEN 0 WHEN 'individual' THEN 1 ELSE 2 END,
        r.created_at DESC
    `, params)

    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/rocks
router.post('/', auth, async (req, res, next) => {
  try {
    const { title, description, rock_type, owner_id, quarter, due_date } = req.body
    if (!title?.trim() || !quarter?.trim()) {
      return res.status(400).json({ error: 'Title and quarter are required' })
    }

    if (req.user.role === 'staff' && rock_type && rock_type !== 'personal') {
      return res.status(403).json({ error: 'Staff can only create personal rocks' })
    }

    const effectiveType = req.user.role === 'staff' ? 'personal' : (rock_type || 'company')
    const effectiveOwner = effectiveType === 'company'
      ? null
      : effectiveType === 'personal'
        ? req.user.id
        : (owner_id || req.user.id)

    const { rows } = await db.query(`
      INSERT INTO rocks (title, description, rock_type, owner_id, quarter, due_date, status, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, 'On Track', $7)
      RETURNING *
    `, [title.trim(), description || null, effectiveType, effectiveOwner, quarter.trim(), due_date || null, req.user.id])

    const rock = rows[0]

    // Notify assigned rep for individual rocks
    if (effectiveType === 'individual' && effectiveOwner && effectiveOwner !== req.user.id) {
      const { rows: [rep] } = await db.query(
        'SELECT name, email FROM users WHERE id=$1', [effectiveOwner]
      )
      if (rep) {
        await db.query(
          `INSERT INTO alerts (type, title, message, metadata) VALUES ($1,$2,$3,$4)`,
          ['eos_rock', 'New Rock Assigned',
            `${req.user.name || 'Admin'} assigned you a Rock: "${title.trim()}" for ${quarter}`,
            JSON.stringify({ rock_id: rock.id })]
        ).catch(console.error)

        const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,sans-serif">
<div style="max-width:540px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#06babe,#207290);padding:24px 32px">
    <p style="color:rgba(255,255,255,0.8);font-size:12px;margin:0 0 4px">Aim Dental CRM — EOS</p>
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">New Rock for ${quarter}</h1>
  </div>
  <div style="padding:28px 32px">
    <h2 style="font-size:18px;color:#111;margin:0 0 8px">${title.trim()}</h2>
    ${description ? `<p style="color:#6b7280;font-size:14px;margin:0 0 20px">${description}</p>` : ''}
    ${due_date ? `<p style="font-size:13px;color:#6b7280;margin:0 0 20px">Due by <strong>${new Date(due_date).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</strong></p>` : ''}
    <a href="${process.env.FRONTEND_URL||''}/eos" style="display:inline-block;background:#06babe;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">View Rock →</a>
  </div>
  <div style="background:#f9fafb;padding:14px 32px;font-size:11px;color:#9ca3af;border-top:1px solid #f3f4f6">Aim Dental CRM · EOS System</div>
</div></body></html>`
        await sendEmail({ to: rep.email, subject: `New Rock Assigned — ${title.trim()}`, html }).catch(console.error)
      }
    }

    res.status(201).json({ ...rock, milestones: [] })
  } catch (err) { next(err) }
})

// PUT /api/rocks/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const { title, description, status, due_date, quarter } = req.body

    const { rows: [existing] } = await db.query('SELECT * FROM rocks WHERE id=$1', [req.params.id])
    if (!existing) return res.status(404).json({ error: 'Rock not found' })

    const canEdit = req.user.role === 'admin' || existing.owner_id === req.user.id
    if (!canEdit) return res.status(403).json({ error: 'Not authorized' })

    const { rows } = await db.query(`
      UPDATE rocks SET
        title       = COALESCE($1, title),
        description = COALESCE($2, description),
        status      = COALESCE($3, status),
        due_date    = COALESCE($4, due_date),
        quarter     = COALESCE($5, quarter),
        updated_at  = NOW()
      WHERE id = $6
      RETURNING *
    `, [title || null, description || null, status || null, due_date || null, quarter || null, req.params.id])

    // Alert admins when rock goes off track
    if (status === 'Off Track' && existing.status !== 'Off Track') {
      const ownerName = existing.owner_id
        ? (await db.query('SELECT name FROM users WHERE id=$1', [existing.owner_id]).catch(() => ({ rows: [{}] }))).rows[0]?.name
        : null
      await db.query(
        `INSERT INTO alerts (type, title, message, metadata) VALUES ($1,$2,$3,$4)`,
        ['eos_rock', 'Rock Off Track',
          `${ownerName || 'A rep'}'s Rock "${existing.title}" is now Off Track.`,
          JSON.stringify({ rock_id: existing.id })]
      ).catch(console.error)
    }

    // Celebrate completion
    if (status === 'Done' && existing.status !== 'Done') {
      await db.query(
        `INSERT INTO alerts (type, title, message, metadata) VALUES ($1,$2,$3,$4)`,
        ['eos_rock', 'Rock Completed!',
          `Rock "${existing.title}" has been marked as Done.`,
          JSON.stringify({ rock_id: existing.id })]
      ).catch(console.error)
    }

    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/rocks/:id — admin only
router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM rocks WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

// ── Milestones ─────────────────────────────────────────────────────────────────

// POST /api/rocks/:id/milestones
router.post('/:id/milestones', auth, async (req, res, next) => {
  try {
    const { description, due_date, sort_order } = req.body
    if (!description?.trim()) return res.status(400).json({ error: 'Description required' })

    const { rows: [rock] } = await db.query('SELECT * FROM rocks WHERE id=$1', [req.params.id])
    if (!rock) return res.status(404).json({ error: 'Rock not found' })
    const canEdit = req.user.role === 'admin' || rock.owner_id === req.user.id
    if (!canEdit) return res.status(403).json({ error: 'Not authorized' })

    const { rows } = await db.query(`
      INSERT INTO rock_milestones (rock_id, description, due_date, sort_order)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [req.params.id, description.trim(), due_date || null, sort_order || 0])

    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PUT /api/rocks/:rockId/milestones/:id
router.put('/:rockId/milestones/:id', auth, async (req, res, next) => {
  try {
    const { completed, description, due_date } = req.body

    const { rows: [rock] } = await db.query('SELECT * FROM rocks WHERE id=$1', [req.params.rockId])
    if (!rock) return res.status(404).json({ error: 'Rock not found' })
    const canEdit = req.user.role === 'admin' || rock.owner_id === req.user.id
    if (!canEdit) return res.status(403).json({ error: 'Not authorized' })

    const { rows } = await db.query(`
      UPDATE rock_milestones SET
        completed    = CASE WHEN $1::boolean IS NOT NULL THEN $1 ELSE completed END,
        completed_at = CASE WHEN $1 = true THEN NOW() WHEN $1 = false THEN NULL ELSE completed_at END,
        completed_by = CASE WHEN $1 = true THEN $2::uuid WHEN $1 = false THEN NULL ELSE completed_by END,
        description  = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE description END,
        due_date     = CASE WHEN $4::date IS NOT NULL THEN $4 ELSE due_date END
      WHERE id = $5 AND rock_id = $6
      RETURNING *
    `, [
      completed !== undefined ? completed : null,
      req.user.id,
      description !== undefined ? description : null,
      due_date !== undefined ? (due_date || null) : null,
      req.params.id,
      req.params.rockId,
    ])

    if (!rows[0]) return res.status(404).json({ error: 'Milestone not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/rocks/:rockId/milestones/:id
router.delete('/:rockId/milestones/:id', auth, async (req, res, next) => {
  try {
    const { rows: [rock] } = await db.query('SELECT * FROM rocks WHERE id=$1', [req.params.rockId])
    if (!rock) return res.status(404).json({ error: 'Rock not found' })
    const canEdit = req.user.role === 'admin' || rock.owner_id === req.user.id
    if (!canEdit) return res.status(403).json({ error: 'Not authorized' })
    await db.query('DELETE FROM rock_milestones WHERE id=$1 AND rock_id=$2', [req.params.id, req.params.rockId])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
