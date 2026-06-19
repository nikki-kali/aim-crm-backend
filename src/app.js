const express = require('express')
const cors = require('cors')
const errorHandler = require('./middleware/errorHandler')

const authRoutes = require('./routes/auth')
const leadRoutes = require('./routes/leads')
const clientRoutes = require('./routes/clients')
const caseRoutes = require('./routes/cases')
const alertRoutes = require('./routes/alerts')
const automationRoutes = require('./routes/automations')
const reportRoutes = require('./routes/reports')
const intakeRoutes = require('./routes/intake')
const userRoutes = require('./routes/users')
const clinicRoutes = require('./routes/clinics')
const activityRoutes = require('./routes/activities')
const taskRoutes = require('./routes/tasks')
const emailTemplateRoutes = require('./routes/emailTemplates')

const app = express()

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}))
app.use(express.json())

app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.use('/api/auth',            authRoutes)
app.use('/api/dashboard',       reportRoutes)
app.use('/api/leads',           intakeRoutes)   // public capture — before auth-gated leads
app.use('/api/leads',           leadRoutes)
app.use('/api/clients',         clientRoutes)
app.use('/api/cases',           caseRoutes)
app.use('/api/clinics',         clinicRoutes)
app.use('/api/activities',      activityRoutes)
app.use('/api/tasks',           taskRoutes)
app.use('/api/email-templates', emailTemplateRoutes)
app.use('/api/alerts',          alertRoutes)
app.use('/api/automations',     automationRoutes)
app.use('/api/reports',         reportRoutes)
app.use('/api/users',           userRoutes)

app.use(errorHandler)

module.exports = app
