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
const webLeadRoutes = require('./routes/webLeads')
const userRoutes = require('./routes/users')
const clinicRoutes = require('./routes/clinics')
const activityRoutes = require('./routes/activities')
const taskRoutes = require('./routes/tasks')
const emailTemplateRoutes = require('./routes/emailTemplates')
const reportScheduleRoutes = require('./routes/reportSchedules')
const { router: weeklyTodoRoutes } = require('./routes/weeklyTodos')
const rockRoutes = require('./routes/rocks')
const issueRoutes = require('./routes/issues')
const weeklyFocusRoutes = require('./routes/weeklyFocus')
const eosSuggestionsRoutes = require('./routes/eosSuggestions')
const feedbackRoutes = require('./routes/feedback')

const app = express()

// Render sits behind a reverse proxy; without this, req.ip returns the
// proxy's address for every request, which would break the web-leads
// rate limiter (every client would look like the same IP).
app.set('trust proxy', 1)

// Mounted before the global CORS policy below, and fully self-contained
// (own cors() + express.json() inside webLeads.js). cors() answers OPTIONS
// preflight requests by ending the response directly rather than calling
// next(), so if this were mounted after the global cors() below, that
// restrictive policy (CRM-frontend-only) would answer every preflight for
// this path first and this route's own permissive cors() would never run —
// silently breaking it for any browser origin other than the CRM frontend.
app.use('/api/web-leads', webLeadRoutes) // public — marketing website Contact/Scanner forms

// FRONTEND_URL supports a comma-separated list so both the stable Vercel
// domain and a custom domain can be allowed at once (e.g. while DNS for a
// custom domain is still being set up).
const allowedOrigins = (process.env.FRONTEND_URL || '*').split(',').map((o) => o.trim())
app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  credentials: true,
}))
app.use(express.json({ limit: '5mb' }))

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
app.use('/api/users',            userRoutes)
app.use('/api/report-schedules', reportScheduleRoutes)
app.use('/api/rocks',        rockRoutes)
app.use('/api/todos',        weeklyTodoRoutes)
app.use('/api/issues',       issueRoutes)
app.use('/api/weekly-focus', weeklyFocusRoutes)
app.use('/api/eos',          eosSuggestionsRoutes)
app.use('/api/feedback',     feedbackRoutes)

app.use(errorHandler)

module.exports = app
