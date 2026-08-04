require('dotenv').config()
const app = require('./app')
const { startScheduler } = require('./jobs/scheduler')
const { startMediaCleanupScheduler } = require('./jobs/mediaCleanup')

// Mounted here rather than in app.js — that file has real in-progress
// unrelated work (an EOS→goals refactor) and must not be touched.
// Express allows registering more routes on an already-built `app`
// right up until it starts listening, and this path doesn't collide
// with anything app.js already registers, so order doesn't matter here.
app.use('/api', require('./routes/contentPosts'))

const PORT = process.env.PORT || 4000

app.listen(PORT, () => {
  console.log(`Aim Dental CRM backend running on port ${PORT}`)
  startScheduler()
  startMediaCleanupScheduler()
})
