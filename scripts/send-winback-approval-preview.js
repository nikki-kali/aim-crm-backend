// Sends the Dormant Accounts Re-engagement approval email as a preview to
// media@aimdentallab.com, with an "Approve & Send" link. Nothing goes to
// leadership until that link is confirmed. Run: node scripts/send-winback-approval-preview.js
require('dotenv').config({ quiet: true })
const { sendWinbackApprovalPreview } = require('../src/services/winbackApproval')
sendWinbackApprovalPreview()
  .then(() => { console.log('Preview sent to media@aimdentallab.com'); process.exit(0) })
  .catch((e) => { console.error(e.message); process.exit(1) })
