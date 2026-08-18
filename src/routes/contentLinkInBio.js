const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

function mapPage(row) {
  return { handle: row.handle, bioLine: row.bio_line, links: row.links, pageViews30d: row.page_views_30d }
}

// GET /api/content-link-in-bio/:brand
router.get('/content-link-in-bio/:brand', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('select * from content_link_in_bio where lab = $1', [req.params.brand])
    if (rows.length === 0) return res.status(404).json({ error: 'No link-in-bio page for this brand' })
    res.json({ page: mapPage(rows[0]) })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/content-link-in-bio/:brand — shallow merge, same contract as
// content-settings (whichever top-level keys are present get overwritten).
router.patch('/content-link-in-bio/:brand', auth, async (req, res, next) => {
  try {
    const updates = req.body || {}
    const setClauses = []
    const values = []
    let i = 1
    if ('handle' in updates) { setClauses.push(`handle = $${i}`); values.push(updates.handle); i++ }
    if ('bioLine' in updates) { setClauses.push(`bio_line = $${i}`); values.push(updates.bioLine); i++ }
    if ('links' in updates) { setClauses.push(`links = $${i}::jsonb`); values.push(JSON.stringify(updates.links)); i++ }
    if (setClauses.length === 0) return res.status(400).json({ error: 'No updatable fields provided' })

    values.push(req.params.brand)
    const { rows } = await db.query(
      `update content_link_in_bio set ${setClauses.join(', ')} where lab = $${i} returning *`,
      values
    )
    if (rows.length === 0) return res.status(404).json({ error: 'No link-in-bio page for this brand' })
    res.json({ page: mapPage(rows[0]) })
  } catch (err) {
    next(err)
  }
})

module.exports = router
