# Office Visit Bookings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let dental practices request an in-person office visit from their AIM Dental sales rep via a public web form, and let reps schedule office visits themselves from the CRM — both ending in a confirmed date/time and, where possible, a confirmation email to the practice.

**Architecture:** Two new Postgres tables (`office_visit_bookings`, `office_visit_tokens`) plus a small `rep_territories` lookup. A public, self-contained-CORS route (`officeVisits.js`, mounted in `app.js` before the global CORS policy, same pattern as `webLeads.js`) handles the public request form and the GET-safe/POST-consume token confirmation flow. A separate auth-gated route (`officeVisitsAdmin.js`, mounted after the global CORS policy like every other authenticated route) handles rep-initiated scheduling, listing, and rescheduling. The Frontend adds one new tab to the existing Scheduler subnav that calls this CRM's own backend, not the external `booking-platform` service the other Scheduler tabs use.

**Tech Stack:** Node/Express, raw `pg` SQL (no ORM), `node:test`, React/Vite.

**Spec:** `Backend/docs/superpowers/specs/2026-10-01-office-visit-bookings-design.md`

## Global Constraints

- Backend (`/Users/nklimjoco/Downloads/aim-crm/Backend`) and Frontend (`/Users/nklimjoco/Downloads/aim-crm/Frontend`) are two **independent git repositories** with no root-level git — commit to each separately; neither repo's git history reaches the other.
- No ORM, no migration runner — SQL migrations are hand-applied in the Supabase SQL editor per this repo's convention. This plan's migration file must be created and the task must tell the human to apply it by hand before the tasks that query the new tables can be tested against a real database.
- Service category list is fixed, exact strings, already approved — do not alter: `"Crowns & Bridges"`, `"Removable Partials & Dentures"`, `"Digital Scanning & Models"`, `"Whitening & Cosmetic"`, `"Implant Restorations"`, `"General / Not Sure Yet"`.
- Territory seed data is real, already decided: James Delaney → `region_name: 'NYC'`, `state_codes: {'NY'}`; William Alexander → `region_name: 'West Coast'`, `state_codes: {'CA'}`.
- The click-to-call button for a practice's phone number belongs **only** on the rep-facing GET confirmation page (before they send "suggest another time"), **never** in the email sent to the practice — the practice already has its own number.
- The new Frontend tab calls this CRM's own backend (`VITE_API_URL` via `src/lib/api.js`), **not** `schedulerApi.js`/`VITE_SCHEDULER_API_URL` — this is deliberate, not an oversight to "fix" later.
- `webLeads.js`'s real brand handling is a **posted `brand` field** validated against `['Aim Dental', 'Kings Highway']`, defaulting to `'Aim Dental'` — match this, not CLAUDE.md's stale claim about Origin/Referer inference.

## Review Focus

- A practice submits with a state that has no `rep_territories` match (e.g. `TX`) — must fall back to `media@aimdentallab.com`, never crash or silently drop the booking.
- A rep double-clicks "Approve" (or an email client prefetches the GET link twice) — the second attempt must not re-send the confirmation email or change already-confirmed data.
- A booking's `contact_name`/`practice_name`/`message` contains `<script>` or other HTML — must render escaped in every email and in the Frontend list, never executed.
- An expired or already-used token hits `GET /confirm` or `POST /confirm` — must show a clear expired message, never throw a raw 500 or silently no-op.
- A rep-scheduled booking (Way 2) is created with no `email` — must save successfully and simply skip sending any confirmation, never error out because an email couldn't be sent.

---

## File Structure

- `Backend/scripts/v26-office-visit-bookings-migration.sql` — new tables + seed.
- `Backend/src/constants/officeVisitCategories.js` — shared service-category list (new small file; Backend has no `src/constants/` dir yet, create it — this is the kind of small fixed-list constant this codebase keeps in a dedicated file when more than one route/service needs it).
- `Backend/src/services/repTerritories.js` — territory lookup (`matchRepByState`).
- `Backend/src/services/officeVisitTokens.js` — token create/peek/consume (mirrors `reportApproval.js`'s token functions, kept separate since it references bookings, not reports).
- `Backend/src/services/officeVisitEmails.js` — all email HTML builders for this feature (rep notification, rep confirm-page-with-click-to-call, practice confirmation, practice "pending" email).
- `Backend/src/routes/officeVisits.js` — public: `POST /request`, `GET /confirm`, `POST /confirm`.
- `Backend/src/routes/officeVisitsAdmin.js` — auth-gated: `GET /`, `POST /`, `PUT /:id/reschedule`.
- `Backend/src/app.js` — mount both routers.
- `Backend/test/officeVisits/*.test.js` — territory matching, token lifecycle, status transitions, email content, XSS escaping.
- `Backend/package.json` — add the new test files to the `test` script.
- `Frontend/src/lib/officeVisitCategories.js` — same fixed list, Frontend copy.
- `Frontend/src/pages/scheduler/OfficeVisits.jsx` — new page.
- `Frontend/src/components/Layout.jsx` — add nav tab.
- `Frontend/src/App.jsx` — add route.

---

### Task 1: Migration and territory lookup

**Files:**
- Create: `Backend/scripts/v26-office-visit-bookings-migration.sql`
- Create: `Backend/src/services/repTerritories.js`
- Test: `Backend/test/officeVisits/repTerritories.test.js`

**Interfaces:**
- Produces: `matchRepByState(state)` — `async (state: string|null) => Promise<{ id, name, email } | null>`, queries `rep_territories` joined to `users`, returns the first rep whose `state_codes` array contains `state` (case-insensitive), or `null` if no match or `state` is falsy.

- [ ] **Step 1: Write the migration SQL**

```sql
-- v26-office-visit-bookings-migration.sql
-- Office Visit Bookings: two-way scheduling between sales reps and
-- dental practices. See docs/superpowers/specs/2026-10-01-office-visit-bookings-design.md.

CREATE TABLE rep_territories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id uuid NOT NULL REFERENCES users(id),
  region_name text NOT NULL,
  state_codes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE office_visit_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('public_form', 'rep_scheduled')),
  practice_name text,
  contact_name text NOT NULL,
  contact_role text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  email text,
  phone text NOT NULL,
  message text,
  service_interests text[],
  requested_date date,
  requested_time time,
  confirmed_date date,
  confirmed_time time,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'time_suggested', 'declined')),
  assigned_rep_id uuid REFERENCES users(id),
  rep_notes text,
  brand text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_office_visit_bookings_status ON office_visit_bookings(status);
CREATE INDEX idx_office_visit_bookings_assigned_rep ON office_visit_bookings(assigned_rep_id);

CREATE TABLE office_visit_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text UNIQUE NOT NULL,
  booking_id uuid NOT NULL REFERENCES office_visit_bookings(id),
  action text NOT NULL CHECK (action IN ('approve', 'suggest_time')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_office_visit_tokens_token ON office_visit_tokens(token);

-- Real territory seed (user-confirmed, 2026-10-01): James covers NYC
-- (New York), William covers the West Coast (California).
INSERT INTO rep_territories (rep_id, region_name, state_codes)
SELECT id, 'NYC', ARRAY['NY'] FROM users WHERE email = 'james@aimdentallab.com';

INSERT INTO rep_territories (rep_id, region_name, state_codes)
SELECT id, 'West Coast', ARRAY['CA'] FROM users WHERE email = 'williama@aimdentallab.com';
```

- [ ] **Step 2: Ask the human to apply the migration**

Tell the human: "Please apply `Backend/scripts/v26-office-visit-bookings-migration.sql` by hand in the Supabase SQL editor before continuing — this repo has no migration runner." Wait for confirmation before Step 3's test can pass against the real database.

- [ ] **Step 3: Write the failing test**

```javascript
// Backend/test/officeVisits/repTerritories.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { matchRepByState } = require('../../src/services/repTerritories')

test('matchRepByState finds James for NY', async () => {
  const rep = await matchRepByState('NY')
  assert.equal(rep.email, 'james@aimdentallab.com')
})

test('matchRepByState finds William for CA', async () => {
  const rep = await matchRepByState('CA')
  assert.equal(rep.email, 'williama@aimdentallab.com')
})

test('matchRepByState returns null for an unmatched state', async () => {
  const rep = await matchRepByState('TX')
  assert.equal(rep, null)
})

test('matchRepByState returns null for a falsy state', async () => {
  assert.equal(await matchRepByState(null), null)
  assert.equal(await matchRepByState(''), null)
})

test('matchRepByState is case-insensitive', async () => {
  const rep = await matchRepByState('ny')
  assert.equal(rep.email, 'james@aimdentallab.com')
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test test/officeVisits/repTerritories.test.js`
Expected: FAIL — `Cannot find module '../../src/services/repTerritories'`

- [ ] **Step 5: Write the implementation**

```javascript
// Backend/src/services/repTerritories.js
const db = require('../config/db')

// Looks up which rep covers a given US state via rep_territories.state_codes
// (a text[] column) — real territory data, not geocoding: James covers NY,
// William covers CA (user-confirmed, 2026-10-01). Returns null for no match
// (an unassigned booking) rather than guessing a default rep.
async function matchRepByState(state) {
  if (!state) return null
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email
     FROM rep_territories rt
     JOIN users u ON u.id = rt.rep_id
     WHERE $1 = ANY (SELECT UPPER(s) FROM unnest(rt.state_codes) AS s)
     LIMIT 1`,
    [state.toUpperCase()]
  )
  return rows[0] || null
}

module.exports = { matchRepByState }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/officeVisits/repTerritories.test.js`
Expected: PASS (5 tests), assuming Step 2's migration has been applied against the database this test connects to.

- [ ] **Step 7: Commit**

```bash
git add scripts/v26-office-visit-bookings-migration.sql src/services/repTerritories.js test/officeVisits/repTerritories.test.js
git commit -m "Add office_visit_bookings/tokens tables and rep territory matching"
```

---

### Task 2: Shared service-category constant

**Files:**
- Create: `Backend/src/constants/officeVisitCategories.js`
- Create: `Frontend/src/lib/officeVisitCategories.js`

**Interfaces:**
- Produces: `OFFICE_VISIT_CATEGORIES` — a frozen array of exactly the 6 approved strings, exported identically from both files (Backend validation, Frontend checkbox rendering — duplicated by design, matching this codebase's convention for small fixed lists like `MONTHLY_NEW_DOCTOR_TARGETS`).

- [ ] **Step 1: Create the Backend constant**

```javascript
// Backend/src/constants/officeVisitCategories.js
// Fixed, user-approved list (2026-10-01) shown as checkboxes on the public
// Office Visit request form and validated against here. Duplicated in
// Frontend/src/lib/officeVisitCategories.js rather than fetched from an
// API, matching this codebase's convention for small fixed lists (see
// salesRepDailyReport.js's MONTHLY_NEW_DOCTOR_TARGETS).
const OFFICE_VISIT_CATEGORIES = [
  'Crowns & Bridges',
  'Removable Partials & Dentures',
  'Digital Scanning & Models',
  'Whitening & Cosmetic',
  'Implant Restorations',
  'General / Not Sure Yet',
]

module.exports = { OFFICE_VISIT_CATEGORIES }
```

- [ ] **Step 2: Create the identical Frontend constant**

```javascript
// Frontend/src/lib/officeVisitCategories.js
// Fixed, user-approved list (2026-10-01) — kept identical to
// Backend/src/constants/officeVisitCategories.js by hand (small fixed
// list, not worth an API round trip to fetch).
export const OFFICE_VISIT_CATEGORIES = [
  'Crowns & Bridges',
  'Removable Partials & Dentures',
  'Digital Scanning & Models',
  'Whitening & Cosmetic',
  'Implant Restorations',
  'General / Not Sure Yet',
]
```

- [ ] **Step 3: Commit (both repos)**

```bash
cd Backend && git add src/constants/officeVisitCategories.js && git commit -m "Add shared Office Visit service-category list (Backend)"
cd ../Frontend && git add src/lib/officeVisitCategories.js && git commit -m "Add shared Office Visit service-category list (Frontend)"
```

---

### Task 3: Token service

**Files:**
- Create: `Backend/src/services/officeVisitTokens.js`
- Test: `Backend/test/officeVisits/officeVisitTokens.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks besides the `office_visit_tokens` table from Task 1.
- Produces:
  - `createToken({ bookingId, action })` — `async ({bookingId: string, action: 'approve'|'suggest_time'}) => Promise<string>` (the raw token).
  - `peekToken(token)` — `async (string) => Promise<{booking_id, action} | null>`, read-only, does NOT mark used.
  - `consumeToken(token)` — `async (string) => Promise<{booking_id, action} | null>`, atomically claims it (single-use).

- [ ] **Step 1: Write the failing test**

```javascript
// Backend/test/officeVisits/officeVisitTokens.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const db = require('../../src/config/db')
const { createToken, peekToken, consumeToken } = require('../../src/services/officeVisitTokens')

async function makeTestBooking() {
  const { rows } = await db.query(
    `INSERT INTO office_visit_bookings (source, contact_name, phone, status)
     VALUES ('public_form', 'Test Contact', '555-0100', 'pending') RETURNING id`
  )
  return rows[0].id
}

test('createToken + peekToken: a fresh token peeks without consuming it', async () => {
  const bookingId = await makeTestBooking()
  const token = await createToken({ bookingId, action: 'approve' })
  const peeked = await peekToken(token)
  assert.equal(peeked.booking_id, bookingId)
  assert.equal(peeked.action, 'approve')
  // Peeking again still works — peek never marks used.
  const peekedAgain = await peekToken(token)
  assert.equal(peekedAgain.booking_id, bookingId)
})

test('consumeToken claims a token exactly once', async () => {
  const bookingId = await makeTestBooking()
  const token = await createToken({ bookingId, action: 'suggest_time' })
  const first = await consumeToken(token)
  assert.equal(first.booking_id, bookingId)
  assert.equal(first.action, 'suggest_time')
  const second = await consumeToken(token)
  assert.equal(second, null, 'a second consume of the same token must fail')
})

test('peekToken and consumeToken return null for an unknown token', async () => {
  assert.equal(await peekToken('not-a-real-token'), null)
  assert.equal(await consumeToken('not-a-real-token'), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/officeVisits/officeVisitTokens.test.js`
Expected: FAIL — `Cannot find module '../../src/services/officeVisitTokens'`

- [ ] **Step 3: Write the implementation**

```javascript
// Backend/src/services/officeVisitTokens.js
const crypto = require('crypto')
const db = require('../config/db')

// Single-use, expiring action tokens for the two email-triggered Office
// Visit actions (approve / suggest another time). Modeled on
// reportApproval.js's createApprovalToken/peekApprovalToken/
// consumeApprovalToken but kept in its own table (office_visit_tokens)
// since it references a booking, not a report. 7-day TTL — longer than
// the 24h report-approval window, since a rep may not check this email as
// urgently as a leadership report.
const TOKEN_TTL_DAYS = 7

async function createToken({ bookingId, action }) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  await db.query(
    `INSERT INTO office_visit_tokens (token, booking_id, action, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [token, bookingId, action, expiresAt]
  )
  return token
}

// Read-only — does NOT mark the token used. Backs the GET /confirm
// confirmation page, which must be safe for an email client/provider's
// automated link pre-fetch (see officeVisits.js route comments and the
// project-wide reportApproval.js precedent this mirrors).
async function peekToken(token) {
  const { rows } = await db.query(
    `SELECT booking_id, action FROM office_visit_tokens
     WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [token]
  )
  return rows[0] || null
}

// Atomic claim: the UPDATE's WHERE clause (unused, unexpired) means a
// second attempt (double-click, or two tabs) matches zero rows and
// returns null rather than re-running the real action twice.
async function consumeToken(token) {
  const { rows } = await db.query(
    `UPDATE office_visit_tokens SET used_at = NOW()
     WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING booking_id, action`,
    [token]
  )
  return rows[0] || null
}

module.exports = { createToken, peekToken, consumeToken }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/officeVisits/officeVisitTokens.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/officeVisitTokens.js test/officeVisits/officeVisitTokens.test.js
git commit -m "Add single-use token service for Office Visit approve/suggest-time actions"
```

---

### Task 4: Email builders

**Files:**
- Create: `Backend/src/services/officeVisitEmails.js`
- Test: `Backend/test/officeVisits/officeVisitEmails.test.js`

**Interfaces:**
- Consumes: `OFFICE_VISIT_CATEGORIES` from Task 2 (for display only, not validation).
- Produces:
  - `repNotificationEmail({ booking, approveUrl, suggestTimeConfirmUrl })` → `{ subject, html }` — sent to the matched rep (or fallback) when a public-form request comes in.
  - `repSuggestTimeConfirmPage({ booking, confirmUrl })` → `html` string — the GET-safe confirmation page a rep sees before sending "suggest another time"; **includes the click-to-call button for the practice's phone**, per the spec correction.
  - `repApproveConfirmPage({ booking, confirmUrl })` → `html` string — the GET-safe confirmation page for the approve action.
  - `practiceConfirmationEmail({ booking, rep })` → `{ subject, html }` — sent to the practice once approved/rescheduled.
  - `practicePendingEmail({ booking, rep })` → `{ subject, html }` — sent to the practice when the rep suggests another time; **no click-to-call button**.

- [ ] **Step 1: Write the failing test**

```javascript
// Backend/test/officeVisits/officeVisitEmails.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  repNotificationEmail,
  repSuggestTimeConfirmPage,
  repApproveConfirmPage,
  practiceConfirmationEmail,
  practicePendingEmail,
} = require('../../src/services/officeVisitEmails')

const BOOKING = {
  id: 'b1', practice_name: 'Smile Dental', contact_name: 'Jane <script>alert(1)</script> Doe',
  contact_role: 'Office Manager', address_line1: '123 Main St', city: 'Brooklyn', state: 'NY', zip: '11201',
  email: 'jane@smiledental.com', phone: '555-0100', message: 'Looking forward to it',
  service_interests: ['Crowns & Bridges', 'Implant Restorations'],
  requested_date: '2026-10-15', requested_time: '14:00:00',
}
const REP = { name: 'James Delaney', phone: '555-0199', email: 'james@aimdentallab.com' }

test('repNotificationEmail HTML-escapes the contact name (XSS)', () => {
  const { html } = repNotificationEmail({ booking: BOOKING, approveUrl: 'https://x/a', suggestTimeConfirmUrl: 'https://x/s' })
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('repNotificationEmail includes both action links and the service interests', () => {
  const { html } = repNotificationEmail({ booking: BOOKING, approveUrl: 'https://x/approve', suggestTimeConfirmUrl: 'https://x/suggest' })
  assert.match(html, /https:\/\/x\/approve/)
  assert.match(html, /https:\/\/x\/suggest/)
  assert.match(html, /Crowns &amp; Bridges/)
  assert.match(html, /Implant Restorations/)
})

test('repSuggestTimeConfirmPage includes a tel: click-to-call button for the practice phone', () => {
  const html = repSuggestTimeConfirmPage({ booking: BOOKING, confirmUrl: 'https://x/confirm' })
  assert.match(html, /tel:555-0100/)
})

test('repApproveConfirmPage does not need a click-to-call button (it is a real confirm action, not a reach-out prompt)', () => {
  const html = repApproveConfirmPage({ booking: BOOKING, confirmUrl: 'https://x/confirm' })
  assert.match(html, /Smile Dental/)
})

test('practiceConfirmationEmail shows the rep name, phone, and a summary of what was submitted', () => {
  const { html } = practiceConfirmationEmail({ booking: BOOKING, rep: REP })
  assert.match(html, /James Delaney/)
  assert.match(html, /555-0199/)
  assert.match(html, /Crowns &amp; Bridges/)
  assert.match(html, /Looking forward to it/)
})

test('practicePendingEmail has NO click-to-call button (the practice already has its own number)', () => {
  const { html } = practicePendingEmail({ booking: BOOKING, rep: REP })
  assert.doesNotMatch(html, /tel:/)
  assert.match(html, /pending/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/officeVisits/officeVisitEmails.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// Backend/src/services/officeVisitEmails.js
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

const SHELL_OPEN = `<div style="max-width:600px;margin:40px auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#10353f">`
const SHELL_CLOSE = `</div>`

function fmtDateTime(date, time) {
  if (!date) return 'TBD'
  const d = new Date(`${date}T${time || '00:00:00'}`)
  const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  if (!time) return dateLabel
  const timeLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${dateLabel} at ${timeLabel}`
}

function addressLine(booking) {
  return [booking.address_line1, booking.address_line2, booking.city, booking.state, booking.zip]
    .filter(Boolean).map(escapeHtml).join(', ')
}

function serviceInterestsLine(booking) {
  return (booking.service_interests || []).map(escapeHtml).join(', ') || '(none selected)'
}

// Sent to the territory-matched rep (or media@aimdentallab.com fallback)
// when a practice submits the public request form. Both action links are
// GET-safe confirmation PAGES (officeVisits.js's GET /confirm), not
// instant-action links — see that route's own comments for why.
function repNotificationEmail({ booking, approveUrl, suggestTimeConfirmUrl }) {
  const subject = `Office Visit request: ${escapeHtml(booking.practice_name || booking.contact_name)}`
  const html = `${SHELL_OPEN}
    <h1 style="font-size:20px;margin:0 0 16px">New Office Visit Request</h1>
    <p style="margin:0 0 4px"><b>${escapeHtml(booking.practice_name || '(no practice name given)')}</b></p>
    <p style="margin:0 0 4px">${escapeHtml(booking.contact_name)}${booking.contact_role ? ` — ${escapeHtml(booking.contact_role)}` : ''}</p>
    <p style="margin:0 0 4px">${addressLine(booking)}</p>
    <p style="margin:0 0 4px">${escapeHtml(booking.email)} · ${escapeHtml(booking.phone)}</p>
    <p style="margin:16px 0 4px"><b>Requested:</b> ${escapeHtml(fmtDateTime(booking.requested_date, booking.requested_time))}</p>
    <p style="margin:0 0 4px"><b>Interested in:</b> ${serviceInterestsLine(booking)}</p>
    ${booking.message ? `<p style="margin:12px 0;padding:12px;background:#f3f8f8;border-radius:8px">${escapeHtml(booking.message)}</p>` : ''}
    <div style="margin-top:24px">
      <a href="${approveUrl}" style="display:inline-block;padding:11px 22px;background:#059669;color:#fff;text-decoration:none;font-weight:600;border-radius:10px;margin-right:10px">Approve</a>
      <a href="${suggestTimeConfirmUrl}" style="display:inline-block;padding:11px 22px;background:#fff;border:1px solid #d1d5db;color:#10353f;text-decoration:none;font-weight:600;border-radius:10px">Suggest another time</a>
    </div>
  ${SHELL_CLOSE}`
  return { subject, html }
}

// GET-safe confirmation page for "Suggest another time" — the rep's own
// click-to-call button for the PRACTICE's number lives here (not in any
// email to the practice), so the rep can call them right before sending
// the "pending" email. See the spec's self-review correction.
function repSuggestTimeConfirmPage({ booking, confirmUrl }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Suggest another time</title></head>
  <body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7faf9;padding:60px 20px;text-align:center">
    <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:36px 30px;box-shadow:0 4px 20px rgba(0,0,0,.06)">
      <h1 style="margin:0 0 10px;font-size:19px;color:#10353f">Suggest another time for ${escapeHtml(booking.practice_name || booking.contact_name)}?</h1>
      <p style="margin:0 0 18px;font-size:14px;color:#5b7a86;line-height:1.5">This marks the request as pending and emails the practice that you'll reach out directly. Call them now so you have a time ready:</p>
      <a href="tel:${escapeHtml(booking.phone)}" style="display:inline-block;margin-bottom:18px;padding:10px 20px;background:#eaf3f7;border:1px solid #a9cfe3;color:#1f6c88;text-decoration:none;font-weight:600;border-radius:10px">Call ${escapeHtml(booking.phone)}</a>
      <form method="POST" action="/api/office-visits/confirm">
        <input type="hidden" name="token" value="${escapeHtml(confirmUrl)}">
        <button type="submit" style="display:inline-block;padding:12px 28px;background:#059669;color:#fff;border:none;font-weight:600;font-size:14px;border-radius:10px;cursor:pointer">Send pending email</button>
      </form>
    </div>
  </body></html>`
}

// GET-safe confirmation page for "Approve" — no click-to-call needed here
// (approving doesn't require the rep to have called anyone first).
function repApproveConfirmPage({ booking, confirmUrl }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve office visit</title></head>
  <body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7faf9;padding:60px 20px;text-align:center">
    <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:36px 30px;box-shadow:0 4px 20px rgba(0,0,0,.06)">
      <h1 style="margin:0 0 10px;font-size:19px;color:#10353f">Approve the visit to ${escapeHtml(booking.practice_name || booking.contact_name)}?</h1>
      <p style="margin:0 0 18px;font-size:14px;color:#5b7a86;line-height:1.5">This confirms ${escapeHtml(fmtDateTime(booking.requested_date, booking.requested_time))} and emails the practice a confirmation with your name and number.</p>
      <form method="POST" action="/api/office-visits/confirm">
        <input type="hidden" name="token" value="${escapeHtml(confirmUrl)}">
        <button type="submit" style="display:inline-block;padding:12px 28px;background:#059669;color:#fff;border:none;font-weight:600;font-size:14px;border-radius:10px;cursor:pointer">Confirm &amp; Send</button>
      </form>
    </div>
  </body></html>`
}

// Sent to the practice once a booking is approved (either directly, or
// after a rep reschedules following "suggest another time").
function practiceConfirmationEmail({ booking, rep }) {
  const subject = `Your office visit is confirmed — ${fmtDateTime(booking.confirmed_date || booking.requested_date, booking.confirmed_time || booking.requested_time)}`
  const html = `${SHELL_OPEN}
    <h1 style="font-size:20px;margin:0 0 16px">Your Office Visit is Confirmed</h1>
    <p style="margin:0 0 12px"><b>${escapeHtml(fmtDateTime(booking.confirmed_date || booking.requested_date, booking.confirmed_time || booking.requested_time))}</b></p>
    <p style="margin:0 0 4px">Your rep: <b>${escapeHtml(rep.name)}</b></p>
    <p style="margin:0 0 16px">Reach them directly at ${escapeHtml(rep.phone || rep.email)}</p>
    <p style="margin:16px 0 4px;font-weight:600">What you told us:</p>
    <p style="margin:0 0 4px">Interested in: ${serviceInterestsLine(booking)}</p>
    ${booking.message ? `<p style="margin:0 0 4px">Message: ${escapeHtml(booking.message)}</p>` : ''}
  ${SHELL_CLOSE}`
  return { subject, html }
}

// Sent to the practice when the rep suggests another time instead of
// approving the requested slot. Deliberately NO click-to-call button —
// the practice already has its own number; that button is for the REP,
// on repSuggestTimeConfirmPage above.
function practicePendingEmail({ booking, rep }) {
  const subject = `Re: Your office visit request — ${escapeHtml(booking.practice_name || booking.contact_name)}`
  const html = `${SHELL_OPEN}
    <h1 style="font-size:20px;margin:0 0 16px">Your Request is Pending</h1>
    <p style="margin:0 0 16px;line-height:1.6">This booking is pending and is not yet confirmed. <b>${escapeHtml(rep.name)}</b> will reach out directly to find a time that works for you.</p>
  ${SHELL_CLOSE}`
  return { subject, html }
}

module.exports = {
  repNotificationEmail,
  repSuggestTimeConfirmPage,
  repApproveConfirmPage,
  practiceConfirmationEmail,
  practicePendingEmail,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/officeVisits/officeVisitEmails.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/officeVisitEmails.js test/officeVisits/officeVisitEmails.test.js
git commit -m "Add Office Visit email/confirm-page builders"
```

---

### Task 5: Public routes — request + confirm

**Files:**
- Create: `Backend/src/routes/officeVisits.js`
- Modify: `Backend/src/app.js` (mount it in the public block, before the global `cors()` call — see the existing `webLeadRoutes`/`implantIntakeRoutes` lines for the exact spot)
- Test: `Backend/test/officeVisits/officeVisitsRoutes.test.js`

**Interfaces:**
- Consumes: `matchRepByState` (Task 1), `createToken`/`peekToken`/`consumeToken` (Task 3), `repNotificationEmail`/`repSuggestTimeConfirmPage`/`repApproveConfirmPage`/`practiceConfirmationEmail`/`practicePendingEmail` (Task 4), `OFFICE_VISIT_CATEGORIES` (Task 2), `sendEmail` from `../services/email`, `rateLimiter` from `../middleware/rateLimiter`.
- Produces: an Express router mounted at `/api/office-visits` with `POST /request`, `GET /confirm`, `POST /confirm`.

- [ ] **Step 1: Write the failing test**

```javascript
// Backend/test/officeVisits/officeVisitsRoutes.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const request = require('http')
const express = require('express')
const db = require('../../src/config/db')
const officeVisitsRoutes = require('../../src/routes/officeVisits')

function startServer() {
  const app = express()
  app.use('/api/office-visits', officeVisitsRoutes)
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server))
  })
}

function post(server, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = request.request(
      { hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }))
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function get(server, path) {
  return new Promise((resolve, reject) => {
    request.get({ hostname: '127.0.0.1', port: server.address().port, path }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
    }).on('error', reject)
  })
}

test('POST /request creates a pending booking, matches a rep by state, and returns 201', async () => {
  const server = await startServer()
  const res = await post(server, '/api/office-visits/request', {
    practice_name: 'Smile Dental', contact_name: 'Jane Doe', phone: '555-0100',
    email: 'jane@smiledental.com', address_line1: '123 Main St', city: 'Brooklyn', state: 'NY', zip: '11201',
    requested_date: '2026-10-15', requested_time: '14:00', service_interests: ['Crowns & Bridges'],
  })
  assert.equal(res.status, 201)
  const { rows } = await db.query(`SELECT * FROM office_visit_bookings WHERE id = $1`, [res.body.id])
  assert.equal(rows[0].status, 'pending')
  assert.equal(rows[0].source, 'public_form')
  const { rows: repRows } = await db.query(`SELECT email FROM users WHERE id = $1`, [rows[0].assigned_rep_id])
  assert.equal(repRows[0].email, 'james@aimdentallab.com')
  server.close()
})

test('POST /request with a state that matches no territory leaves assigned_rep_id null', async () => {
  const server = await startServer()
  const res = await post(server, '/api/office-visits/request', {
    contact_name: 'No Match', phone: '555-0199', email: 'nomatch@example.com', state: 'TX',
    requested_date: '2026-10-15', requested_time: '14:00',
  })
  assert.equal(res.status, 201)
  const { rows } = await db.query(`SELECT assigned_rep_id FROM office_visit_bookings WHERE id = $1`, [res.body.id])
  assert.equal(rows[0].assigned_rep_id, null)
  server.close()
})

test('POST /request rejects a missing required field', async () => {
  const server = await startServer()
  const res = await post(server, '/api/office-visits/request', { contact_name: 'Missing Phone' })
  assert.equal(res.status, 400)
  server.close()
})

test('GET /confirm shows a confirmation page for a valid approve token without consuming it', async () => {
  const server = await startServer()
  const { rows } = await db.query(
    `INSERT INTO office_visit_bookings (source, contact_name, phone, status) VALUES ('public_form','Jane','555-0100','pending') RETURNING id`
  )
  const { createToken, peekToken } = require('../../src/services/officeVisitTokens')
  const token = await createToken({ bookingId: rows[0].id, action: 'approve' })
  const res = await get(server, `/api/office-visits/confirm?token=${token}`)
  assert.equal(res.status, 200)
  assert.match(res.body, /Approve/)
  const stillUsable = await peekToken(token)
  assert.notEqual(stillUsable, null, 'GET must not consume the token')
  server.close()
})

test('GET /confirm with an unknown token returns 410', async () => {
  const server = await startServer()
  const res = await get(server, '/api/office-visits/confirm?token=not-real')
  assert.equal(res.status, 410)
  server.close()
})

test('POST /confirm with action=approve sets status approved and confirmed_date/time', async () => {
  const server = await startServer()
  const { rows } = await db.query(
    `INSERT INTO office_visit_bookings (source, contact_name, phone, email, status, requested_date, requested_time)
     VALUES ('public_form','Jane','555-0100','jane@example.com','pending','2026-10-15','14:00') RETURNING id`
  )
  const { createToken } = require('../../src/services/officeVisitTokens')
  const token = await createToken({ bookingId: rows[0].id, action: 'approve' })
  const res = await post(server, '/api/office-visits/confirm', { token })
  assert.equal(res.status, 200)
  const { rows: after } = await db.query(`SELECT status, confirmed_date FROM office_visit_bookings WHERE id = $1`, [rows[0].id])
  assert.equal(after[0].status, 'approved')
  assert.notEqual(after[0].confirmed_date, null)
  server.close()
})

test('POST /confirm with action=suggest_time sets status time_suggested', async () => {
  const server = await startServer()
  const { rows } = await db.query(
    `INSERT INTO office_visit_bookings (source, contact_name, phone, email, status)
     VALUES ('public_form','Jane','555-0100','jane@example.com','pending') RETURNING id`
  )
  const { createToken } = require('../../src/services/officeVisitTokens')
  const token = await createToken({ bookingId: rows[0].id, action: 'suggest_time' })
  const res = await post(server, '/api/office-visits/confirm', { token })
  assert.equal(res.status, 200)
  const { rows: after } = await db.query(`SELECT status FROM office_visit_bookings WHERE id = $1`, [rows[0].id])
  assert.equal(after[0].status, 'time_suggested')
  server.close()
})

test('POST /confirm with an already-used token returns 410 and does not re-send', async () => {
  const server = await startServer()
  const { rows } = await db.query(
    `INSERT INTO office_visit_bookings (source, contact_name, phone, email, status)
     VALUES ('public_form','Jane','555-0100','jane@example.com','pending') RETURNING id`
  )
  const { createToken } = require('../../src/services/officeVisitTokens')
  const token = await createToken({ bookingId: rows[0].id, action: 'approve' })
  await post(server, '/api/office-visits/confirm', { token })
  const second = await post(server, '/api/office-visits/confirm', { token })
  assert.equal(second.status, 410)
  server.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/officeVisits/officeVisitsRoutes.test.js`
Expected: FAIL — `Cannot find module '../../src/routes/officeVisits'`

- [ ] **Step 3: Write the implementation**

```javascript
// Backend/src/routes/officeVisits.js
const express = require('express')
const cors = require('cors')
const db = require('../config/db')
const rateLimiter = require('../middleware/rateLimiter')
const { matchRepByState } = require('../services/repTerritories')
const { createToken, peekToken, consumeToken } = require('../services/officeVisitTokens')
const {
  repNotificationEmail, repSuggestTimeConfirmPage, repApproveConfirmPage,
  practiceConfirmationEmail, practicePendingEmail,
} = require('../services/officeVisitEmails')
const { OFFICE_VISIT_CATEGORIES } = require('../constants/officeVisitCategories')
const { sendEmail } = require('../services/email')

const router = express.Router()
const BACKEND_URL = process.env.RENDER_EXTERNAL_URL || 'https://aim-crm-backend.onrender.com'
const VALID_BRANDS = ['Aim Dental', 'Kings Highway']
const FALLBACK_EMAIL = 'media@aimdentallab.com'

// Public, self-contained CORS — same pattern as webLeads.js/implantIntake.js.
// Mounted in app.js BEFORE the global cors() policy; own cors()+json() here
// so it isn't restricted to the CRM frontend's origin.
router.use(cors())
router.use(express.json({ limit: '256kb' }))

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

function resultPage(title, message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
  <body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7faf9;padding:60px 20px;text-align:center">
    <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:36px 30px;box-shadow:0 4px 20px rgba(0,0,0,.06)">
      <h1 style="margin:0 0 10px;font-size:19px;color:#10353f">${escapeHtml(title)}</h1>
      <p style="margin:0;font-size:14px;color:#5b7a86;line-height:1.5">${escapeHtml(message)}</p>
    </div>
  </body></html>`
}

// POST /api/office-visits/request — public. A dental practice's website
// form submits here. Matches a rep by state (repTerritories.js); no match
// falls back to media@aimdentallab.com rather than silently dropping the
// request. Creates both action tokens up front so the notification email
// can link to both "Approve" and "Suggest another time" right away.
router.post('/request', rateLimiter({ windowMs: 60 * 1000, max: 10 }), async (req, res) => {
  try {
    const { practice_name, contact_name, contact_role, address_line1, address_line2, city, state, zip,
      email, phone, message, service_interests, requested_date, requested_time, brand } = req.body

    if (!contact_name || !phone || !email || !requested_date || !requested_time) {
      return res.status(400).json({ error: 'contact_name, phone, email, requested_date, and requested_time are required' })
    }

    const interests = Array.isArray(service_interests)
      ? service_interests.filter((s) => OFFICE_VISIT_CATEGORIES.includes(s))
      : []
    const resolvedBrand = VALID_BRANDS.includes(brand) ? brand : 'Aim Dental'

    const { rows } = await db.query(
      `INSERT INTO office_visit_bookings
         (source, practice_name, contact_name, contact_role, address_line1, address_line2, city, state, zip,
          email, phone, message, service_interests, requested_date, requested_time, status, brand)
       VALUES ('public_form',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15)
       RETURNING *`,
      [practice_name || null, contact_name, contact_role || null, address_line1 || null, address_line2 || null,
        city || null, state || null, zip || null, email, phone, message || null, interests,
        requested_date, requested_time, resolvedBrand]
    )
    const booking = rows[0]

    const rep = await matchRepByState(state)
    if (rep) {
      await db.query(`UPDATE office_visit_bookings SET assigned_rep_id = $1 WHERE id = $2`, [rep.id, booking.id])
      booking.assigned_rep_id = rep.id
    }

    const approveToken = await createToken({ bookingId: booking.id, action: 'approve' })
    const suggestToken = await createToken({ bookingId: booking.id, action: 'suggest_time' })
    const approveUrl = `${BACKEND_URL}/api/office-visits/confirm?token=${approveToken}`
    const suggestTimeConfirmUrl = `${BACKEND_URL}/api/office-visits/confirm?token=${suggestToken}`

    const { subject, html } = repNotificationEmail({ booking, approveUrl, suggestTimeConfirmUrl })
    await sendEmail({ to: [rep ? rep.email : FALLBACK_EMAIL], subject, html })

    return res.status(201).json({ id: booking.id })
  } catch (err) {
    console.error('[office-visits] POST /request failed:', err)
    return res.status(500).json({ error: 'Something went wrong submitting your request. Please try again.' })
  }
})

// GET /api/office-visits/confirm?token=... — public, read-only. Shows a
// confirmation page; does NOT change any state or consume the token. Email
// providers/clients routinely pre-fetch links to scan them for safety — if
// this GET performed the real action, that automated pre-fetch would
// silently burn the single-use token (and confirm/suggest-time the
// booking) before the rep ever clicked anything. Mirrors
// reportApproval.js's peekApprovalToken / routes/reports.js's GET /approve
// precedent exactly.
router.get('/confirm', rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 }), async (req, res) => {
  try {
    const { token } = req.query
    if (!token) return res.status(400).send(resultPage('Missing link', 'This link is missing its token.'))

    const claim = await peekToken(token)
    if (!claim) return res.status(410).send(resultPage('Link expired or already used', 'This link has already been used, or is more than 7 days old.'))

    const { rows } = await db.query(`SELECT * FROM office_visit_bookings WHERE id = $1`, [claim.booking_id])
    const booking = rows[0]
    if (!booking) return res.status(404).send(resultPage('Not found', 'This booking no longer exists.'))

    const page = claim.action === 'approve'
      ? repApproveConfirmPage({ booking, confirmUrl: token })
      : repSuggestTimeConfirmPage({ booking, confirmUrl: token })
    return res.send(page)
  } catch (err) {
    console.error('[office-visits] GET /confirm failed:', err)
    return res.status(500).send(resultPage('Something went wrong', err.message || ''))
  }
})

// POST /api/office-visits/confirm — public, the only route that actually
// changes state. Reached solely by a real submit of the confirmation
// page's <form> above (never a bare link a scanner would pre-fetch).
router.post('/confirm', rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 }), async (req, res) => {
  try {
    const { token } = req.body
    if (!token) return res.status(400).send(resultPage('Missing link', 'This link is missing its token.'))

    const claim = await consumeToken(token)
    if (!claim) return res.status(410).send(resultPage('Link expired or already used', 'This link has already been used, or is more than 7 days old.'))

    const { rows } = await db.query(`SELECT * FROM office_visit_bookings WHERE id = $1`, [claim.booking_id])
    const booking = rows[0]
    if (!booking) return res.status(404).send(resultPage('Not found', 'This booking no longer exists.'))

    const rep = booking.assigned_rep_id
      ? (await db.query(`SELECT name, email, phone FROM users WHERE id = $1`, [booking.assigned_rep_id])).rows[0]
      : { name: 'Your AIM Dental rep', email: FALLBACK_EMAIL, phone: null }

    if (claim.action === 'approve') {
      await db.query(
        `UPDATE office_visit_bookings SET status='approved', confirmed_date=requested_date, confirmed_time=requested_time, updated_at=NOW() WHERE id=$1`,
        [booking.id]
      )
      const updated = { ...booking, confirmed_date: booking.requested_date, confirmed_time: booking.requested_time }
      if (booking.email) {
        const { subject, html } = practiceConfirmationEmail({ booking: updated, rep })
        await sendEmail({ to: [booking.email], subject, html })
      }
      return res.send(resultPage('Approved!', 'The office visit has been confirmed and the practice has been emailed.'))
    }

    // suggest_time
    await db.query(`UPDATE office_visit_bookings SET status='time_suggested', updated_at=NOW() WHERE id=$1`, [booking.id])
    if (booking.email) {
      const { subject, html } = practicePendingEmail({ booking, rep })
      await sendEmail({ to: [booking.email], subject, html, headers: { 'In-Reply-To': `<office-visit-${booking.id}@aimdentallab.com>`, References: `<office-visit-${booking.id}@aimdentallab.com>` } })
    }
    return res.send(resultPage('Marked pending', 'The practice has been told you will reach out directly.'))
  } catch (err) {
    console.error('[office-visits] POST /confirm failed:', err)
    return res.status(500).send(resultPage('Something went wrong', err.message || ''))
  }
})

module.exports = router
```

- [ ] **Step 4: Mount the router in app.js**

In `Backend/src/app.js`, add the import near the other route requires (after `const implantIntakeRoutes = require('./routes/implantIntake')`):

```javascript
const officeVisitsRoutes = require('./routes/officeVisits')
```

And mount it in the public block, right after `app.use('/api/verify-email', verifyEmailRoutes) // public — first-time-email gate for Schedule Pickup / Submit a Scanned Case`:

```javascript
app.use('/api/office-visits', officeVisitsRoutes) // public — Office Visit request form + approve/suggest-time confirm links
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/officeVisits/officeVisitsRoutes.test.js`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add src/routes/officeVisits.js src/app.js test/officeVisits/officeVisitsRoutes.test.js
git commit -m "Add public Office Visit request + approve/suggest-time confirm routes"
```

---

### Task 6: Auth-gated routes — rep-scheduled, list, reschedule

**Files:**
- Create: `Backend/src/routes/officeVisitsAdmin.js`
- Modify: `Backend/src/app.js` (mount after the global `cors()`/`express.json()`, alongside the other authenticated routes)
- Test: `Backend/test/officeVisits/officeVisitsAdmin.test.js`

**Interfaces:**
- Consumes: `auth` middleware from `../middleware/auth`, `practiceConfirmationEmail` (Task 4), `createToken` (Task 3, for tokens returned alongside pending bookings so the Frontend's inline Approve/Suggest-time buttons can call the public `POST /confirm` endpoint from Task 5).
- Produces: an Express router mounted at `/api/office-visits-admin` (a distinct prefix from the public router's `/api/office-visits`, so the two can't collide on route matching) with `GET /`, `POST /`, `PUT /:id/reschedule`.

- [ ] **Step 1: Write the failing test**

```javascript
// Backend/test/officeVisits/officeVisitsAdmin.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const request = require('http')
const express = require('express')
const db = require('../../src/config/db')
const officeVisitsAdminRoutes = require('../../src/routes/officeVisitsAdmin')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

function startServer() {
  const app = express()
  app.use(express.json())
  app.use('/api/office-visits-admin', officeVisitsAdminRoutes)
  return new Promise((resolve) => { const server = app.listen(0, () => resolve(server)) })
}

function authedToken(user) {
  return jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '1h' })
}

function call(server, method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    const req = request.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

test('GET / requires auth', async () => {
  const server = await startServer()
  const res = await call(server, 'GET', '/api/office-visits-admin')
  assert.equal(res.status, 401)
  server.close()
})

test('POST / (rep-scheduled) creates an approved booking with no email and skips sending', async () => {
  const server = await startServer()
  const { rows: [rep] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
  const token = authedToken({ id: rep.id, email: rep.email, role: 'sales_rep' })
  const res = await call(server, 'POST', '/api/office-visits-admin', {
    token,
    body: { contact_name: 'Walk-in Practice', phone: '555-0150', requested_date: '2026-10-20', requested_time: '10:00' },
  })
  assert.equal(res.status, 201)
  const { rows } = await db.query(`SELECT * FROM office_visit_bookings WHERE id = $1`, [res.body.id])
  assert.equal(rows[0].source, 'rep_scheduled')
  assert.equal(rows[0].status, 'approved')
  assert.equal(rows[0].assigned_rep_id, rep.id)
  server.close()
})

test('POST / (rep-scheduled) with an email sends a confirmation', async () => {
  const server = await startServer()
  const { rows: [rep] } = await db.query(`SELECT id, email FROM users WHERE email='williama@aimdentallab.com'`)
  const token = authedToken({ id: rep.id, email: rep.email, role: 'sales_rep' })
  const res = await call(server, 'POST', '/api/office-visits-admin', {
    token,
    body: { contact_name: 'Has Email Practice', phone: '555-0160', email: 'office@example.com', requested_date: '2026-10-21', requested_time: '11:00' },
  })
  assert.equal(res.status, 201)
  server.close()
})

test('PUT /:id/reschedule sets a confirmed date/time and status approved', async () => {
  const server = await startServer()
  const { rows: [rep] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
  const { rows: [booking] } = await db.query(
    `INSERT INTO office_visit_bookings (source, contact_name, phone, email, status, assigned_rep_id)
     VALUES ('public_form','Jane','555-0100','jane@example.com','time_suggested',$1) RETURNING id`,
    [rep.id]
  )
  const token = authedToken({ id: rep.id, email: rep.email, role: 'sales_rep' })
  const res = await call(server, 'PUT', `/api/office-visits-admin/${booking.id}/reschedule`, {
    token, body: { confirmed_date: '2026-10-22', confirmed_time: '15:00' },
  })
  assert.equal(res.status, 200)
  const { rows: after } = await db.query(`SELECT status, confirmed_date FROM office_visit_bookings WHERE id = $1`, [booking.id])
  assert.equal(after[0].status, 'approved')
  assert.notEqual(after[0].confirmed_date, null)
  server.close()
})

test('GET / returns pending bookings with their approve/suggest-time tokens', async () => {
  const server = await startServer()
  const { rows: [rep] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
  const token = authedToken({ id: rep.id, email: rep.email, role: 'sales_rep' })
  const res = await call(server, 'GET', '/api/office-visits-admin', { token })
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body))
  const pending = res.body.find((b) => b.status === 'pending')
  if (pending) {
    assert.ok(pending.approve_token)
    assert.ok(pending.suggest_time_token)
  }
  server.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/officeVisits/officeVisitsAdmin.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// Backend/src/routes/officeVisitsAdmin.js
const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const { createToken } = require('../services/officeVisitTokens')
const { practiceConfirmationEmail } = require('../services/officeVisitEmails')
const { OFFICE_VISIT_CATEGORIES } = require('../constants/officeVisitCategories')
const { sendEmail } = require('../services/email')

const router = express.Router()
router.use(auth)

// GET / — list all bookings for the Office Visits tab. pending bookings
// include their approve_token/suggest_time_token so the Frontend's inline
// Approve/Suggest-time buttons can call the SAME public POST
// /api/office-visits/confirm endpoint the email links use, rather than
// duplicating that logic behind auth.
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ovb.*, u.name AS assigned_rep_name
       FROM office_visit_bookings ovb
       LEFT JOIN users u ON u.id = ovb.assigned_rep_id
       ORDER BY ovb.created_at DESC`
    )
    const pendingIds = rows.filter((r) => r.status === 'pending').map((r) => r.id)
    let tokensByBooking = {}
    if (pendingIds.length > 0) {
      const { rows: tokenRows } = await db.query(
        `SELECT booking_id, token, action FROM office_visit_tokens
         WHERE booking_id = ANY($1::uuid[]) AND used_at IS NULL AND expires_at > NOW()`,
        [pendingIds]
      )
      tokensByBooking = tokenRows.reduce((acc, t) => {
        acc[t.booking_id] = acc[t.booking_id] || {}
        acc[t.booking_id][t.action === 'approve' ? 'approve_token' : 'suggest_time_token'] = t.token
        return acc
      }, {})
    }
    const withTokens = rows.map((r) => ({ ...r, ...(tokensByBooking[r.id] || {}) }))
    return res.json(withTokens)
  } catch (err) {
    console.error('[office-visits-admin] GET / failed:', err)
    return res.status(500).json({ error: 'Failed to load office visits' })
  }
})

// POST / — Way 2: a rep schedules an office visit directly. Approved
// immediately (no approval step needed, the rep IS the approval).
// Confirmation email fires only if an email was provided.
router.post('/', async (req, res) => {
  try {
    const { practice_name, contact_name, contact_role, address_line1, address_line2, city, state, zip,
      email, phone, message, service_interests, requested_date, requested_time } = req.body

    if (!contact_name || !phone || !requested_date || !requested_time) {
      return res.status(400).json({ error: 'contact_name, phone, requested_date, and requested_time are required' })
    }
    const interests = Array.isArray(service_interests)
      ? service_interests.filter((s) => OFFICE_VISIT_CATEGORIES.includes(s))
      : []

    const { rows } = await db.query(
      `INSERT INTO office_visit_bookings
         (source, practice_name, contact_name, contact_role, address_line1, address_line2, city, state, zip,
          email, phone, message, service_interests, requested_date, requested_time, confirmed_date, confirmed_time,
          status, assigned_rep_id)
       VALUES ('rep_scheduled',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13,$14,'approved',$15)
       RETURNING *`,
      [practice_name || null, contact_name, contact_role || null, address_line1 || null, address_line2 || null,
        city || null, state || null, zip || null, email || null, phone, message || null, interests,
        requested_date, requested_time, req.user.id]
    )
    const booking = rows[0]

    if (booking.email) {
      const { rows: repRows } = await db.query(`SELECT name, email, phone FROM users WHERE id = $1`, [req.user.id])
      const { subject, html } = practiceConfirmationEmail({ booking, rep: repRows[0] })
      await sendEmail({ to: [booking.email], subject, html })
    }

    return res.status(201).json(booking)
  } catch (err) {
    console.error('[office-visits-admin] POST / failed:', err)
    return res.status(500).json({ error: 'Failed to create office visit' })
  }
})

// PUT /:id/reschedule — the CRM-only action after "suggest another time":
// the rep has already called the practice and agreed a real time, so this
// sets it directly (not an email-link action — see spec).
router.put('/:id/reschedule', async (req, res) => {
  try {
    const { confirmed_date, confirmed_time } = req.body
    if (!confirmed_date || !confirmed_time) {
      return res.status(400).json({ error: 'confirmed_date and confirmed_time are required' })
    }
    const { rows } = await db.query(
      `UPDATE office_visit_bookings SET status='approved', confirmed_date=$1, confirmed_time=$2, updated_at=NOW()
       WHERE id = $3 RETURNING *`,
      [confirmed_date, confirmed_time, req.params.id]
    )
    const booking = rows[0]
    if (!booking) return res.status(404).json({ error: 'Booking not found' })

    if (booking.email) {
      const { rows: repRows } = await db.query(`SELECT name, email, phone FROM users WHERE id = $1`, [booking.assigned_rep_id])
      const rep = repRows[0] || { name: 'Your AIM Dental rep', email: null, phone: null }
      const { subject, html } = practiceConfirmationEmail({ booking, rep })
      await sendEmail({ to: [booking.email], subject, html })
    }
    return res.json(booking)
  } catch (err) {
    console.error('[office-visits-admin] PUT /:id/reschedule failed:', err)
    return res.status(500).json({ error: 'Failed to reschedule' })
  }
})

module.exports = router
```

- [ ] **Step 4: Mount the router in app.js**

Add the import near the other route requires:

```javascript
const officeVisitsAdminRoutes = require('./routes/officeVisitsAdmin')
```

Mount it with the other authenticated routes, after the `app.use(express.json({ limit: '5mb' }))` line (anywhere among the other `app.use('/api/...', ...Routes)` lines for authenticated routes is fine — it only needs to be after the global `cors()`):

```javascript
app.use('/api/office-visits-admin', officeVisitsAdminRoutes)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/officeVisits/officeVisitsAdmin.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/routes/officeVisitsAdmin.js src/app.js test/officeVisits/officeVisitsAdmin.test.js
git commit -m "Add auth-gated Office Visit routes: rep-scheduled create, list, reschedule"
```

---

### Task 7: Wire tests into package.json and run the full suite

**Files:**
- Modify: `Backend/package.json`

- [ ] **Step 1: Add the new test files to the test script**

The current script (confirm by reading `package.json` before editing — it may have changed since this plan was written):

```
"test": "node --test test/evidentReport/*.test.js test/salesRepDailyReport/*.test.js test/goalBarAnimation.test.js test/evidentCrmSync.test.js test/reportApproval.test.js test/repProgressSuggestions.test.js test/repProgress.test.js"
```

Change to:

```
"test": "node --test test/evidentReport/*.test.js test/salesRepDailyReport/*.test.js test/goalBarAnimation.test.js test/evidentCrmSync.test.js test/reportApproval.test.js test/repProgressSuggestions.test.js test/repProgress.test.js test/officeVisits/*.test.js"
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — every existing suite plus all `officeVisits/*.test.js` files from Tasks 1, 3, 4, 5, 6.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "Wire Office Visit tests into the npm test script"
```

---

### Task 8: Frontend — Office Visits page

**Files:**
- Create: `Frontend/src/pages/scheduler/OfficeVisits.jsx`
- Modify: `Frontend/src/components/Layout.jsx` (add nav tab)
- Modify: `Frontend/src/App.jsx` (add route)

**Interfaces:**
- Consumes: `OFFICE_VISIT_CATEGORIES` from `Frontend/src/lib/officeVisitCategories.js` (Task 2), `Frontend/src/lib/api.js`'s default export (the CRM's own authenticated fetch wrapper — NOT `schedulerApi.js`), `GET /api/office-visits-admin`, `POST /api/office-visits-admin`, `PUT /api/office-visits-admin/:id/reschedule`, and the **public** `POST /api/office-visits/confirm` (called directly, unauthenticated, with the booking's stored `approve_token`/`suggest_time_token` — same endpoint the email links use).

- [ ] **Step 1: Check the existing `api.js` wrapper's call shape**

Read `Frontend/src/lib/api.js` to confirm its exact exported function signature (e.g. `api.get(path)`/`api.post(path, body)` or a raw axios-like instance) before writing calls against it — match whatever this file actually exports, since it is the established pattern every other authenticated CRM page already uses (do not introduce a second HTTP client).

- [ ] **Step 2: Write the page**

```jsx
// Frontend/src/pages/scheduler/OfficeVisits.jsx
import { useEffect, useState } from 'react'
import api from '../../lib/api'
import { OFFICE_VISIT_CATEGORIES } from '../../lib/officeVisitCategories'

const STATUS_LABEL = {
  pending: 'Pending',
  approved: 'Approved',
  time_suggested: 'Time suggested',
  declined: 'Declined',
}

function fmtDateTime(date, time) {
  if (!date) return 'TBD'
  const d = new Date(`${date}T${time || '00:00:00'}`)
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export default function OfficeVisits() {
  const [bookings, setBookings] = useState([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')
  const [showNewForm, setShowNewForm] = useState(false)
  const [rescheduling, setRescheduling] = useState(null) // booking id being rescheduled

  async function load() {
    setLoading(true)
    try {
      const { data } = await api.get('/office-visits-admin')
      setBookings(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function approve(booking) {
    await fetch(`${import.meta.env.VITE_API_URL}/office-visits/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: booking.approve_token }),
    })
    load()
  }

  async function suggestTime(booking) {
    await fetch(`${import.meta.env.VITE_API_URL}/office-visits/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: booking.suggest_time_token }),
    })
    load()
  }

  async function submitReschedule(id, confirmed_date, confirmed_time) {
    await api.put(`/office-visits-admin/${id}/reschedule`, { confirmed_date, confirmed_time })
    setRescheduling(null)
    load()
  }

  const visible = statusFilter === 'all' ? bookings : bookings.filter((b) => b.status === statusFilter)

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-ink">Office Visits</h1>
        <button onClick={() => setShowNewForm(true)} className="px-4 py-2 rounded-full bg-ink text-white font-semibold">New Office Visit</button>
      </div>

      <div className="flex gap-2 mb-4">
        {['all', 'pending', 'time_suggested', 'approved'].map((s) => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium ${statusFilter === s ? 'bg-teal text-white' : 'bg-white border border-hairline text-slate'}`}>
            {s === 'all' ? 'All' : STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {loading ? <p className="text-slate">Loading…</p> : (
        <div className="space-y-3">
          {visible.length === 0 && <p className="text-slate">No office visits here yet.</p>}
          {visible.map((b) => (
            <div key={b.id} className="p-4 rounded-xl border border-hairline bg-white">
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-semibold text-ink">{b.practice_name || b.contact_name}</p>
                  <p className="text-sm text-slate">{b.contact_name}{b.contact_role ? ` — ${b.contact_role}` : ''}</p>
                  <p className="text-sm text-slate">{fmtDateTime(b.confirmed_date || b.requested_date, b.confirmed_time || b.requested_time)}</p>
                  <p className="text-xs text-faint mt-1">{b.assigned_rep_name || 'Unassigned'} · {STATUS_LABEL[b.status]}</p>
                </div>
                <div className="flex gap-2">
                  {b.status === 'pending' && (
                    <>
                      <button onClick={() => approve(b)} className="px-3 py-1.5 rounded-full bg-emerald-600 text-white text-sm font-semibold">Approve</button>
                      <button onClick={() => suggestTime(b)} className="px-3 py-1.5 rounded-full border border-hairline text-sm font-semibold">Suggest another time</button>
                    </>
                  )}
                  {b.status === 'time_suggested' && (
                    rescheduling === b.id ? (
                      <RescheduleForm onSubmit={(date, time) => submitReschedule(b.id, date, time)} onCancel={() => setRescheduling(null)} />
                    ) : (
                      <button onClick={() => setRescheduling(b.id)} className="px-3 py-1.5 rounded-full bg-ink text-white text-sm font-semibold">Set confirmed time</button>
                    )
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showNewForm && <NewOfficeVisitModal onClose={() => setShowNewForm(false)} onCreated={() => { setShowNewForm(false); load() }} />}
    </div>
  )
}

function RescheduleForm({ onSubmit, onCancel }) {
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  return (
    <div className="flex gap-2 items-center">
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border border-hairline rounded-lg px-2 py-1 text-sm" />
      <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="border border-hairline rounded-lg px-2 py-1 text-sm" />
      <button onClick={() => date && time && onSubmit(date, time)} className="px-3 py-1.5 rounded-full bg-emerald-600 text-white text-sm font-semibold">Confirm</button>
      <button onClick={onCancel} className="text-sm text-slate">Cancel</button>
    </div>
  )
}

function NewOfficeVisitModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    practice_name: '', contact_name: '', contact_role: '', address_line1: '', city: '', state: '', zip: '',
    email: '', phone: '', message: '', service_interests: [], requested_date: '', requested_time: '',
  })
  const [saving, setSaving] = useState(false)

  function toggleInterest(cat) {
    setForm((f) => ({
      ...f,
      service_interests: f.service_interests.includes(cat)
        ? f.service_interests.filter((c) => c !== cat)
        : [...f.service_interests, cat],
    }))
  }

  async function submit() {
    if (!form.contact_name || !form.phone || !form.requested_date || !form.requested_time) return
    setSaving(true)
    try {
      await api.post('/office-visits-admin', form)
      onCreated()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-md w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-ink mb-4">New Office Visit</h2>
        <div className="space-y-3">
          <input placeholder="Practice name" value={form.practice_name} onChange={(e) => setForm({ ...form, practice_name: e.target.value })} className="w-full border border-hairline rounded-lg px-3 py-2 text-sm" />
          <input placeholder="Contact name *" value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} className="w-full border border-hairline rounded-lg px-3 py-2 text-sm" />
          <input placeholder="Phone *" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full border border-hairline rounded-lg px-3 py-2 text-sm" />
          <input placeholder="Email (optional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full border border-hairline rounded-lg px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <input type="date" value={form.requested_date} onChange={(e) => setForm({ ...form, requested_date: e.target.value })} className="flex-1 border border-hairline rounded-lg px-3 py-2 text-sm" />
            <input type="time" value={form.requested_time} onChange={(e) => setForm({ ...form, requested_time: e.target.value })} className="flex-1 border border-hairline rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <p className="text-xs font-medium text-slate mb-2">Interested in</p>
            <div className="flex flex-wrap gap-2">
              {OFFICE_VISIT_CATEGORIES.map((cat) => (
                <button key={cat} type="button" onClick={() => toggleInterest(cat)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border ${form.service_interests.includes(cat) ? 'bg-teal text-white border-teal' : 'border-hairline text-slate'}`}>
                  {cat}
                </button>
              ))}
            </div>
          </div>
          <textarea placeholder="Notes (optional)" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} className="w-full border border-hairline rounded-lg px-3 py-2 text-sm min-h-[4rem]" />
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2 rounded-full bg-ink text-white text-sm font-semibold disabled:opacity-50">{saving ? 'Saving…' : 'Create'}</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
cd Frontend && git add src/pages/scheduler/OfficeVisits.jsx
git commit -m "Add Office Visits page (list, approve/suggest-time, reschedule, new booking)"
```

---

### Task 9: Frontend — nav and route wiring

**Files:**
- Modify: `Frontend/src/components/Layout.jsx`
- Modify: `Frontend/src/App.jsx`

- [ ] **Step 1: Read the current SchedulerSubNav array and App.jsx scheduler routes**

Read `Frontend/src/components/Layout.jsx` around its `SchedulerSubNav` array (the one with `{ to: '/scheduler', label: 'Overview', exact: true }` etc.) and `Frontend/src/App.jsx` around its `/scheduler/*` routes, to confirm the exact current line numbers before editing (they may have shifted since this plan was written).

- [ ] **Step 2: Add the nav tab**

In `Layout.jsx`'s `SchedulerSubNav` array, add a new entry after the existing ones (before the closing `]`):

```javascript
{ to: '/scheduler/office-visits', label: 'Office Visits' },
```

- [ ] **Step 3: Add the route**

In `App.jsx`, add the import near the other scheduler imports:

```javascript
import SchedulerOfficeVisits from './pages/scheduler/OfficeVisits'
```

And add the route among the other `/scheduler/*` routes, using `ProtectedRoute` (not `AdminRoute` — both reps need this for their own bookings, matching Case Pickup Schedules' access level):

```jsx
<Route path="/scheduler/office-visits" element={<ProtectedRoute><SchedulerOfficeVisits /></ProtectedRoute>} />
```

- [ ] **Step 4: Manually verify in the browser**

Run `npm run dev` in `Frontend/`, log in, navigate to `/scheduler/office-visits`, confirm the tab appears in the Scheduler subnav alongside Overview/Calendar/Appointments/etc., the page loads without console errors, and "New Office Visit" opens the modal.

- [ ] **Step 5: Commit**

```bash
cd Frontend && git add src/components/Layout.jsx src/App.jsx
git commit -m "Wire Office Visits into the Scheduler subnav and routes"
```

---

## Self-Review

**1. Spec coverage:** Way 1 (public form → territory match → rep notification → approve/suggest-time with GET-safe confirm pages → practice emails) is Tasks 1, 3, 4, 5. Way 2 (rep-scheduled, conditional confirmation email) is Task 6. Reschedule-after-suggest-time is Task 6's `PUT /:id/reschedule`. Frontend tab placement inside the Scheduler subnav, calling this CRM's own backend, is Tasks 8–9. The click-to-call correction (rep-facing, not practice-facing) is in Task 4. Service categories are Task 2. Territory seed data is Task 1. All spec sections are covered.

**2. Placeholder scan:** No TBD/TODO found; every step has real, complete code.

**3. Type consistency:** `matchRepByState` (Task 1) returns `{id, name, email}`, consumed identically in Tasks 5 and the spec's `rep` lookups. `createToken`/`peekToken`/`consumeToken` (Task 3) signatures match their usage in Task 5. Email builder function names/params (Task 4) match their call sites in Tasks 5 and 6 exactly. `OFFICE_VISIT_CATEGORIES` (Task 2) is validated against identically in Task 5's and Task 6's routes.

**4. Review Focus coverage:** No-territory-match fallback — tested in Task 5, Step 1 ("state that matches no territory"). Double-click/replay safety — tested in Task 3 (`consumeToken` second-call) and Task 5 (`POST /confirm with an already-used token`). XSS escaping — tested in Task 4 (`repNotificationEmail HTML-escapes`). Expired/unknown token handling — tested in Task 5 (`GET /confirm with an unknown token returns 410`). Rep-scheduled booking with no email — tested in Task 6 (`POST / (rep-scheduled) creates an approved booking with no email and skips sending`).

---

Plan complete and saved to `docs/superpowers/plans/2026-10-01-office-visit-bookings.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** — a fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — I implement every task myself in this session, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end.

For this plan I recommend **Native**, because the 9 tasks are mostly sequential within each repo (migration → services → routes → tests, then Frontend page → Frontend wiring) with few places where parallel subagents would actually save time, and a shipped mistake here is low-cost to catch (it's an internal CRM feature behind auth/tokens, not a public-facing payment flow). Does the plan capture what you want, and which approach should we use?

