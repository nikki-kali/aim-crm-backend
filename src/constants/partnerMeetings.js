// Partner meetings: who gets the requests, and the fixed Meet link.
// Ben's own Google Meet room (user-provided 2026-10-07); every confirmed
// meeting uses it. PARTNER_MEET_LINK overrides it without a code change.
module.exports = {
  PARTNER_MEETING_TO: ['ben@aimdentallab.com'],
  PARTNER_MEETING_CC: ['execassistant@aimdentallab.com'],
  PARTNER_MEETING_BCC: ['media@aimdentallab.com'],
  MEET_LINK: process.env.PARTNER_MEET_LINK || 'https://meet.google.com/spv-afjq-fbt',
  MEETING_MINUTES: 30,
  // Ben's own time zone, shown beside the partner's time in his emails.
  INTERNAL_TIME_ZONE: 'America/New_York',
}
