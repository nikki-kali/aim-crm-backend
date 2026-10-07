// Partner meetings: who gets the requests, and the fixed Meet link.
// Ben's own Google Meet room (user-provided 2026-10-07); every confirmed
// meeting uses it. PARTNER_MEET_LINK overrides it without a code change.
const COMMON_ZONES = [
  ['America/New_York', 'Eastern Time (New York)'], ['America/Chicago', 'Central Time (Chicago)'],
  ['America/Denver', 'Mountain Time (Denver)'], ['America/Phoenix', 'Arizona (Phoenix)'],
  ['America/Los_Angeles', 'Pacific Time (Los Angeles)'], ['America/Anchorage', 'Alaska (Anchorage)'],
  ['Pacific/Honolulu', 'Hawaii (Honolulu)'], ['America/Toronto', 'Toronto'],
  ['Europe/London', 'London'], ['Asia/Manila', 'Manila'],
]

module.exports = {
  COMMON_ZONES,
  PARTNER_MEETING_TO: ['ben@aimdentallab.com'],
  PARTNER_MEETING_CC: ['execassistant@aimdentallab.com'],
  PARTNER_MEETING_BCC: ['media@aimdentallab.com'],
  MEET_LINK: process.env.PARTNER_MEET_LINK || 'https://meet.google.com/spv-afjq-fbt',
  MEETING_MINUTES: 30,
  // Ben's own time zone, shown beside the partner's time in his emails.
  INTERNAL_TIME_ZONE: 'America/New_York',
}
