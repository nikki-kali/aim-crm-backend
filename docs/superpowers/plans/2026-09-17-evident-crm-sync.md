# Automated Evident → CRM Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically keep the CRM's `clients`/`cases` tables current from Evident's own daily company-wide emails, both going forward (a new cron job) and for existing history (a one-time backfill script).

**Architecture:** A single core function, `syncCasesForDate(dateStr)` in a new `src/services/evidentCrmSync.js`, does all the real work — fetch that day's "Daily Booking Report - Nadine" and "Daily Billed Report - Nadine" emails, resolve each row's doctor to an existing or newly-created `clients` row, and upsert the matching `cases` row by Evident's own reference number. Two thin callers share it: a new weekday cron job (going forward) and a one-time CLI backfill script (historical catch-up), both gated by manual rollout steps before touching real data at scale.

**Tech Stack:** Node.js (CommonJS), `pg` (raw SQL, no ORM), `node-cron`, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-17-evident-crm-sync-design.md`

## Global Constraints

- New-doctor handling is **always create a client directly** — no lead-creation path anywhere in this pipeline (spec, "Decisions from stakeholder review").
- Unassigned ("N/A" bucket) doctors get `assigned_to = NULL` — never an invented owner.
- Only `james@aimdentallab.com` / `williama@aimdentallab.com` are real reps this pipeline recognizes; any other `Salesperson` value (blank, typo, unrecognized) resolves to unassigned, never an error.
- Matching an existing client's doctor_name is done on a **normalized** name (lowercase, strip `.`/`,`, collapse whitespace) — real Evident names vary in punctuation/case (`"DR BRIAN GOLD"` vs `"Dr. Brian Gold"`).
- Case upserts are keyed by `evident_case_number` (Evident's `Ref`) — same column the existing manual `import-evident` route already uses.
- No unit tests for DB-writing logic (no staging DB for this project) — verified instead via a required single-real-day manual check before the historical backfill runs (Task 6).
- The backfill script is a CLI script (`node scripts/...`), never an HTTP route.
- All new automated behavior ships **disabled by default**, matching every other automated job this session (`EVIDENT_CRM_SYNC_ENABLED` gate).

---

### Task 1: Row-level Evident email parsers

**Files:**
- Modify: `src/services/evidentReport/parseEvident.js`
- Test: `test/evidentReport/parseEvident.test.js`

**Interfaces:**
- Consumes: `parseTable(html)`, `findCol(headers, needle)`, `rowToObj(headers, row)`, `toNum(s)` — all already defined earlier in this file.
- Produces: `extractBookingRows(html)` → `Array<{ ref: string, customerName: string, value: number, salesperson: string }>`. `extractBilledRows(html)` → `Array<{ ref: string, customerName: string, value: number, billedValue: number, salesperson: string }>`. Both drop the blank totals row and any row with no `Ref`. Both exported from this module — later tasks import them.

This task adds two new parsers alongside the existing `extractDailyBookedCustomerNames`/`extractCaseTotals` (which read totals-row/name-only data) — these two read full row-level detail from the two company-wide daily reports, needed to actually create/update individual `cases` rows.

- [ ] **Step 1: Write the failing tests**

Add to `test/evidentReport/parseEvident.test.js`, near the existing `extractDailyBookedCustomerNames`/`extractCaseTotals` tests:

```js
test('extractBookingRows reads every real row from Daily Booking Report - Nadine, dropping the totals row', () => {
  const rows = extractBookingRows(fixture('company-daily-booked-nadine.html'));
  assert.equal(rows.length, 94); // 95 total rows in the fixture minus 1 totals row
  assert.deepEqual(rows[0], { ref: '5569', customerName: 'SUNSET TERRACE', value: 0, salesperson: '' });
  // Real row with a salesperson attributed — the last real data row in the fixture.
  assert.deepEqual(rows[rows.length - 1], { ref: '5663', customerName: 'Dr. ALBERTO GONZALEZ', value: 0, salesperson: 'william' });
});

test('extractBilledRows reads every real row from Daily Billed Report - Nadine, dropping the totals row', () => {
  const rows = extractBilledRows(fixture('company-daily-billed-nadine.html'));
  assert.equal(rows.length, 34); // 35 total rows in the fixture minus 1 totals row
  assert.deepEqual(rows[0], { ref: '4067', customerName: 'WYCKOFF HOSPITAL', value: 102.14, billedValue: 102.14, salesperson: '' });
  // Real row with a salesperson attributed and a blank (unbilled-this-row) billed value.
  assert.deepEqual(rows[rows.length - 1], { ref: '5663', customerName: 'Dr. ALBERTO GONZALEZ', value: 0, billedValue: 0, salesperson: 'william' });
});

test('extractBookingRows / extractBilledRows return an empty array when there is no real data', () => {
  assert.deepEqual(extractBookingRows('<TABLE><TR><TD>No data was returned, Please double check your filters</TABLE>'), []);
  assert.deepEqual(extractBilledRows('<TABLE><TR><TD>No data was returned, Please double check your filters</TABLE>'), []);
});
```

Add `extractBookingRows, extractBilledRows` to the destructured import at the top of the test file (same line that already imports `extractDailyBookedCustomerNames`, `extractCaseTotals`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/evidentReport/parseEvident.test.js`
Expected: FAIL — `extractBookingRows is not a function` / `extractBilledRows is not a function`

- [ ] **Step 3: Implement the parsers**

In `src/services/evidentReport/parseEvident.js`, add directly below the existing `extractCaseTotals` function (before the `const EXPECTED = [` line):

```js
// Row-level detail from "Daily Booking Report - Nadine" — every real
// booking event that day, company-wide (not just James'/William's own
// doctors, unlike extractDailyBookedCustomerNames above). Used by
// evidentCrmSync.js to create/update individual CRM `cases` rows, not
// just a combined total. Customer Name is trimmed (Evident's own HTML
// pads it with spaces); Salesperson is '' for the unattributed "N/A"
// bucket, a lowercase first name ('james'/'william') when attributed.
function extractBookingRows(html) {
  const table = parseTable(html);
  if (!table || table.rows.length === 0) return [];
  const { headers, rows } = table;
  const refCol = findCol(headers, 'Ref');
  const nameCol = findCol(headers, 'Customer Name');
  const valueCol = findCol(headers, 'Sales Value (Total)');
  const salespersonCol = findCol(headers, 'Salesperson');
  return rows
    .slice(0, -1) // drop the totals row (blank Ref)
    .map((row) => {
      const obj = rowToObj(headers, row);
      return {
        ref: (obj[refCol] || '').trim(),
        customerName: (obj[nameCol] || '').trim(),
        value: toNum(obj[valueCol]),
        salesperson: (obj[salespersonCol] || '').trim(),
      };
    })
    .filter((r) => r.ref);
}

// Row-level detail from "Daily Billed Report - Nadine" — every real
// billing event that day, company-wide. Same shape as
// extractBookingRows above plus billedValue, since this report's whole
// purpose is telling us how much of each case's value just got billed.
function extractBilledRows(html) {
  const table = parseTable(html);
  if (!table || table.rows.length === 0) return [];
  const { headers, rows } = table;
  const refCol = findCol(headers, 'Ref');
  const nameCol = findCol(headers, 'Customer Name');
  const valueCol = findCol(headers, 'Sales Value (Total)');
  const billedCol = findCol(headers, 'Sales Value (Total Billed)');
  const salespersonCol = findCol(headers, 'Salesperson');
  return rows
    .slice(0, -1)
    .map((row) => {
      const obj = rowToObj(headers, row);
      return {
        ref: (obj[refCol] || '').trim(),
        customerName: (obj[nameCol] || '').trim(),
        value: toNum(obj[valueCol]),
        billedValue: toNum(obj[billedCol]),
        salesperson: (obj[salespersonCol] || '').trim(),
      };
    })
    .filter((r) => r.ref);
}
```

Update the `module.exports` line at the bottom of the file to include both new parsers, plus `rowToObj` (already defined in this file, not previously exported — Task 3 needs it directly to read the `Customer Code` column these two row-shapes deliberately don't carry):

```js
module.exports = { parseAndAggregate, parseTable, classify, toNum, findCol, rowToObj, extractDailyBookedCustomerNames, extractCaseTotals, extractBookingRows, extractBilledRows };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/evidentReport/parseEvident.test.js`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/services/evidentReport/parseEvident.js test/evidentReport/parseEvident.test.js
git commit -m "Add row-level parsers for Evident's company-wide booking/billed reports"
```

---

### Task 2: Throttled Gmail fetch (quota-safe wide-range fetching)

**Files:**
- Modify: `src/services/evidentReport/gmailFetch.js`
- Test: `test/evidentReport/gmailFetch.test.js` (new file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `sleep(ms)` (exported, a plain `Promise`-based delay helper) and a modified `fetchEvidentEmailsInRange` that awaits `sleep(THROTTLE_MS)` between each individual message fetch. `THROTTLE_MS` is an exported constant so the backfill script (Task 5) and cron job can both reference the same value rather than hardcoding it twice.

This task exists because fetching a wide date range one message at a time tripped Gmail's real per-minute quota during design investigation (confirmed 2026-09-17, `newer_than:365d`). Every consumer of `fetchEvidentEmailsInRange` — this session's new-doctor detection, the week-scoped booked/billed summary, and this feature's backfill — benefits from the same fix in one place.

- [ ] **Step 1: Write the failing test**

Create `test/evidentReport/gmailFetch.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { sleep } = require('../../src/services/evidentReport/gmailFetch');

test('sleep resolves after approximately the requested delay', async () => {
  const start = Date.now();
  await sleep(30);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 25, `expected at least ~30ms to pass, got ${elapsed}ms`);
});

test('sleep(0) resolves immediately without hanging the test', async () => {
  await sleep(0);
  assert.ok(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/evidentReport/gmailFetch.test.js`
Expected: FAIL with "sleep is not a function" (not exported yet)

- [ ] **Step 3: Implement the throttle**

In `src/services/evidentReport/gmailFetch.js`, add near the top (after the `require('googleapis')` line):

```js
// Real per-message delay between fetches in a wide-range pull — Gmail's
// per-minute quota was hit during design investigation for this feature
// (fetching 365 days' worth of messages one at a time). 300ms is a
// starting point, not load-tested at scale; tune upward if the backfill
// script (scripts/backfill-evident-crm-sync.js) still hits quota errors
// in practice.
const THROTTLE_MS = 300

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
```

Modify `fetchEvidentEmailsInRange`'s message-fetching loop to await `sleep(THROTTLE_MS)` after each fetch:

```js
async function fetchEvidentEmailsInRange(extraQuery) {
  const auth = getGmailAuth()
  const gmail = google.gmail({ version: 'v1', auth })
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: `from:support@evidentlabs.com ${extraQuery}`,
    maxResults: 500,
  })
  const ids = (listRes.data.messages || []).map((m) => m.id)

  const messages = []
  for (const id of ids) {
    const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
    const { subject, html } = extractSubjectAndHtml(res.data)
    const date = new Date(Number(res.data.internalDate)).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    messages.push({ subject, html, date })
    await sleep(THROTTLE_MS)
  }
  return messages
}
```

Update the `module.exports` line:

```js
module.exports = { fetchEvidentEmails, fetchEvidentEmailsInRange, extractSubjectAndHtml, sleep, THROTTLE_MS }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/evidentReport/gmailFetch.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/evidentReport/gmailFetch.js test/evidentReport/gmailFetch.test.js
git commit -m "Throttle Gmail message fetches to avoid tripping the per-minute quota"
```

---

### Task 3: Core sync service — doctor resolution and case upserts

**Files:**
- Create: `src/services/evidentCrmSync.js`
- Test: `test/evidentCrmSync.test.js` (new file — pure-function pieces only, per Global Constraints)

**Interfaces:**
- Consumes: `extractBookingRows`, `extractBilledRows` (Task 1), `fetchEvidentEmailsInRange` (existing, from `gmailFetch.js`), `syncClientRevenue(clientName)` (existing, from `../clientRevenue.js`), `db` (existing, `../config/db`).
- Produces: `normalizeDoctorName(name)` (pure, exported for its own test), `resolveRepId(salesperson)` (async, exported), `syncCasesForDate(dateStr)` → `Promise<{ date: string, casesCreated: number, casesUpdated: number, clientsCreated: number, errors: Array<{ ref: string, message: string }> }>` — the one function Tasks 4 and 5 both call.

- [ ] **Step 1: Write the failing test (pure-function pieces only)**

Create `test/evidentCrmSync.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDoctorName } = require('../src/services/evidentCrmSync');

test('normalizeDoctorName lowercases, strips periods/commas, and collapses whitespace', () => {
  assert.equal(normalizeDoctorName('DR BRIAN GOLD'), 'dr brian gold');
  assert.equal(normalizeDoctorName('Dr. Brian Gold'), 'dr brian gold');
  assert.equal(normalizeDoctorName('DR SUSHILA L. CHAHAL, DDS'), 'dr sushila l chahal dds');
  assert.equal(normalizeDoctorName('  Sunset   Terrace  '), 'sunset terrace');
});

test('normalizeDoctorName handles null/undefined without throwing', () => {
  assert.equal(normalizeDoctorName(null), '');
  assert.equal(normalizeDoctorName(undefined), '');
  assert.equal(normalizeDoctorName(''), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/evidentCrmSync.test.js`
Expected: FAIL — cannot find module `../src/services/evidentCrmSync` (file doesn't exist yet)

- [ ] **Step 3: Implement `src/services/evidentCrmSync.js`**

```js
const db = require('../config/db')
const { extractBookingRows, extractBilledRows, parseTable, findCol, rowToObj } = require('./evidentReport/parseEvident')
const { fetchEvidentEmailsInRange } = require('./evidentReport/gmailFetch')
const { syncClientRevenue } = require('./clientRevenue')

// Same lowercase/strip-punctuation/collapse-whitespace normalization
// salesRepDailyReport.js already uses for its own doctor-name matching —
// duplicated here rather than shared, matching this codebase's convention
// for small isolated helpers (see CLAUDE.md's note on this pattern).
function normalizeDoctorName(name) {
  return (name || '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim()
}

// Only two real reps exist in this CRM today — this fixed mapping doesn't
// need to anticipate a third. Any Salesperson value this doesn't
// recognize (blank, a typo, someone new) resolves to unassigned via
// resolveRepId's own fallback below, never an error.
const SALESPERSON_TO_REP_EMAIL = {
  james: 'james@aimdentallab.com',
  william: 'williama@aimdentallab.com',
}

// Resolves an Evident "Salesperson" cell to a real users.id, or null for
// the unassigned/"N/A" case — blank, unrecognized, or the rep genuinely
// not existing in this CRM (shouldn't happen, but never throws over it).
async function resolveRepId(salesperson) {
  const email = SALESPERSON_TO_REP_EMAIL[(salesperson || '').trim().toLowerCase()]
  if (!email) return null
  const { rows } = await db.query(`SELECT id FROM users WHERE email=$1`, [email])
  return rows[0] ? rows[0].id : null
}

// Aim-brand codes look like "A1234"/"A4106"; Kings Highway codes look
// like "KH2132". Evident's own reports don't have a brand field, but the
// Customer Code prefix reliably signals it (verified against real data
// throughout this session) — the existing manual import-evident route
// (cases.js) never derived this and just hardcodes 'Aim Dental' for every
// row; this sync gets it right since Customer Code is already available
// here as part of the raw row (see resolveClientName below).
function brandFromCustomerCode(customerCode) {
  return /^KH/i.test((customerCode || '').trim()) ? 'Kings Highway' : 'Aim Dental'
}

// Finds the existing client by normalized-name match, or creates one.
// Returns { clientName, created } — clientName is the EXACT stored
// clients.doctor_name to use as cases.client_name (matched or
// newly-created; every other join in this codebase relies on that exact
// string match — see cases.js's import-evident route, which this
// mirrors), and `created` tells the caller whether to count this toward
// summary.clientsCreated. assigned_to is set from the resolved repId (see
// resolveRepId above) — null for the N/A bucket, per this feature's
// Global Constraint.
async function resolveClientName(rawDoctorName, customerCode, repId) {
  const doctorName = (rawDoctorName || '').trim()
  if (!doctorName) return { clientName: null, created: false }
  const normalized = normalizeDoctorName(doctorName)

  const { rows } = await db.query(`SELECT doctor_name FROM clients`)
  const match = rows.find((r) => normalizeDoctorName(r.doctor_name) === normalized)
  if (match) return { clientName: match.doctor_name, created: false }

  const brand = brandFromCustomerCode(customerCode)
  await db.query(
    `INSERT INTO clients (doctor_name, brand, total_revenue, case_count, assigned_to, created_at, updated_at)
     VALUES ($1,$2,0,0,$3,NOW(),NOW())`,
    [doctorName, brand, repId]
  )
  return { clientName: doctorName, created: true }
}

// One booking-report row. Only creates a case when evident_case_number
// isn't already known — if it's already in the CRM (from an earlier run,
// or this same day's report re-processed), this is a no-op: booking rows
// never overwrite an already-billed case's status, which billed-row
// processing (below) owns. `customerCode` isn't in extractBookingRows'
// return shape (Task 1's ref/customerName/value/salesperson) — this
// function reads it from the raw row via a second, small lookup baked
// into syncCasesForDate below, not duplicated here.
async function upsertBookingRow(row, customerCode, dateStr) {
  const existing = await db.query(`SELECT id FROM cases WHERE evident_case_number=$1`, [row.ref])
  if (existing.rows[0]) return { created: false, clientName: null, clientCreated: false }

  const repId = await resolveRepId(row.salesperson)
  const { clientName, created: clientCreated } = await resolveClientName(row.customerName, customerCode, repId)
  if (!clientName) return { created: false, clientName: null, clientCreated: false }

  const brand = brandFromCustomerCode(customerCode)
  await db.query(
    `INSERT INTO cases (case_number, client_name, brand, case_type, patient, value, billed_value,
     wip_value, status, evident_case_number, product, stage_history, created_at, updated_at)
     VALUES ($1,$2,$3,'Other','',$4,0,$4,'In Production',$5,'','[]'::jsonb,$6::timestamptz,NOW())`,
    [`EVD-${row.ref}`, clientName, brand, row.value, row.ref, `${dateStr}T00:00:00Z`]
  )
  return { created: true, clientName, clientCreated }
}

// One billed-report row. Updates the existing case if booking already
// created it (the normal case — booking day and billing day are usually
// different, often weeks apart, and booking always runs first). Creates
// it from the billed row alone otherwise — an honest, documented
// limitation for a case whose original booking predates this pipeline's
// coverage (see the spec's "why chronological order matters" section),
// using the billed date as a fallback created_at.
async function upsertBilledRow(row, customerCode, dateStr) {
  const existing = await db.query(`SELECT id, client_name FROM cases WHERE evident_case_number=$1`, [row.ref])
  const status = row.billedValue > 0 ? 'Completed' : 'In Production'
  const wip = Math.max(row.value - row.billedValue, 0)

  if (existing.rows[0]) {
    await db.query(
      `UPDATE cases SET billed_value=$1, wip_value=$2, status=$3, updated_at=NOW() WHERE id=$4`,
      [row.billedValue, wip, status, existing.rows[0].id]
    )
    return { created: false, updated: true, clientName: existing.rows[0].client_name, clientCreated: false }
  }

  const repId = await resolveRepId(row.salesperson)
  const { clientName, created: clientCreated } = await resolveClientName(row.customerName, customerCode, repId)
  if (!clientName) return { created: false, updated: false, clientName: null, clientCreated: false }

  const brand = brandFromCustomerCode(customerCode)
  await db.query(
    `INSERT INTO cases (case_number, client_name, brand, case_type, patient, value, billed_value,
     wip_value, status, evident_case_number, product, stage_history, created_at, updated_at)
     VALUES ($1,$2,$3,'Other','',$4,$5,$6,$7,$8,'','[]'::jsonb,$9::timestamptz,NOW())`,
    [`EVD-${row.ref}`, clientName, brand, row.value, row.billedValue, wip, status, row.ref, `${dateStr}T00:00:00Z`]
  )
  return { created: true, updated: false, clientName, clientCreated }
}

// The one function this whole feature is built around — fetches
// `dateStr`'s two company-wide Evident reports, processes every row, and
// returns a plain summary. Never throws over a single bad row (skipped
// and logged into the returned `errors` array instead) — one malformed
// row must not abort the rest of the day, matching this codebase's
// established best-effort-per-item pattern (see
// sendAllSalesRepDailyReports).
// Gmail's `after:`/`before:` take YYYY/MM/DD and are date-only in the
// account's own timezone — rather than get that boundary exactly right,
// this brackets one full day of slack on each side and relies on
// fetchEvidentEmailsInRange's own per-message `date` (already computed
// correctly via internalDate converted to America/New_York) for the
// precise match below. Critically, this must NOT be `newer_than:1d` —
// that only ever finds yesterday's email, which is fine for the cron job
// (always "today") but would silently return nothing for every
// historical date the backfill script (Task 5) asks for.
function gmailDateBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const after = new Date(Date.UTC(y, m - 1, d))
  after.setUTCDate(after.getUTCDate() - 1)
  const before = new Date(Date.UTC(y, m - 1, d))
  before.setUTCDate(before.getUTCDate() + 2)
  const fmt = (dt) => `${dt.getUTCFullYear()}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${String(dt.getUTCDate()).padStart(2, '0')}`
  return `after:${fmt(after)} before:${fmt(before)}`
}

async function syncCasesForDate(dateStr) {
  const summary = { date: dateStr, casesCreated: 0, casesUpdated: 0, clientsCreated: 0, errors: [] }
  const touchedClientNames = new Set()

  const dateQuery = gmailDateBounds(dateStr)
  const bookingMessages = await fetchEvidentEmailsInRange(`subject:"Daily Booking Report - Nadine" ${dateQuery}`)
  const billedMessages = await fetchEvidentEmailsInRange(`subject:"Daily Billed Report - Nadine" ${dateQuery}`)

  const bookingMsg = bookingMessages.find((m) => m.date === dateStr)
  const billedMsg = billedMessages.find((m) => m.date === dateStr)

  if (bookingMsg) {
    // customerCode lives in the raw table (Task 1's extractBookingRows
    // return shape deliberately doesn't carry it — callers that need it
    // read the table directly here, keeping the parser's public shape
    // focused on what most callers actually use).
    const table = parseTable(bookingMsg.html)
    const codeCol = table ? findCol(table.headers, 'Customer Code') : null
    const refCol = table ? findCol(table.headers, 'Ref') : null
    const codeByRef = new Map()
    if (table) {
      for (const r of table.rows.slice(0, -1)) {
        const obj = rowToObj(table.headers, r)
        codeByRef.set((obj[refCol] || '').trim(), obj[codeCol])
      }
    }

    for (const row of extractBookingRows(bookingMsg.html)) {
      try {
        const result = await upsertBookingRow(row, codeByRef.get(row.ref), dateStr)
        if (result.created) {
          summary.casesCreated++
          if (result.clientName) touchedClientNames.add(result.clientName)
        }
        if (result.clientCreated) summary.clientsCreated++
      } catch (err) {
        summary.errors.push({ ref: row.ref, message: err.message })
      }
    }
  }

  if (billedMsg) {
    const table = parseTable(billedMsg.html)
    const codeCol = table ? findCol(table.headers, 'Customer Code') : null
    const refCol = table ? findCol(table.headers, 'Ref') : null
    const codeByRef = new Map()
    if (table) {
      for (const r of table.rows.slice(0, -1)) {
        const obj = rowToObj(table.headers, r)
        codeByRef.set((obj[refCol] || '').trim(), obj[codeCol])
      }
    }

    for (const row of extractBilledRows(billedMsg.html)) {
      try {
        const result = await upsertBilledRow(row, codeByRef.get(row.ref), dateStr)
        if (result.created) summary.casesCreated++
        if (result.updated) summary.casesUpdated++
        if (result.clientName) touchedClientNames.add(result.clientName)
        if (result.clientCreated) summary.clientsCreated++
      } catch (err) {
        summary.errors.push({ ref: row.ref, message: err.message })
      }
    }
  }

  for (const clientName of touchedClientNames) {
    await syncClientRevenue(clientName)
  }

  return summary
}

module.exports = { normalizeDoctorName, resolveRepId, syncCasesForDate, gmailDateBounds }
```

- [ ] **Step 4: Add a test for the date-boundary helper, then run all tests**

Add to `test/evidentCrmSync.test.js` (update the import line to include `gmailDateBounds`):

```js
const { normalizeDoctorName, gmailDateBounds } = require('../src/services/evidentCrmSync');
```

```js
test('gmailDateBounds brackets the target date with one day of slack on each side', () => {
  assert.equal(gmailDateBounds('2026-09-15'), 'after:2026/09/14 before:2026/09/17');
  // Month/year boundaries, since date math bugs love these.
  assert.equal(gmailDateBounds('2026-01-01'), 'after:2025/12/31 before:2026/01/03');
  assert.equal(gmailDateBounds('2026-02-28'), 'after:2026/02/27 before:2026/03/02');
});
```

Run: `node --test test/evidentCrmSync.test.js`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/evidentCrmSync.js test/evidentCrmSync.test.js
git commit -m "Add core Evident-to-CRM case sync service"
```

---

### Task 4: Going-forward cron job

**Files:**
- Create: `src/jobs/evidentCrmSync.js`
- Modify: `src/index.js`

**Interfaces:**
- Consumes: `syncCasesForDate` (Task 3).
- Produces: `startEvidentCrmSyncScheduler()`, registered alongside the other job starters in `index.js`.

- [ ] **Step 1: Write the job file**

Create `src/jobs/evidentCrmSync.js`, matching the exact shape of `src/jobs/evidentReport.js`:

```js
// src/jobs/evidentCrmSync.js
const cron = require('node-cron')
const { syncCasesForDate } = require('../services/evidentCrmSync')

function todayEasternDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// Weekdays 7am America/New_York — before the 8am Leadership/Sales Rep
// report sends, so by the time those go out the CRM already reflects
// today's real Evident activity. Purely a convenience ordering: the
// reports read live Evident data directly, not through the CRM, so
// nothing breaks if this runs later or fails outright on a given day.
function startEvidentCrmSyncScheduler() {
  cron.schedule(
    '0 7 * * 1-5',
    async () => {
      // Gated behind EVIDENT_CRM_SYNC_ENABLED, same shipped-but-off
      // pattern as every other automated job in this codebase — lets the
      // code ship and be reviewed via a manual single-day run (see
      // scripts/backfill-evident-crm-sync.js, runnable for just today)
      // before it starts writing to the real CRM on its own every day.
      if (process.env.EVIDENT_CRM_SYNC_ENABLED !== 'true') {
        console.log('[evident-crm-sync] scheduled run skipped — EVIDENT_CRM_SYNC_ENABLED is not set to true')
        return
      }
      console.log('[evident-crm-sync] running scheduled sync...')
      try {
        const summary = await syncCasesForDate(todayEasternDateString())
        console.log('[evident-crm-sync] done:', summary)
      } catch (err) {
        console.error('[evident-crm-sync] scheduled run failed:', err)
      }
    },
    { timezone: 'America/New_York' }
  )
  console.log('[evident-crm-sync] job registered')
}

module.exports = { startEvidentCrmSyncScheduler }
```

- [ ] **Step 2: Register the job in `src/index.js`**

Add the import near the other job imports:

```js
const { startEvidentCrmSyncScheduler } = require('./jobs/evidentCrmSync')
```

Add the call near the other scheduler starts (after `startSalesRepDailyReportScheduler()`):

```js
startEvidentCrmSyncScheduler()
```

- [ ] **Step 3: Verify the app still loads**

Run: `node -e "require('./src/app.js'); console.log('app loaded OK')"`
Expected: `app loaded OK`, no thrown errors

- [ ] **Step 4: Commit**

```bash
git add src/jobs/evidentCrmSync.js src/index.js
git commit -m "Register the going-forward Evident CRM sync cron job (disabled by default)"
```

---

### Task 5: One-time historical backfill script

**Files:**
- Create: `scripts/backfill-evident-crm-sync.js`

**Interfaces:**
- Consumes: `syncCasesForDate` (Task 3), `sleep`, `THROTTLE_MS` (Task 2).
- Produces: a runnable CLI script — no other code depends on it.

- [ ] **Step 1: Implement the backfill script**

```js
// scripts/backfill-evident-crm-sync.js
// One-time historical catch-up. Run manually:
//   node scripts/backfill-evident-crm-sync.js --from=2026-01-01 [--to=2026-09-16]
// `--to` defaults to yesterday (today's own sync is the cron job's job,
// not the backfill's). Walks chronologically FORWARD (oldest first) — see
// the design spec's "why chronological order matters" for why this
// matters for billed-after-booked accuracy. Safe to re-run or resume:
// syncCasesForDate is idempotent per day (case upserts keyed by
// evident_case_number; client creation guarded by a name-match lookup).
require('dotenv').config()
const { syncCasesForDate } = require('../src/services/evidentCrmSync')
const { sleep, THROTTLE_MS } = require('../src/services/evidentReport/gmailFetch')

function parseArgs() {
  const args = {}
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=')
    args[key] = value
  }
  return args
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + n)
  return date.toISOString().slice(0, 10)
}

function yesterdayEasternDateString() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  return addDays(today, -1)
}

async function main() {
  const { from, to } = parseArgs()
  if (!from) {
    console.error('Usage: node scripts/backfill-evident-crm-sync.js --from=YYYY-MM-DD [--to=YYYY-MM-DD]')
    process.exit(1)
  }
  const endDate = to || yesterdayEasternDateString()

  console.log(`Backfilling Evident CRM sync from ${from} through ${endDate}...`)
  const totals = { casesCreated: 0, casesUpdated: 0, clientsCreated: 0, errors: 0 }
  const failedDates = []

  let cur = from
  while (cur <= endDate) {
    try {
      const summary = await syncCasesForDate(cur)
      totals.casesCreated += summary.casesCreated
      totals.casesUpdated += summary.casesUpdated
      totals.clientsCreated += summary.clientsCreated
      totals.errors += summary.errors.length
      console.log(`${cur}: +${summary.casesCreated} cases created, ${summary.casesUpdated} updated, +${summary.clientsCreated} clients created, ${summary.errors.length} row errors`)
      if (summary.errors.length > 0) {
        console.log(`  row errors: ${JSON.stringify(summary.errors)}`)
      }
    } catch (err) {
      console.error(`${cur}: FAILED — ${err.message}`)
      failedDates.push(cur)
    }
    cur = addDays(cur, 1)
    await sleep(THROTTLE_MS)
  }

  console.log('\n--- Backfill complete ---')
  console.log(`Total: ${totals.casesCreated} cases created, ${totals.casesUpdated} updated, ${totals.clientsCreated} clients created, ${totals.errors} row errors`)
  if (failedDates.length > 0) {
    console.log(`Dates that failed entirely (retry these individually with --from=X --to=X): ${failedDates.join(', ')}`)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
```

- [ ] **Step 2: Verify the script loads without syntax errors**

Run: `node -e "require('./scripts/backfill-evident-crm-sync.js')" --from=2099-01-01 --to=2099-01-01 2>&1 | head -5`
Expected: no `SyntaxError`/`Cannot find module` — it's fine if it then tries to run against a fake future date and logs zero results, since there's no real Evident data for 2099; this step only confirms the file itself is well-formed and its requires resolve.

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-evident-crm-sync.js
git commit -m "Add one-time historical backfill script for the Evident CRM sync"
```

---

### Task 6: Single-real-day verification (required before any real backfill)

**Files:** none — this task runs the code from Tasks 1-5 against one real date and reports results. No code changes.

**Interfaces:**
- Consumes: `syncCasesForDate` (Task 3).

Per the design spec's rollout section and this project's own [[feedback-scope-writes-against-prod]] rule (no staging DB exists — verify with one real record before any real sweep): before the historical backfill runs at scale, or the cron job is ever enabled, `syncCasesForDate` must be proven correct against exactly one real day, with results shown to the user.

- [ ] **Step 1: Pick a real date to verify against**

Choose a recent date already known from this session to have real, inspected data — 2026-09-15 (Dr. Alberto Gonzalez's real William-attributed booking, and real N/A-bucket rows, were both directly confirmed on this date earlier in this project).

- [ ] **Step 2: Run the sync for that one date only**

```bash
node -e "
require('dotenv').config();
const { syncCasesForDate } = require('./src/services/evidentCrmSync');
syncCasesForDate('2026-09-15').then(summary => {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
"
```

(Run with the real `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN` env vars set inline, same as every other real Gmail-touching command this session — never written to a file.)

- [ ] **Step 3: Inspect the real results**

Query the CRM directly to confirm the sync did what it claims:

```bash
node -e "
require('dotenv').config();
const db = require('./src/config/db');
db.query(\`SELECT case_number, client_name, evident_case_number, value, billed_value, status, created_at FROM cases WHERE created_at::date = '2026-09-15' ORDER BY created_at DESC LIMIT 20\`)
  .then(r => { console.log(r.rows); process.exit(0); });
"
```

Spot-check: does Dr. Alberto Gonzalez's real case (evident_case_number `5663`, seen throughout this session) appear correctly, assigned to William? Does at least one real N/A-bucket case appear with `assigned_to` unset on its client row?

- [ ] **Step 4: Report results to the user and get explicit confirmation**

Show the user the summary from Step 2 and the spot-check from Step 3. Do not proceed to a real historical backfill or enable the cron job (`EVIDENT_CRM_SYNC_ENABLED=true`) until they've explicitly confirmed this looks correct — same standing rule this whole project has followed for every other real-data-writing action.

- [ ] **Step 5: (Only after explicit confirmation) run the real historical backfill**

```bash
node scripts/backfill-evident-crm-sync.js --from=<admin-supplied start date>
```

Report the final summary (total cases created/updated, any failed dates) back to the user.
