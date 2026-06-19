require('dotenv').config()
const app = require('./app')
const { startScheduler } = require('./jobs/scheduler')

const PORT = process.env.PORT || 4000

app.listen(PORT, () => {
  console.log(`Aim Dental CRM backend running on port ${PORT}`)
  startScheduler()
})
