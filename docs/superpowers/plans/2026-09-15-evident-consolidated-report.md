# Evident Consolidated Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the standalone `evident-report-project`'s Evident Labs
consolidated-report pipeline into `aim-crm-backend`, so it sends a daily
leadership report using the CRM's existing email identity, database, and
deployment instead of running as a separate one-off automation.

**Architecture:** A new `src/services/evidentReport/` module set
(read-only Gmail fetch → ported parse/build logic → Postgres history log →
PDF render → the CRM's existing `sendEmail()`), triggered by a new
`src/jobs/evidentReport.js` cron job (weekdays 6am America/New_York, same
in-process pattern as `mediaCleanup.js`/`socialTokenRefresh.js`) and
reachable on demand via a new admin-only route for manual testing.

**Tech Stack:** Node.js (CommonJS, no build step), `googleapis` (already a
dependency), `node-cron` (already a dependency), `puppeteer-core` +
`@sparticuz/chromium` (new), Postgres via the existing `pg` pool.

**Spec:** `docs/superpowers/specs/2026-09-15-evident-consolidated-report-design.md`

## Global Constraints

- No build step, plain CommonJS `require()`/`module.exports` throughout —
  match every existing file's style exactly.
- `src/jobs/scheduler.js` must not be touched (has real in-progress
  unrelated work) — the new cron job is its own file, per the existing
  `mediaCleanup.js`/`socialTokenRefresh.js` pattern.
- `parseEvident.js` and `buildReport.js` are ported **verbatim** — do not
  "improve," rename fields, or restructure them. They are already correct
  and under test against real data; any behavior change here is out of
  scope.
- PDF dependencies are pinned to exact versions for CommonJS compatibility:
  `puppeteer-core@24.43.1` and `@sparticuz/chromium@133.0.0`. Do not install
  `puppeteer-core@latest` or `@sparticuz/chromium@latest` — both switched
  to ESM-only in later releases (`puppeteer-core` at 25.x,
  `@sparticuz/chromium` at 137.x) and will break `require()` in this
  codebase.
- Recipients (`ben@aimdentallab.com`, `execassistant@aimdentallab.com`,
  `yoel@khdentallab.com`) are a hardcoded array in
  `src/services/evidentReport/index.js`, not an env var or DB-configured
  list — matches how `weeklyRepReport.js`'s `REPORT_CC` is a hardcoded
  constant in this codebase.
- No live Gmail credentials exist yet (the one-time OAuth consent flow is a
  manual step for the user, outside this plan's scope — see the spec's
  "Gmail OAuth setup" section). Every task below must be completable and
  independently verifiable without live `GOOGLE_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`
  — the final live-credentials test send happens after this plan is fully
  executed, not as one of its tasks.
- Any DB write used for verification during implementation must use one
  synthetic record that gets cleaned up immediately after — this project
  has no staging database; all testing happens against the real production
  Postgres instance.

---

### Task 1: Database migration for the day-over-day log

**Files:**
- Create: `scripts/v19-evident-report-log-migration.sql`

**Interfaces:**
- Produces: table `evident_report_log` with columns
  `date` (date, unique), `booked_daily_count` (integer),
  `booked_daily_value` (numeric), `booked_mtd_count` (integer),
  `booked_mtd_billed` (numeric), `booked_mtd_wip` (numeric),
  `booked_mtd_value` (numeric), `wip_cases` (integer), `wip_value` (numeric),
  `aim_wip_value` (numeric), `kh_wip_value` (numeric),
  `james_wip_value` (numeric), `william_wip_value` (numeric),
  `created_at` (timestamptz). Every later task's DB access goes through
  this table.

- [ ] **Step 1: Write the migration**

```sql
-- v19-evident-report-log-migration.sql
-- Day-over-day log for the Evident Consolidated Report (see
-- docs/superpowers/specs/2026-09-15-evident-consolidated-report-design.md).
-- Same column set as the standalone evident-report-project's Google Sheet
-- log, so buildReport.js's delta logic needed no changes when ported.

CREATE TABLE IF NOT EXISTS evident_report_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL UNIQUE,
  booked_daily_count integer NOT NULL DEFAULT 0,
  booked_daily_value numeric NOT NULL DEFAULT 0,
  booked_mtd_count integer NOT NULL DEFAULT 0,
  booked_mtd_billed numeric NOT NULL DEFAULT 0,
  booked_mtd_wip numeric NOT NULL DEFAULT 0,
  booked_mtd_value numeric NOT NULL DEFAULT 0,
  wip_cases integer NOT NULL DEFAULT 0,
  wip_value numeric NOT NULL DEFAULT 0,
  aim_wip_value numeric NOT NULL DEFAULT 0,
  kh_wip_value numeric NOT NULL DEFAULT 0,
  james_wip_value numeric NOT NULL DEFAULT 0,
  william_wip_value numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Apply the migration**

This repo's migrations are applied by hand in the Supabase SQL editor (per
`Backend`'s README/CLAUDE.md convention — there is no migration-runner
script). Apply this SQL against the real database using the connection
already configured in `.env`'s `DATABASE_URL`, via a one-off Node script
(the same pattern used for every ad hoc DB check in this project):

```bash
node -e "
require('dotenv').config();
const fs = require('fs');
const db = require('./src/config/db');
(async () => {
  await db.query(fs.readFileSync('scripts/v19-evident-report-log-migration.sql', 'utf-8'));
  console.log('migration applied');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```

- [ ] **Step 3: Verify**

```bash
node -e "
require('dotenv').config();
const db = require('./src/config/db');
(async () => {
  const { rows } = await db.query(\"SELECT to_regclass('public.evident_report_log') as exists\");
  console.log(rows);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```
Expected: `[ { exists: 'evident_report_log' } ]`.

- [ ] **Step 4: Commit**

```bash
git add scripts/v19-evident-report-log-migration.sql
git commit -m "Add evident_report_log table for the Evident Consolidated Report"
```

---

### Task 2: Port parseEvident.js and buildReport.js, plus their tests

**Files:**
- Create: `src/services/evidentReport/parseEvident.js`
- Create: `src/services/evidentReport/buildReport.js`
- Create: `test/evidentReport/parseEvident.test.js`
- Create: `test/evidentReport/fixtures/daily-booked-james.html`
- Create: `test/evidentReport/fixtures/daily-booked-william-nodata.html`
- Create: `test/evidentReport/fixtures/mtd-booked-james.html`
- Create: `test/evidentReport/fixtures/mtd-booked-william.html`
- Create: `test/evidentReport/fixtures/wip-cases-in-progress.html`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Produces: `parseAndAggregate(messages, { runDate })` and `buildEmail(agg, historyRows)`,
  used by Task 6's orchestrator. `buildEmail` returns
  `{ subject, html, sheetRow }` where `sheetRow` has exactly the column
  names Task 1's table uses (this is what makes Task 4's `log.js` a thin
  adapter, not a rewrite).

- [ ] **Step 1: Copy the two pure-function modules verbatim**

Copy the full, unmodified contents of
`/Users/nklimjoco/Downloads/evident-report-project/src/parseEvident.js`
to `src/services/evidentReport/parseEvident.js`, and
`/Users/nklimjoco/Downloads/evident-report-project/src/buildReport.js`
to `src/services/evidentReport/buildReport.js`. Byte-for-byte — no
changes, no renamed fields, no reformatting.

- [ ] **Step 2: Copy the test and fixtures**

Copy `/Users/nklimjoco/Downloads/evident-report-project/test/parseEvident.test.js`
to `test/evidentReport/parseEvident.test.js`, and every file under
`/Users/nklimjoco/Downloads/evident-report-project/test/fixtures/` to
`test/evidentReport/fixtures/`. The test file uses
`path.join(__dirname, 'fixtures', name)` and
`require('../src/parseEvident')` / `require('../src/buildReport')` —
update only the two `require` paths (to `../../src/services/evidentReport/parseEvident`
and `../../src/services/evidentReport/buildReport`, since the test now
lives two directories deeper than in the standalone project); the
`fixture()` helper's relative path to `fixtures/` needs no change since
the fixtures move alongside the test file.

- [ ] **Step 3: Wire up `npm test`**

`package.json`'s `test` script is currently a stub
(`"echo \"Error: no test specified\" && exit 1"`) — this is the first real
test suite in this repo. Change it to:

```json
"test": "node --test test/evidentReport/"
```

- [ ] **Step 4: Run the tests**

```bash
npm test
```

Expected: `tests 5`, `pass 5`, `fail 0` — the exact same 5 assertions that
already pass in the standalone project (verified there before this task
started). A failure here means something broke in the move (a `require`
path, a fixture not copied correctly) — not a reason to modify
`parseEvident.js`/`buildReport.js` themselves.

- [ ] **Step 5: Commit**

```bash
git add src/services/evidentReport/parseEvident.js src/services/evidentReport/buildReport.js test/evidentReport/ package.json
git commit -m "Port parseEvident.js and buildReport.js from the standalone Evident report project"
```

---

### Task 3: Gmail read-only fetch module

**Files:**
- Create: `src/services/evidentReport/gmailFetch.js`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `googleapis` (already a `package.json` dependency, used
  elsewhere by `src/services/sheets.js`).
- Produces: `fetchEvidentEmails()` returning `Promise<{subject: string, html: string}[]>`,
  used by Task 6's orchestrator. Reads `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` from `process.env`
  directly (no central config loader in this codebase — matches how
  `email.js` reads `process.env.RESEND_FROM` directly).

- [ ] **Step 1: Write the module**

```js
// src/services/evidentReport/gmailFetch.js
const { google } = require('googleapis')

// Read-only Gmail fetch, ported from the standalone evident-report-project's
// gmail.js with its send half removed entirely (sending now goes through
// this repo's existing services/email.js instead of the Gmail API) — so
// the OAuth client here only ever needs the gmail.readonly scope. See
// docs/superpowers/specs/2026-09-15-evident-consolidated-report-design.md
// for the one-time OAuth consent-flow setup that produces
// GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN.

function decodeBase64Url(data) {
  if (!data) return ''
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf-8')
}

function findHtmlPart(part) {
  if (!part) return ''
  if (part.mimeType === 'text/html' && part.body && part.body.data) {
    return decodeBase64Url(part.body.data)
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) {
      const found = findHtmlPart(p)
      if (found) return found
    }
  }
  return ''
}

function extractSubjectAndHtml(message) {
  const headers = (message.payload && message.payload.headers) || []
  const subjectHeader = headers.find((h) => h.name.toLowerCase() === 'subject')
  const subject = subjectHeader ? subjectHeader.value : ''

  let html = ''
  if (message.payload) {
    if (message.payload.mimeType === 'text/html' && message.payload.body && message.payload.body.data) {
      html = decodeBase64Url(message.payload.body.data)
    } else {
      html = findHtmlPart(message.payload)
    }
  }
  if (!html) html = message.snippet || ''
  return { subject, html }
}

function getGmailAuth() {
  const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET)
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return client
}

// Fetches every Evident Labs email received in roughly the last day and
// returns them as plain {subject, html} pairs, ready for parseEvident.js.
async function fetchEvidentEmails() {
  const auth = getGmailAuth()
  const gmail = google.gmail({ version: 'v1', auth })
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: 'from:support@evidentlabs.com newer_than:1d',
  })
  const ids = (listRes.data.messages || []).map((m) => m.id)

  const messages = []
  for (const id of ids) {
    const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
    messages.push(extractSubjectAndHtml(res.data))
  }
  return messages
}

module.exports = { fetchEvidentEmails, extractSubjectAndHtml }
```

- [ ] **Step 2: Document the new env vars**

Add to `.env.example` (near the other Google-related vars, after the
existing Google Sheets section if one exists, otherwise at the end):

```bash
# Evident Consolidated Report — Gmail read-only access to
# media@aimdentallab.com (see docs/superpowers/specs/2026-09-15-evident-consolidated-report-design.md
# for the one-time OAuth consent-flow setup). Requires only the
# gmail.readonly scope — sending goes through RESEND_FROM above instead.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
```

- [ ] **Step 3: Verify**

```bash
node -c src/services/evidentReport/gmailFetch.js
```
Expected: no output (valid syntax). Live credentials don't exist yet, so
`fetchEvidentEmails()` itself can't be exercised in this task — Task 6's
orchestrator and the final manual test-send (after this plan is fully
implemented) are what actually call it against real data.

- [ ] **Step 4: Commit**

```bash
git add src/services/evidentReport/gmailFetch.js .env.example
git commit -m "Add read-only Gmail fetch for the Evident Consolidated Report"
```

---

### Task 4: Postgres-backed history log

**Files:**
- Create: `src/services/evidentReport/log.js`

**Interfaces:**
- Consumes: `evident_report_log` table (Task 1), `src/config/db.js`'s
  pool (`db.query(sql, params)`, same pattern used throughout this repo).
- Produces: `getHistory()` → `Promise<object[]>` (rows keyed by column
  name, e.g. `{ date: '2026-09-14', wip_value: '46709.54', ... }` — `pg`
  returns `numeric` columns as strings, same as the standalone project's
  Sheet cells did) and `appendRow(row)` → `Promise<void>`, both consumed
  by Task 6's orchestrator via `buildEmail`'s `historyRows`/`sheetRow`
  shapes from Task 2.

- [ ] **Step 1: Write the module**

```js
// src/services/evidentReport/log.js
const db = require('../../config/db')

// Postgres-backed replacement for the standalone project's Google-Sheets
// log (sheetsLog.js). Same getHistory()/appendRow() shape buildReport.js
// already expects, so buildReport.js itself needed no changes — pg
// returns numeric/integer columns as strings, same as Sheet cells did,
// and buildReport.js already calls Number() on everything it compares.

async function getHistory() {
  const { rows } = await db.query('SELECT * FROM evident_report_log ORDER BY date DESC')
  return rows
}

// The table's UNIQUE constraint on `date` means a same-day re-run of the
// pipeline fails loudly here (a real Postgres unique-violation error)
// rather than silently duplicating or overwriting a day's figures — this
// job should only ever run once per day.
async function appendRow(row) {
  await db.query(
    `INSERT INTO evident_report_log
     (date, booked_daily_count, booked_daily_value, booked_mtd_count, booked_mtd_billed,
      booked_mtd_wip, booked_mtd_value, wip_cases, wip_value, aim_wip_value, kh_wip_value,
      james_wip_value, william_wip_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      row.date, row.booked_daily_count, row.booked_daily_value, row.booked_mtd_count,
      row.booked_mtd_billed, row.booked_mtd_wip, row.booked_mtd_value, row.wip_cases,
      row.wip_value, row.aim_wip_value, row.kh_wip_value, row.james_wip_value, row.william_wip_value,
    ]
  )
}

module.exports = { getHistory, appendRow }
```

- [ ] **Step 2: Verify against one synthetic row**

No staging database exists — test with exactly one synthetic record
against the real DB, then delete it immediately (per this repo's
established testing convention).

```bash
node -e "
require('dotenv').config();
const { getHistory, appendRow } = require('./src/services/evidentReport/log');
const db = require('./src/config/db');
(async () => {
  await appendRow({
    date: '2026-01-01', booked_daily_count: 1, booked_daily_value: 100,
    booked_mtd_count: 1, booked_mtd_billed: 50, booked_mtd_wip: 50, booked_mtd_value: 100,
    wip_cases: 1, wip_value: 100, aim_wip_value: 100, kh_wip_value: 0,
    james_wip_value: 100, william_wip_value: 0,
  });
  const history = await getHistory();
  console.log('found synthetic row:', history.some(r => r.date && r.date.toISOString().slice(0,10) === '2026-01-01'));
  await db.query(\"DELETE FROM evident_report_log WHERE date = '2026-01-01'\");
  console.log('cleaned up');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```
Expected: `found synthetic row: true`, then `cleaned up`.

- [ ] **Step 3: Commit**

```bash
git add src/services/evidentReport/log.js
git commit -m "Add Postgres-backed history log for the Evident Consolidated Report"
```

---

### Task 5: PDF rendering (puppeteer-core + @sparticuz/chromium)

**Files:**
- Create: `src/services/evidentReport/pdf.js`
- Modify: `package.json` (new dependencies)

**Interfaces:**
- Produces: `renderPdf(html)` → `Promise<Buffer>`, consumed by Task 6's
  orchestrator's try/catch-wrapped PDF step.

- [ ] **Step 1: Install the pinned dependencies**

```bash
npm install --save puppeteer-core@24.43.1 @sparticuz/chromium@133.0.0
```

Do not let this float to `@latest` — see this plan's Global Constraints
for why (both packages went ESM-only in later major versions, which
`require()` cannot load in this CommonJS codebase).

- [ ] **Step 2: Write the module**

```js
// src/services/evidentReport/pdf.js
const chromium = require('@sparticuz/chromium')
const puppeteer = require('puppeteer-core')

// puppeteer-core + @sparticuz/chromium instead of full puppeteer's own
// bundled Chromium: aim-crm-backend deploys to Render as a native Node
// web service (no Dockerfile), which is missing the system shared
// libraries (libnss3, libgbm1, libatk-bridge2.0-0, etc.) full puppeteer's
// Chromium needs to launch — @sparticuz/chromium is a Chromium build made
// specifically for restricted/serverless Linux environments like this one,
// and avoids migrating this shared production service to a Docker deploy
// just for one feature.
async function renderPdf(html) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
    })
  } finally {
    await browser.close()
  }
}

module.exports = { renderPdf }
```

- [ ] **Step 3: Smoke-test locally**

This module needs no live Evident/Gmail credentials — it's pure HTML-in,
PDF-out, so it's fully testable now:

```bash
node -e "
const { renderPdf } = require('./src/services/evidentReport/pdf');
(async () => {
  const buf = await renderPdf('<h1>Test</h1><p>Evident report PDF smoke test.</p>');
  console.log('buffer length:', buf.length);
  console.log('starts with %PDF:', buf.slice(0, 4).toString() === '%PDF');
  process.exit(0);
})().catch(e => { console.error('PDF render failed:', e); process.exit(1); });
"
```
Expected: a nonzero buffer length and `starts with %PDF: true`.

**Note:** this confirms Chromium launches successfully on your local
macOS dev machine. It does **not** by itself confirm it will launch on
Render's Linux environment — that's confirmed by the full manual
test-send after this plan is complete (see the plan's closing section).
If it fails locally, that's a real problem to fix now; if it only fails on
Render later, Task 6's try/catch means the daily email still sends
HTML-only rather than breaking entirely, and Render's logs will show the
exact error to debug next.

- [ ] **Step 4: Commit**

```bash
git add src/services/evidentReport/pdf.js package.json package-lock.json
git commit -m "Add PDF rendering for the Evident Consolidated Report (puppeteer-core + @sparticuz/chromium)"
```

---

### Task 6: Orchestrator

**Files:**
- Create: `src/services/evidentReport/index.js`

**Interfaces:**
- Consumes: `fetchEvidentEmails()` (Task 3), `parseAndAggregate()` /
  `buildEmail()` (Task 2), `getHistory()` / `appendRow()` (Task 4),
  `renderPdf()` (Task 5), `sendEmail()` (existing `src/services/email.js`).
- Produces: `runEvidentReport()` → `Promise<{ aggregate, subject }>`, used
  by Task 7's cron job and Task 8's manual-send route.

- [ ] **Step 1: Write the module**

```js
// src/services/evidentReport/index.js
const { fetchEvidentEmails } = require('./gmailFetch')
const { parseAndAggregate } = require('./parseEvident')
const { buildEmail } = require('./buildReport')
const { getHistory, appendRow } = require('./log')
const { renderPdf } = require('./pdf')
const { sendEmail } = require('../email')

const RECIPIENTS = ['ben@aimdentallab.com', 'execassistant@aimdentallab.com', 'yoel@khdentallab.com']

// Runs the full pipeline once: fetch → parse → build → render → send →
// log. Used both by jobs/evidentReport.js's daily cron and the admin
// manual test-send route (routes/reports.js's POST /evident-report/send).
async function runEvidentReport() {
  console.log('[evident-report] fetching last night\'s Evident emails...')
  const messages = await fetchEvidentEmails()
  console.log(`[evident-report] found ${messages.length} Evident email(s)`)

  const aggregate = parseAndAggregate(messages)
  if (aggregate.missing.length > 0) {
    console.warn(`[evident-report] missing reports: ${aggregate.missing.join(', ')}`)
  }

  console.log('[evident-report] reading history log...')
  const historyRows = await getHistory()

  const { subject, html, sheetRow } = buildEmail(aggregate, historyRows)

  // Best-effort: a PDF failure shouldn't block the report from sending at
  // all — it sends HTML-only instead, loudly logged, never silent.
  let pdfBuffer = null
  try {
    console.log('[evident-report] rendering PDF...')
    pdfBuffer = await renderPdf(html)
  } catch (err) {
    console.error('[evident-report] PDF render failed, sending HTML-only:', err)
  }

  const finalHtml = pdfBuffer
    ? html
    : html.replace(
        'A PDF copy of this report is attached.',
        'PDF attachment unavailable for this run — figures above are unaffected.'
      )

  console.log(`[evident-report] sending to ${RECIPIENTS.join(', ')}...`)
  await sendEmail({
    to: RECIPIENTS,
    subject,
    html: finalHtml,
    ...(pdfBuffer
      ? { attachments: [{ filename: `evident-report-${aggregate.runDate}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }] }
      : {}),
  })

  console.log('[evident-report] logging today\'s totals...')
  await appendRow(sheetRow)

  console.log('[evident-report] done.')
  return { aggregate, subject }
}

module.exports = { runEvidentReport }
```

- [ ] **Step 2: Verify**

```bash
node -c src/services/evidentReport/index.js
```
Expected: no output (valid syntax; `require`s resolve — this alone catches
a typo'd path in any of Tasks 2–5's modules).

- [ ] **Step 3: Commit**

```bash
git add src/services/evidentReport/index.js
git commit -m "Add orchestrator for the Evident Consolidated Report pipeline"
```

---

### Task 7: Cron job registration

**Files:**
- Create: `src/jobs/evidentReport.js`
- Modify: `src/index.js`

**Interfaces:**
- Consumes: `runEvidentReport()` (Task 6).
- Produces: `startEvidentReportScheduler()`, called from `src/index.js`'s
  `app.listen` callback alongside the other three job starters.

- [ ] **Step 1: Write the job file**

```js
// src/jobs/evidentReport.js
const cron = require('node-cron')
const { runEvidentReport } = require('../services/evidentReport')

// Deliberately its own file, not added to jobs/scheduler.js — that file
// has real in-progress unrelated work and must not be touched. Same
// pattern as jobs/mediaCleanup.js and jobs/socialTokenRefresh.js.
function startEvidentReportScheduler() {
  // Weekdays 6am America/New_York — matches the standalone project's
  // original schedule (after Evident's overnight reports land, before
  // the start of the business day).
  cron.schedule(
    '0 6 * * 1-5',
    async () => {
      console.log('[evident-report] Running scheduled daily run')
      try {
        await runEvidentReport()
      } catch (err) {
        console.error('[evident-report] scheduled run failed:', err)
      }
    },
    { timezone: 'America/New_York' }
  )
  console.log('[evident-report] job registered')
}

module.exports = { startEvidentReportScheduler }
```

- [ ] **Step 2: Wire it into `src/index.js`**

In `src/index.js`, add the require alongside the other three job
imports, and the call alongside the other three job starters:

```js
const { startEvidentReportScheduler } = require('./jobs/evidentReport')
```

```js
app.listen(PORT, () => {
  console.log(`Aim Dental CRM backend running on port ${PORT}`)
  startScheduler()
  startMediaCleanupScheduler()
  startSocialTokenRefreshScheduler()
  startEvidentReportScheduler()
})
```

- [ ] **Step 3: Verify**

```bash
node -c src/jobs/evidentReport.js && node -c src/index.js
```
Expected: no output for either.

Then start the server locally and confirm the job registers without
crashing the process (it will log the "job registered" line and then sit
idle until the cron fires — it should not attempt to run the pipeline
immediately on boot):

```bash
node src/index.js &
sleep 2
curl -s http://localhost:4000/health
kill %1
```
Expected: `{"status":"ok"}`, and `[evident-report] job registered` present
in the server's stdout from the `node src/index.js` invocation above.

- [ ] **Step 4: Commit**

```bash
git add src/jobs/evidentReport.js src/index.js
git commit -m "Register the Evident Consolidated Report's daily cron job"
```

---

### Task 8: Admin manual test-send route

**Files:**
- Modify: `src/routes/reports.js`

**Interfaces:**
- Consumes: `runEvidentReport()` (Task 6).
- Produces: `POST /api/reports/evident-report/send` (admin-only), the
  route used for the final live-credentials verification after this plan
  is complete.

- [ ] **Step 1: Add the import**

In `src/routes/reports.js`, add alongside the existing
`weeklyRepReport`/`unassignedLeadsReport` imports near the top of the
file:

```js
const { runEvidentReport } = require('../services/evidentReport')
```

- [ ] **Step 2: Add the route**

Add near the other manual-send routes (`POST /weekly-rep-report/send`,
`POST /unassigned-leads-report/send`):

```js
// POST /api/reports/evident-report/send — admin-only manual trigger, runs
// the full pipeline once (fetch → parse → build → PDF → send → log) and
// reports which stage it reached. No `test`/redirect flag like the other
// manual-send routes have — unlike a per-rep report, there's no
// alternate target to redirect this to; it always sends to the real
// recipients and logs against the real day. evident_report_log.date's
// UNIQUE constraint means a same-day re-run fails loudly (a clear error
// response) rather than silently duplicating or overwriting that day's
// figures.
router.post('/evident-report/send', auth, requireAdmin, async (req, res, next) => {
  try {
    const result = await runEvidentReport()
    res.json({ success: true, subject: result.subject, missing: result.aggregate.missing })
  } catch (err) { next(err) }
})
```

- [ ] **Step 3: Verify**

```bash
node -c src/routes/reports.js
```
Expected: no output. Full functional verification (an actual `POST`) is
not possible in this task — it requires live Gmail credentials that don't
exist yet — and happens in the final manual test-send below.

- [ ] **Step 4: Commit**

```bash
git add src/routes/reports.js
git commit -m "Add admin manual test-send route for the Evident Consolidated Report"
```

---

## After this plan is complete

Two things remain that are **not** part of this plan's tasks, because
neither can be done by an implementer without the user directly:

1. **Gmail OAuth consent flow** — the user completes the one-time setup
   in the design spec's "Gmail OAuth setup" section (Google Cloud project,
   OAuth client, `gmail.readonly` consent screen scope, OAuth Playground
   token exchange, signed in as `media@aimdentallab.com`), then sets
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN` as
   Render env vars on `aim-crm-backend`.
2. **Live manual test-send** — once those env vars are set and deployed,
   call `POST /api/reports/evident-report/send` (admin auth required) once.
   This is the first real end-to-end run: it will show whether
   `@sparticuz/chromium` actually launches on Render (Task 5's local smoke
   test only proves it launches on macOS), whether the parsed figures
   match what's actually in the inbox that morning, and it creates the
   first row in `evident_report_log` — a second real day's run afterward
   is what proves the day-over-day delta math end-to-end, matching the
   spec's "done" criteria.

Once that live run is confirmed working, the standalone
`evident-report-project/`, its abandoned `n8n-workflow.json`, and the
`gotenberg` container entry in
`~/Documents/n8n-selfhosted/docker-compose.yml` are safe to remove — flag
this to the user rather than deleting anything unprompted (per the spec).
