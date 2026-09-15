# Sales Rep Daily Report + Leadership Report Evolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Weekly Rep Report with a new personalized **Sales Rep
Daily Report** (per-doctor submitted/not-submitted today + weekly
new-doctor goal progress), and evolve the existing Evident Consolidated
Report into a renamed **AIM Leadership Report** with a Yearly Billed tile
and a 30-day booked/billed trend chart.

**Architecture:** Part 1 adds a new `src/services/salesRepDailyReport.js`
module (real-data queries against `clients`/`cases`/`goals` → HTML build →
the CRM's existing `sendEmail()`), a new `src/jobs/salesRepDailyReport.js`
cron file, and new admin routes in `src/routes/reports.js` — then retires
`weeklyRepReport.js`'s automated leadership-cc'd send (`sendAllWeeklyRepReports`,
its two admin routes, its scheduler.js cron block). `weeklyRepReport.js`
itself stays, since `computeRepSummary`/`sendRepWeeklyReport` also power
three unrelated, still-live self-service Frontend features (`/my-summary`,
`/my-summary/csv`, `/my-summary/email`) not mentioned in the design spec —
see Task 7's scoping note. Part 2 makes additive
changes to the existing `src/services/evidentReport/` module set: extends
`parseEvident.js` to also parse Evident's YTD Booked Cases email, adds a
Yearly Billed tile to `buildReport.js`, and adds a new
`src/services/evidentReport/chart.js` QuickChart URL builder.

**Tech Stack:** Node.js (CommonJS, no build step), Postgres via the
existing `pg` pool, `node-cron` (already a dependency), QuickChart.io (new,
but zero-dependency — a plain URL, no client library).

**Spec:** `docs/superpowers/specs/2026-09-15-sales-rep-daily-and-leadership-report-design.md`

## Global Constraints

- No build step, plain CommonJS `require()`/`module.exports` throughout —
  match every existing file's style exactly.
- `src/jobs/scheduler.js` gets a **scoped, deliberate exception** to this
  codebase's usual "never touch scheduler.js" rule (Task 7 removes exactly
  one `cron.schedule(...)` block — the Weekly Rep Report's — and nothing
  else in that file). This is explicitly called out in the design spec as
  safe because it retires dead code this plan is directly tasked with
  retiring, not unrelated in-progress work.
- `parseEvident.js` and `buildReport.js`'s **existing** `dailyBooked`/
  `mtdBooked`/`wip` parsing logic must not change — Task 9 adds a new
  `ytdBooked` branch alongside it, duplicating the existing per-rep
  parsing block rather than refactoring it into a shared helper, so the 5
  existing fixture-based tests keep passing unchanged and byte-for-byte
  identical to today.
- Recipients are hardcoded constants, matching this codebase's existing
  `REPORT_CC` pattern (`weeklyRepReport.js`, `unassignedLeadsReport.js`,
  `evidentReport/index.js`) — never an env var or DB-configured list:
  - Sales Rep Daily Report: `to` = the rep's own address (James Delaney
    `james@aimdentallab.com` / William Alexander `williama@aimdentallab.com`
    only, looked up by email — **not** a `role IN ('staff','sales_rep')`
    query, which would also catch Yoel Klein and the TEST ACCOUNT, both
    `sales_rep` but neither a real AIM rep for this report), `cc` = Yoel
    Klein (`yoel@khdentallab.com`).
  - Leadership Report: unchanged `to` list, `bcc` gets
    `media@aimdentallab.com` added.
- Both new automated sends are gated behind an env var, default unset,
  documented in `.env.example` (matching `EVIDENT_REPORT_ENABLED`'s
  already-documented pattern) — `SALES_REP_DAILY_REPORT_ENABLED`. Code
  ships and is reviewable via the admin manual-send route; the real
  weekday automated send stays off until that var is explicitly set to
  `'true'` on Render.
- Per this session's [[feedback-preview-before-leadership-sends]] working
  agreement: once built, send a `test:true` preview of both reports to
  your own inbox and get explicit sign-off before ever setting either
  `*_ENABLED` var to `'true'` on Render — this plan's tasks stop at
  "buildable and verified," not "turned on for real recipients."
- No staging database exists — every DB-touching verification step in this
  plan uses exactly one synthetic record against the real production
  Postgres instance, cleaned up immediately after (per this repo's
  established testing convention, e.g. the Evident report's `log.js` task).
  Synthetic rows use the TEST ACCOUNT user
  (`06a960b8-b33e-4cf4-96d3-b63a60e41f69`, `adivirtuosity@gmail.com`,
  `sales_rep`) as the rep — never James/William/Yoel's real accounts.
- The `goals`/`personal_goals` CHECK constraints on `metric` are named
  `goals_metric_check` / `personal_goals_metric_check` (confirmed against
  the live schema — Postgres's own default-generated names, since neither
  was given an explicit name in the original migration).
- No backfill of `ytd_billed_value` for `evident_report_log` rows that
  predate this change — only today's row exists in production.
- The two new YTD Booked Cases fixture files (`test/evidentReport/fixtures/
  ytd-booked-james.html`, `ytd-booked-william.html`) already exist,
  pulled from the real Evident emails sent to media@aimdentallab.com on
  2026-09-15 — Task 9 references them directly, no further data-gathering
  needed.

---

### Task 1: Database migration — `new_doctors` goal metric + Yearly Billed column

**Files:**
- Create: `scripts/v20-new-doctors-goal-and-ytd-billed-migration.sql`

**Interfaces:**
- Produces: `goals`/`personal_goals` accept `metric = 'new_doctors'` (Task
  2 consumes this) and `metric = 'leads_created'` (see note below — an
  unrelated pre-existing gap, fixed here since this exact constraint is
  already being rewritten). Produces `evident_report_log.ytd_billed_value`
  numeric column (Task 10 consumes this).

- [ ] **Step 1: Write the migration**

```sql
-- v20-new-doctors-goal-and-ytd-billed-migration.sql
-- Two independent additive changes, bundled per
-- docs/superpowers/specs/2026-09-15-sales-rep-daily-and-leadership-report-design.md:
--  1. Adds 'new_doctors' as a valid goals/personal_goals metric, for the
--     Sales Rep Daily Report's weekly new-doctor goal (src/routes/goals.js).
--  2. Adds evident_report_log.ytd_billed_value, for the Leadership
--     Report's new Yearly Billed tile.
--
-- Also folds in 'leads_created': it was added as a goals.js metric branch
-- and a Frontend goal option back in commit c0561cf ("Support
-- leads_created as a goal metric"), but the matching CHECK constraint
-- update was never shipped — confirmed live that zero goals/personal_goals
-- rows exist with this metric in production, meaning every "Leads Added"
-- goal anyone has tried to create since has failed with a silent
-- constraint-violation 500. Fixed here since this exact statement is
-- already being rewritten for new_doctors; flagged to the user separately
-- since it's outside this task's original scope.

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_metric_check;
ALTER TABLE goals ADD CONSTRAINT goals_metric_check
  CHECK (metric IN ('leads_created','leads_won','leads_contacted','proposals_sent','conversion_rate','new_doctors'));

ALTER TABLE personal_goals DROP CONSTRAINT IF EXISTS personal_goals_metric_check;
ALTER TABLE personal_goals ADD CONSTRAINT personal_goals_metric_check
  CHECK (metric IN ('leads_created','leads_won','leads_contacted','proposals_sent','conversion_rate','new_doctors'));

ALTER TABLE evident_report_log ADD COLUMN IF NOT EXISTS ytd_billed_value numeric NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Apply the migration**

This repo's migrations are applied by hand against the real database (no
migration-runner script):

```bash
node -e "
require('dotenv').config();
const fs = require('fs');
const db = require('./src/config/db');
(async () => {
  await db.query(fs.readFileSync('scripts/v20-new-doctors-goal-and-ytd-billed-migration.sql', 'utf-8'));
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
  const { rows: cons } = await db.query(
    \"SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('goals_metric_check','personal_goals_metric_check')\"
  );
  console.log(cons);
  const { rows: cols } = await db.query(
    \"SELECT column_name FROM information_schema.columns WHERE table_name='evident_report_log' AND column_name='ytd_billed_value'\"
  );
  console.log(cols);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```
Expected: both constraint defs include `'new_doctors'` and `'leads_created'`
in their `ANY (ARRAY[...])` list, and `cols` returns one row.

- [ ] **Step 4: Commit**

```bash
git add scripts/v20-new-doctors-goal-and-ytd-billed-migration.sql
git commit -m "Add new_doctors goal metric and evident_report_log.ytd_billed_value column"
```

---

### Task 2: Extend `goals.js` for the `new_doctors` metric

**Files:**
- Modify: `src/routes/goals.js`

**Interfaces:**
- Consumes: `goals_metric_check`/`personal_goals_metric_check` now
  allowing `'new_doctors'` (Task 1).
- Produces: `computeProgress()` handles `metric === 'new_doctors'` by
  counting `clients` rows (not `leads`) created in the goal's period —
  this is what lets an admin create a `new_doctors` goal from the existing
  Goals UI/API and see live progress, and what
  `salesRepDailyReport.js` (Task 4) will also read from directly.

- [ ] **Step 1: Add the metric label and computeProgress branch**

In `src/routes/goals.js`, add to `METRIC_LABELS` (`src/routes/goals.js:9-15`):

```js
const METRIC_LABELS = {
  leads_created: 'Leads Added',
  leads_won: 'Leads Won',
  leads_contacted: 'Leads Contacted',
  proposals_sent: 'Proposals Sent',
  conversion_rate: '% Conversion Rate',
  new_doctors: 'New Doctors',
}
```

Add a new branch to `computeProgress()` (`src/routes/goals.js:17-57`), after
the existing `conversion_rate` branch and before the function's closing
`pct`/`return` lines — this is the only metric type that counts `clients`
instead of `leads`, since a "new doctor" has no `leads` equivalent (a
doctor becomes a `clients` row via conversion, not by staying a lead):

```js
  } else if (metric === 'conversion_rate') {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='Won') AS won
       FROM leads WHERE assigned_to=$1 AND created_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    const total = Number(r.total)
    current = total > 0 ? Math.round(Number(r.won) * 100 / total) : 0
  } else if (metric === 'new_doctors') {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*) AS val FROM clients WHERE assigned_to=$1 AND created_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    current = Number(r.val)
  }
```

- [ ] **Step 2: Syntax check**

```bash
node -c src/routes/goals.js
```
Expected: no output.

- [ ] **Step 3: Verify the query against one synthetic client**

No staging database exists — test with exactly one synthetic `clients` row
against the real DB, then delete it immediately.

```bash
node -e "
require('dotenv').config();
const db = require('./src/config/db');
const TEST_REP_ID = '06a960b8-b33e-4cf4-96d3-b63a60e41f69'; // TEST ACCOUNT
const DOCTOR_NAME = 'ZZZ TEST DOCTOR (goals verification)';
(async () => {
  const today = new Date().toISOString().slice(0, 10);
  await db.query(
    \`INSERT INTO clients (doctor_name, brand, assigned_to, created_at) VALUES (\$1, 'Aim Dental', \$2, NOW())\`,
    [DOCTOR_NAME, TEST_REP_ID]
  );
  const { rows: [r] } = await db.query(
    \`SELECT COUNT(*) AS val FROM clients WHERE assigned_to=\$1 AND created_at::date BETWEEN \$2 AND \$3\`,
    [TEST_REP_ID, today, today]
  );
  console.log('new_doctors count for today:', Number(r.val) >= 1);
  await db.query('DELETE FROM clients WHERE doctor_name = \$1', [DOCTOR_NAME]);
  console.log('cleaned up');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```
Expected: `new_doctors count for today: true`, then `cleaned up`.

- [ ] **Step 4: Commit**

```bash
git add src/routes/goals.js
git commit -m "Support new_doctors as a goal metric"
```

---

### Task 3: Sales Rep Daily Report — email template

**Files:**
- Create: `test/salesRepDailyReport/email.test.js`
- Modify: `src/services/email.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `salesRepDailyReportEmail({ repName, dateLabel, doctors,
  totalCount, submittedCount, notSubmittedCount, goal, test })` returning
  an HTML string, exported from `src/services/email.js`. `doctors` is
  `{ doctor_name, clinic_name, submitted_today }[]`; `goal` is
  `{ target, current, hasCustomGoal }`. Consumed by Task 4's
  `buildDailyReportHtml()`.

- [ ] **Step 1: Write the failing test**

Create `test/salesRepDailyReport/email.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { salesRepDailyReportEmail } = require('../../src/services/email')

const SAMPLE = {
  repName: 'James Delaney',
  dateLabel: 'Tuesday, September 15, 2026',
  doctors: [
    { doctor_name: 'Dr. Brian Gold', clinic_name: null, submitted_today: true },
    { doctor_name: 'Dr. Cecilia U. Schneuerman', clinic_name: null, submitted_today: false },
  ],
  totalCount: 2,
  submittedCount: 1,
  notSubmittedCount: 1,
  goal: { target: 5, current: 2, hasCustomGoal: false },
}

test('renders totals, doctor rows, and weekly goal progress', () => {
  const html = salesRepDailyReportEmail(SAMPLE)
  assert.match(html, /Daily Sales Report/)
  assert.match(html, /James Delaney/)
  assert.match(html, /Dr\. Brian Gold/)
  assert.match(html, /Dr\. Cecilia U\. Schneuerman/)
  assert.match(html, /Submitted/)
  assert.match(html, /Not submitted/)
  assert.match(html, />2 <span[^>]*>of 5<\/span></)
})

test('test send shows the TEST banner', () => {
  const html = salesRepDailyReportEmail({ ...SAMPLE, test: true })
  assert.match(html, /Test send/)
})

test('a rep with zero assigned doctors gets an empty-state message, not a broken table', () => {
  const html = salesRepDailyReportEmail({ ...SAMPLE, doctors: [], totalCount: 0, submittedCount: 0, notSubmittedCount: 0 })
  assert.match(html, /No doctors assigned yet/)
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
node --test test/salesRepDailyReport/email.test.js
```
Expected: fails with `salesRepDailyReportEmail is not a function` (or
`undefined`).

- [ ] **Step 3: Implement the template**

Add to `src/services/email.js`, after `repReportEmail` and before
`unassignedLeadsReportEmail` (i.e. after `src/services/email.js:440`):

```js
// Sales Rep Daily Report — replaces the old automated, leadership-cc'd
// Weekly Rep Report send (see
// docs/superpowers/specs/2026-09-15-sales-rep-daily-and-leadership-report-design.md).
// repReportEmail (above) stays in use for the unrelated rep self-summary
// feature (GET/POST /api/reports/my-summary*) — this is a new, simpler
// template on purpose: a daily operational checklist (who submitted a
// case today, who didn't, weekly new-doctor goal progress), not a
// performance narrative with tiers/coaching suggestions.
function salesRepDailyReportEmail({ repName, dateLabel, doctors, totalCount, submittedCount, notSubmittedCount, goal, test }) {
  const { ink, slate, teal, deep, success } = BRAND
  const hairline = '#dcebe9'
  const danger = '#b91c1c'

  const statRow = (cells) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        ${cells.map((c) => `
        <td width="${Math.floor(100 / cells.length)}%" style="text-align:center;padding:0 6px">
          <p style="margin:0;font-family:${FONT_DATA};font-size:21px;font-weight:500;color:${c.color || ink};letter-spacing:-.01em">${c.val}</p>
          <p style="margin:6px 0 0;font-family:${FONT_DATA};font-size:9.5px;color:${slate};text-transform:uppercase;letter-spacing:.08em">${c.label}</p>
        </td>`).join('')}
      </tr>
    </table>`

  const sectionLabel = (text) => `<p style="margin:0 0 14px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${slate}">${text}</p>`

  const doctorRows = doctors.map((d, i) => `
    <tr>
      <td style="padding:11px 0;${i > 0 ? `border-top:1px solid ${hairline}` : ''}">
        <p style="margin:0;font-size:13.5px;font-weight:600;color:${ink}">${d.doctor_name}</p>
        ${d.clinic_name ? `<p style="margin:2px 0 0;font-size:12px;color:${slate}">${d.clinic_name}</p>` : ''}
      </td>
      <td style="padding:11px 0;${i > 0 ? `border-top:1px solid ${hairline}` : ''}text-align:right;white-space:nowrap">
        ${d.submitted_today
          ? `<span style="font-family:${FONT_DATA};font-size:11px;font-weight:500;color:${success};background:#ecfdf5;border-radius:999px;padding:4px 10px">&#9650; Submitted</span>`
          : `<span style="font-family:${FONT_DATA};font-size:11px;font-weight:500;color:${danger};background:#fef2f2;border-radius:999px;padding:4px 10px">&#9660; Not submitted</span>`}
      </td>
    </tr>`).join('')

  const goalPct = goal.target > 0 ? Math.min(Math.round((goal.current / goal.target) * 100), 100) : 0

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background-color:${BRAND.deep};background-image:linear-gradient(160deg,${BRAND.skyBlue} 0%,${BRAND.deep} 100%);font-family:${FONT_BODY}">
<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 6px 28px rgba(32,114,144,.16)">

  ${test ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td bgcolor="#fbbf24" style="background-color:#fbbf24;padding:10px 20px;text-align:center">
        <p style="margin:0;font-family:${FONT_DATA};font-size:11.5px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:#78350f">Test send — not a real daily report</p>
      </td>
    </tr>
  </table>
  ` : ''}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td bgcolor="${teal}" style="background-color:${teal};background-image:linear-gradient(135deg,${teal},${deep});padding:34px 36px 28px">
        <h1 style="color:#fff;margin:0;font-family:${FONT_DISPLAY};font-size:28px;font-weight:700;letter-spacing:-.01em">Daily Sales Report</h1>
        <p style="color:rgba(255,255,255,.72);margin:12px 0 0;font-size:13px">${repName} &nbsp;·&nbsp; ${dateLabel}</p>
      </td>
    </tr>
  </table>

  <div style="padding:30px 36px 0">
    ${statRow([
      { label: 'Doctors Assigned', val: totalCount },
      { label: 'Submitted Today', val: submittedCount, color: submittedCount > 0 ? success : undefined },
      { label: 'Not Submitted', val: notSubmittedCount, color: notSubmittedCount > 0 ? danger : undefined },
    ])}
  </div>

  <div style="margin:30px 36px 0;padding:20px 22px;background:${BRAND.tealMist};border-radius:16px">
    ${sectionLabel('Weekly Goal — New Doctors')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td><p style="margin:0;font-family:${FONT_DATA};font-size:22px;font-weight:500;color:${ink}">${goal.current} <span style="font-size:14px;color:${slate}">of ${goal.target}</span></p></td>
      <td style="text-align:right"><p style="margin:0;font-family:${FONT_DATA};font-size:13px;color:${teal}">${goalPct}%</p></td>
    </tr></table>
    <div style="margin-top:10px;height:6px;background:#fff;border-radius:999px;overflow:hidden">
      <div style="width:${goalPct}%;height:100%;background:${teal}"></div>
    </div>
  </div>

  <div style="padding:30px 36px 36px">
    ${sectionLabel('Your Doctors')}
    ${doctors.length === 0
      ? `<p style="margin:0;font-size:13px;color:${slate}">No doctors assigned yet.</p>`
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${doctorRows}</table>`}
  </div>

  <div style="background:${BRAND.tealMist};padding:18px 36px;font-size:11.5px;color:${slate};border-top:1px solid ${hairline}">
    Aim Dental Laboratory CRM &nbsp;·&nbsp; Daily report for ${repName}
  </div>
</div>
</body></html>`
}
```

Add `salesRepDailyReportEmail` to the `module.exports` block
(`src/services/email.js:859-873`):

```js
module.exports = {
  sendEmail,
  primaryFrontendUrl,
  coldLeadEmail,
  caseDueEmail,
  lostRecoveryEmail,
  winStreakEmail,
  noActionLeadEmail,
  repReportEmail,
  salesRepDailyReportEmail,
  unassignedLeadsReportEmail,
  pickupRequestedEmail,
  pickupDispatchedEmail,
  pickupReceivedEmail,
  pickupBrand,
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
node --test test/salesRepDailyReport/email.test.js
```
Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Wire the new test directory into `npm test`**

In `package.json`, change the `test` script (currently
`"test": "node --test test/evidentReport/*.test.js"`) to also run the new
directory:

```json
"test": "node --test test/evidentReport/*.test.js test/salesRepDailyReport/*.test.js",
```

Run the full suite to confirm nothing else broke:

```bash
npm test
```
Expected: all tests pass (5 existing `evidentReport` tests + 3 new
`salesRepDailyReport` tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/email.js test/salesRepDailyReport/email.test.js package.json
git commit -m "Add Sales Rep Daily Report email template"
```

---

### Task 4: Sales Rep Daily Report — data service

**Files:**
- Create: `src/services/salesRepDailyReport.js`
- Create: `test/salesRepDailyReport/dateHelpers.test.js`

**Interfaces:**
- Consumes: `salesRepDailyReportEmail` (Task 3), `goals` table with
  `metric='new_doctors'` support (Task 1/2).
- Produces: `sendRepDailyReport(rep, opts)`,
  `sendAllSalesRepDailyReports()`, `computeDailyDoctorStatus(repId,
  dateStr)`, `computeWeeklyNewDoctorGoal(repId, dateStr)`,
  `buildDailyReportHtml(repName, dateStr, status, goal, opts)`,
  `mondayOfWeekEastern(dateStr)`, `DAILY_REPORT_REP_EMAILS`, `REPORT_CC`.
  Consumed by Task 5 (cron) and Task 6 (routes).

- [ ] **Step 1: Write the failing test for the pure date helper**

Create `test/salesRepDailyReport/dateHelpers.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { mondayOfWeekEastern } = require('../../src/services/salesRepDailyReport')

test('a Tuesday resolves to that week\'s Monday', () => {
  assert.equal(mondayOfWeekEastern('2026-09-15'), '2026-09-14')
})

test('Monday itself resolves to itself', () => {
  assert.equal(mondayOfWeekEastern('2026-09-14'), '2026-09-14')
})

test('a Sunday resolves to the Monday that started that week', () => {
  assert.equal(mondayOfWeekEastern('2026-09-20'), '2026-09-14')
})
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
node --test test/salesRepDailyReport/dateHelpers.test.js
```
Expected: fails — `Cannot find module '../../src/services/salesRepDailyReport'`.

- [ ] **Step 3: Implement the service**

Create `src/services/salesRepDailyReport.js`:

```js
const db = require('../config/db')
const { sendEmail, salesRepDailyReportEmail } = require('./email')

// Recipients are the two real AIM reps by email, not a role query — role
// IN ('staff','sales_rep') would also catch Yoel Klein and the TEST
// ACCOUNT, both sales_rep but neither a real AIM rep for this report. See
// docs/superpowers/specs/2026-09-15-sales-rep-daily-and-leadership-report-design.md.
const DAILY_REPORT_REP_EMAILS = ['james@aimdentallab.com', 'williama@aimdentallab.com']
// Yoel is cc'd on both reps' emails for visibility, not sent his own
// personalized report for his own KH doctors.
const REPORT_CC = ['yoel@khdentallab.com']

const DEFAULT_WEEKLY_NEW_DOCTOR_TARGET = 5

// 'en-CA' reliably formats as YYYY-MM-DD. Each report file in this
// codebase owns its own small ET-date helper (see evidentReport/index.js's
// todayEasternDateString()) rather than sharing one, matching how
// mediaCleanup.js/socialTokenRefresh.js each own their own cron setup too.
function todayEasternDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// Monday of the week containing dateStr (both 'YYYY-MM-DD'), computed
// with Date.UTC so the result doesn't depend on the server process's own
// local timezone — pure calendar-day arithmetic, not a real moment in time.
function mondayOfWeekEastern(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const day = date.getUTCDay()
  const diff = day === 0 ? 6 : day - 1
  date.setUTCDate(date.getUTCDate() - diff)
  return date.toISOString().slice(0, 10)
}

// "Submitted a case today" mirrors weeklyRepReport.js's/cases.js's
// existing client<->case attribution: cases have no assigned_to or
// client_id of their own, matched by cl.doctor_name = c.client_name. The
// day boundary is computed in Postgres via AT TIME ZONE (not JS Date
// arithmetic) — the same DST/UTC-drift class of bug the Evident report's
// review already caught once in this codebase.
async function computeDailyDoctorStatus(repId, dateStr) {
  const { rows } = await db.query(
    `SELECT cl.doctor_name, cl.clinic_name,
      EXISTS (
        SELECT 1 FROM cases c
        WHERE c.client_name = cl.doctor_name
          AND c.created_at >= ($2::date AT TIME ZONE 'America/New_York')
          AND c.created_at <  (($2::date + 1) AT TIME ZONE 'America/New_York')
      ) AS submitted_today
     FROM clients cl
     WHERE cl.assigned_to = $1
     ORDER BY cl.doctor_name`,
    [repId, dateStr]
  )
  const doctors = rows.map(r => ({
    doctor_name: r.doctor_name,
    clinic_name: r.clinic_name,
    submitted_today: r.submitted_today,
  }))
  const submittedCount = doctors.filter(d => d.submitted_today).length
  return {
    doctors,
    totalCount: doctors.length,
    submittedCount,
    notSubmittedCount: doctors.length - submittedCount,
  }
}

// "New doctor" = a clients row assigned to the rep with created_at in the
// current week (Monday through dateStr, in progress — live progress
// building across the week, not a completed prior week). Falls back to a
// default target of 5 when no admin-set weekly new_doctors goal exists for
// this rep for the current week; no goal row gets auto-created for the
// fallback case.
async function computeWeeklyNewDoctorGoal(repId, dateStr) {
  const weekStart = mondayOfWeekEastern(dateStr)

  const [goalRes, countRes] = await Promise.all([
    db.query(
      `SELECT target FROM goals
       WHERE rep_id=$1 AND metric='new_doctors' AND period='weekly'
         AND period_start <= $2 AND period_end >= $2`,
      [repId, dateStr]
    ),
    db.query(
      `SELECT COUNT(*) AS val FROM clients
       WHERE assigned_to=$1 AND created_at::date >= $2 AND created_at::date <= $3`,
      [repId, weekStart, dateStr]
    ),
  ])

  const target = goalRes.rows[0] ? Number(goalRes.rows[0].target) : DEFAULT_WEEKLY_NEW_DOCTOR_TARGET
  return { target, current: Number(countRes.rows[0].val), hasCustomGoal: !!goalRes.rows[0] }
}

function buildDailyReportHtml(repName, dateStr, status, goal, { test = false } = {}) {
  const dateLabel = new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })
  const html = salesRepDailyReportEmail({ repName, dateLabel, ...status, goal, test })
  return { html, dateLabel }
}

// Sends one rep's daily report. `to`/`cc` overrides exist for the
// admin-triggered test send (routes/reports.js) — omit both to send to the
// rep's own address, cc'd to Yoel, exactly as the weekday automated job
// does. `test: true` prepends a "TEST" subject marker and banner, same
// convention as every other report in this codebase.
async function sendRepDailyReport(rep, { to, cc = REPORT_CC, test = false, dateStr = todayEasternDateString() } = {}) {
  const status = await computeDailyDoctorStatus(rep.id, dateStr)
  const goal = await computeWeeklyNewDoctorGoal(rep.id, dateStr)
  const { html, dateLabel } = buildDailyReportHtml(rep.name || rep.email, dateStr, status, goal, { test })
  await sendEmail({
    to: to || rep.email,
    ...(cc?.length ? { cc } : {}),
    subject: `${test ? 'TEST — ' : ''}Daily Sales Report — ${rep.name || rep.email} — ${dateLabel}`,
    html,
  })
  return { status, goal }
}

// Weekday-morning automated send (jobs/salesRepDailyReport.js) — James and
// William only, cc'd to Yoel. Best-effort per rep so one bad email/DB
// hiccup doesn't block the other rep's report.
async function sendAllSalesRepDailyReports() {
  const { rows: reps } = await db.query(
    `SELECT id, name, email FROM users WHERE email = ANY($1::text[])`,
    [DAILY_REPORT_REP_EMAILS]
  )
  const results = []
  for (const rep of reps) {
    try {
      await sendRepDailyReport(rep)
      results.push({ rep: rep.email, success: true })
    } catch (err) {
      console.error(`[sales-rep-daily-report] failed for ${rep.email}:`, err.message)
      results.push({ rep: rep.email, success: false, error: err.message })
    }
  }
  return results
}

module.exports = {
  computeDailyDoctorStatus,
  computeWeeklyNewDoctorGoal,
  buildDailyReportHtml,
  sendRepDailyReport,
  sendAllSalesRepDailyReports,
  mondayOfWeekEastern,
  DAILY_REPORT_REP_EMAILS,
  REPORT_CC,
  DEFAULT_WEEKLY_NEW_DOCTOR_TARGET,
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
node --test test/salesRepDailyReport/dateHelpers.test.js
```
Expected: 3 tests pass.

- [ ] **Step 5: Verify the DB queries against one synthetic client + case**

No staging database exists — test with exactly one synthetic `clients` row
and one synthetic `cases` row against the real DB, then delete both
immediately.

```bash
node -e "
require('dotenv').config();
const db = require('./src/config/db');
const { computeDailyDoctorStatus, computeWeeklyNewDoctorGoal } = require('./src/services/salesRepDailyReport');
const TEST_REP_ID = '06a960b8-b33e-4cf4-96d3-b63a60e41f69'; // TEST ACCOUNT
const DOCTOR_NAME = 'ZZZ TEST DOCTOR (daily report verification)';
(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const before = await computeWeeklyNewDoctorGoal(TEST_REP_ID, today);
  await db.query(
    \`INSERT INTO clients (doctor_name, brand, assigned_to, created_at) VALUES (\$1, 'Aim Dental', \$2, NOW())\`,
    [DOCTOR_NAME, TEST_REP_ID]
  );
  await db.query(
    \`INSERT INTO cases (client_name, created_at) VALUES (\$1, NOW())\`,
    [DOCTOR_NAME]
  );
  const status = await computeDailyDoctorStatus(TEST_REP_ID, today);
  const after = await computeWeeklyNewDoctorGoal(TEST_REP_ID, today);
  const found = status.doctors.find(d => d.doctor_name === DOCTOR_NAME);
  console.log('found doctor, submitted today:', found && found.submitted_today === true);
  console.log('new-doctor count went up by 1:', after.current === before.current + 1);
  await db.query('DELETE FROM cases WHERE client_name = \$1', [DOCTOR_NAME]);
  await db.query('DELETE FROM clients WHERE doctor_name = \$1', [DOCTOR_NAME]);
  console.log('cleaned up');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```
Expected: `found doctor, submitted today: true`, `new-doctor count went up
by 1: true`, then `cleaned up`.

- [ ] **Step 6: Commit**

```bash
git add src/services/salesRepDailyReport.js test/salesRepDailyReport/dateHelpers.test.js
git commit -m "Add Sales Rep Daily Report data service"
```

---

### Task 5: Cron job + `index.js` wiring

**Files:**
- Create: `src/jobs/salesRepDailyReport.js`
- Modify: `src/index.js`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `sendAllSalesRepDailyReports()` (Task 4).
- Produces: `startSalesRepDailyReportScheduler()`, called from
  `src/index.js`'s `app.listen` callback alongside the other four job
  starters. Documents `SALES_REP_DAILY_REPORT_ENABLED` in `.env.example`.

- [ ] **Step 1: Write the job file**

Create `src/jobs/salesRepDailyReport.js`:

```js
// src/jobs/salesRepDailyReport.js
const cron = require('node-cron')
const { sendAllSalesRepDailyReports } = require('../services/salesRepDailyReport')

// Its own file, not added to jobs/scheduler.js — same reasoning as
// mediaCleanup.js/socialTokenRefresh.js/evidentReport.js. (Task 7
// separately removes scheduler.js's OLD Weekly Rep Report cron block —
// a scoped, deliberate exception to the "don't touch scheduler.js" rule,
// since it retires dead code, not because this new job belongs there.)
function startSalesRepDailyReportScheduler() {
  // Weekdays 8:00am America/New_York — same slot the old Weekly Rep
  // Report used, now firing daily instead of just Monday.
  cron.schedule(
    '0 8 * * 1-5',
    async () => {
      // Gated behind SALES_REP_DAILY_REPORT_ENABLED, same pattern as
      // WEEKLY_REPORT_ENABLED/UNASSIGNED_LEADS_REPORT_ENABLED/
      // EVIDENT_REPORT_ENABLED — lets the code ship and be reviewed via
      // the admin manual-send route before a real weekday 8am send to
      // James/William goes live on its own.
      if (process.env.SALES_REP_DAILY_REPORT_ENABLED !== 'true') {
        console.log('[sales-rep-daily-report] scheduled run skipped — SALES_REP_DAILY_REPORT_ENABLED is not set to true')
        return
      }
      console.log('[sales-rep-daily-report] Running scheduled daily run')
      try {
        await sendAllSalesRepDailyReports()
      } catch (err) {
        console.error('[sales-rep-daily-report] scheduled run failed:', err)
      }
    },
    { timezone: 'America/New_York' }
  )
  console.log('[sales-rep-daily-report] job registered')
}

module.exports = { startSalesRepDailyReportScheduler }
```

- [ ] **Step 2: Wire it into `src/index.js`**

Add the require alongside the other job imports
(`src/index.js:1-6`):

```js
const { startSalesRepDailyReportScheduler } = require('./jobs/salesRepDailyReport')
```

Add the call alongside the other four job starters (`src/index.js`'s
`app.listen` block):

```js
app.listen(PORT, () => {
  console.log(`Aim Dental CRM backend running on port ${PORT}`)
  startScheduler()
  startMediaCleanupScheduler()
  startSocialTokenRefreshScheduler()
  startEvidentReportScheduler()
  startSalesRepDailyReportScheduler()
})
```

- [ ] **Step 3: Document the gate in `.env.example`**

In `.env.example`, add alongside `EVIDENT_REPORT_ENABLED` (matching that
entry's already-documented pattern):

```
# Sales Rep Daily Report — set to the string "true" to enable the weekday
# 8am America/New_York automated send to James/William (cc Yoel). Left
# unset so the code can ship and be reviewed via the admin-only manual
# test-send route first, same pattern as EVIDENT_REPORT_ENABLED/
# WEEKLY_REPORT_ENABLED/UNASSIGNED_LEADS_REPORT_ENABLED.
SALES_REP_DAILY_REPORT_ENABLED=
```

- [ ] **Step 4: Verify**

```bash
node -c src/jobs/salesRepDailyReport.js && node -c src/index.js
```
Expected: no output for either.

```bash
node src/index.js &
sleep 2
curl -s http://localhost:4000/health
kill %1
```
Expected: `{"status":"ok"}`, and `[sales-rep-daily-report] job registered`
present in the server's stdout.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/salesRepDailyReport.js src/index.js .env.example
git commit -m "Register the Sales Rep Daily Report's weekday cron job"
```

---

### Task 6: Admin routes for the Sales Rep Daily Report

**Files:**
- Modify: `src/routes/reports.js`

**Interfaces:**
- Consumes: `sendRepDailyReport`, `buildDailyReportHtml`,
  `computeDailyDoctorStatus`, `computeWeeklyNewDoctorGoal`, `REPORT_CC`
  (Task 4).
- Produces: `GET /api/reports/sales-rep-daily-report/preview?rep_id=...`
  and `POST /api/reports/sales-rep-daily-report/send` (both admin-only).

- [ ] **Step 1: Add the import**

In `src/routes/reports.js`, alongside the existing imports
(`src/routes/reports.js:6-13`):

```js
const {
  sendRepDailyReport, buildDailyReportHtml, computeDailyDoctorStatus,
  computeWeeklyNewDoctorGoal, REPORT_CC: DAILY_REPORT_CC,
} = require('../services/salesRepDailyReport')
```

- [ ] **Step 2: Add the routes**

Add near the other manual-send routes, in the same place Task 7 will
remove the old `weekly-rep-report/preview`/`weekly-rep-report/send` routes
from:

```js
// GET /api/reports/sales-rep-daily-report/preview?rep_id=... — admin-only
// HTML preview of exactly what a rep's daily report email looks like,
// without sending anything. Defaults to the requesting admin's own data
// if rep_id is omitted.
router.get('/sales-rep-daily-report/preview', auth, requireAdmin, async (req, res, next) => {
  try {
    const repId = req.query.rep_id || req.user.id
    const { rows } = await db.query(`SELECT id, name, email FROM users WHERE id=$1`, [repId])
    if (!rows[0]) return res.status(404).json({ error: 'Rep not found' })
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const status = await computeDailyDoctorStatus(repId, dateStr)
    const goal = await computeWeeklyNewDoctorGoal(repId, dateStr)
    const { html } = buildDailyReportHtml(rows[0].name || rows[0].email, dateStr, status, goal)
    res.set('Content-Type', 'text/html').send(html)
  } catch (err) { next(err) }
})

// POST /api/reports/sales-rep-daily-report/send — admin-only manual
// trigger. Body: { rep_id, to?, include_cc?, test? }. Omit `to` to send to
// the rep's own address; pass it to redirect the send elsewhere (a test
// to the admin's own inbox) without changing whose numbers are reported.
// `include_cc` defaults true (Yoel Klein); `test` marks the send with a
// "TEST —" subject prefix and banner, same convention as every other
// manual-send route in this file.
router.post('/sales-rep-daily-report/send', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rep_id, to, include_cc = true, test = false } = req.body
    if (!rep_id) return res.status(400).json({ error: 'rep_id is required' })
    const { rows } = await db.query(`SELECT id, name, email FROM users WHERE id=$1`, [rep_id])
    if (!rows[0]) return res.status(400).json({ error: 'rep_id must be an existing user' })

    await sendRepDailyReport(rows[0], { to, cc: include_cc ? DAILY_REPORT_CC : [], test })
    res.json({ success: true, message: `${test ? 'Test report' : 'Report'} sent to ${to || rows[0].email}${include_cc ? ` (cc: ${DAILY_REPORT_CC.join(', ')})` : ''}` })
  } catch (err) { next(err) }
})
```

- [ ] **Step 3: Verify**

```bash
node -c src/routes/reports.js
```
Expected: no output. Full functional verification (an actual `POST` with
`test:true` to your own inbox) happens per this plan's Global Constraints
— after all tasks are done, before either `*_ENABLED` var is ever set.

- [ ] **Step 4: Commit**

```bash
git add src/routes/reports.js
git commit -m "Add admin routes for the Sales Rep Daily Report"
```

---

### Task 7: Retire the Weekly Rep Report's automated leadership send

**Important scoping note, confirmed during planning (not obvious from the
spec alone):** `weeklyRepReport.js` is not exclusively the automated,
leadership-cc'd "Weekly Rep Report" this plan retires — its
`computeRepSummary`/`sendRepWeeklyReport` functions are also used by three
separate, currently-live, unrelated Frontend features that must keep
working: the rep Dashboard's own KPI card (`GET /my-summary`, called from
`Frontend/src/pages/Dashboard.jsx`), the Reports page's CSV export
(`GET /my-summary/csv`), and a self-service "email me my report" button
(`POST /my-summary/email`, called from `Frontend/src/pages/Reports.jsx`).
**Do not delete `weeklyRepReport.js`.** Only remove the specific piece
that *is* the automated leadership send: `sendAllWeeklyRepReports()`, the
two admin-only `weekly-rep-report/preview`+`/send` routes, and the
scheduler.js cron block that calls it.

**Files:**
- Modify: `src/services/weeklyRepReport.js`
- Modify: `src/routes/reports.js`
- Modify: `src/jobs/scheduler.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `computeRepSummary`, `buildRepReportHtml`, `sendRepWeeklyReport`,
  `REPORT_CC` continue to exist unchanged, still powering `/my-summary`,
  `/my-summary/csv`, `/my-summary/email`. `sendAllWeeklyRepReports` and the
  two `weekly-rep-report/*` admin routes are gone, superseded by Task 6's
  `sales-rep-daily-report/*` routes and Task 5's cron.

- [ ] **Step 1: Remove `sendAllWeeklyRepReports` from `weeklyRepReport.js`**

In `src/services/weeklyRepReport.js`, delete the function and its doc
comment (currently lines 322-340):

```js
// Monday-morning automated send (jobs/scheduler.js) — every staff/sales_rep
// user, cc'd to leadership. Best-effort per rep so one bad email/DB hiccup
// doesn't block the rest of the team's reports.
async function sendAllWeeklyRepReports() {
  const { rows: reps } = await db.query(
    `SELECT id, name, email FROM users WHERE role IN ('staff','sales_rep')`
  )
  const results = []
  for (const rep of reps) {
    try {
      await sendRepWeeklyReport(rep)
      results.push({ rep: rep.email, success: true })
    } catch (err) {
      console.error(`[weekly-rep-report] failed for ${rep.email}:`, err.message)
      results.push({ rep: rep.email, success: false, error: err.message })
    }
  }
  return results
}

```

And narrow the file's final `module.exports` (currently line 342) to drop it:

```js
module.exports = { computeRepSummary, buildRepReportHtml, sendRepWeeklyReport, REPORT_CC }
```

- [ ] **Step 2: Remove the two admin routes and narrow the import in `reports.js`**

In `src/routes/reports.js`, narrow the import (`src/routes/reports.js:6-8`)
to only the names `/my-summary`/`/my-summary/email` still use —
`buildRepReportHtml` and `REPORT_CC` were only ever used by the two routes
this step removes:

```js
const { computeRepSummary, sendRepWeeklyReport } = require('../services/weeklyRepReport')
```

And remove the two routes (`src/routes/reports.js:416-451` — the
`GET /weekly-rep-report/preview` and `POST /weekly-rep-report/send`
handlers and their doc comments), leaving Task 6's new
`sales-rep-daily-report/preview`/`send` routes in their place. Leave the
`/my-summary`, `/my-summary/email`, and `/my-summary/csv` routes
(`reports.js:385-414`, `499-527`) completely untouched.

- [ ] **Step 3: Remove the scheduler.js cron block**

**This is a scoped, deliberate exception** to this codebase's "never touch
scheduler.js" rule (see Global Constraints above) — remove exactly this
one block from `src/jobs/scheduler.js` (currently lines 102-116) and
nothing else in the file:

```js
  // Every Monday at 8:00 AM Eastern — per-rep weekly performance reports
  // (one email per staff/sales_rep user, cc'd to leadership). Gated behind
  // WEEKLY_REPORT_ENABLED — the report design is still under review with
  // Elizabeth/Ben as of 2026-08-25, so this stays a no-op until that env
  // var is explicitly set to 'true' on Render, even though the code has
  // been deployed. Don't remove this gate without checking that review is
  // actually done.
  cron.schedule('0 8 * * 1', async () => {
    if (process.env.WEEKLY_REPORT_ENABLED !== 'true') {
      console.log('[cron] Weekly rep reports skipped — WEEKLY_REPORT_ENABLED is not set to true')
      return
    }
    console.log('[cron] Sending weekly rep reports')
    await sendAllWeeklyRepReports().catch((err) => console.error('[cron] weekly rep reports failed:', err))
  }, { timezone: 'America/New_York' })

```

Also remove its now-unused import at the top of the file
(`src/jobs/scheduler.js:4`):

```js
const { sendAllWeeklyRepReports } = require('../services/weeklyRepReport')
```

- [ ] **Step 4: Verify**

```bash
node -c src/services/weeklyRepReport.js && node -c src/jobs/scheduler.js && node -c src/routes/reports.js
```
Expected: no output for any.

```bash
grep -c "my-summary" src/routes/reports.js
```
Expected: `6` (unchanged — confirms `/my-summary`, `/my-summary/email`,
and `/my-summary/csv` and their comments are all still present).

```bash
node src/index.js &
sleep 2
curl -s http://localhost:4000/health
kill %1
```
Expected: `{"status":"ok"}`, `[scheduler] Cron jobs registered` present,
no error about a missing export.

- [ ] **Step 5: Commit**

```bash
git add src/services/weeklyRepReport.js src/routes/reports.js src/jobs/scheduler.js
git commit -m "Retire the Weekly Rep Report's automated leadership send, keep the rep self-summary"
```

---

### Task 8: Rename to "AIM Leadership Report" + bcc media@

**Files:**
- Modify: `src/services/evidentReport/buildReport.js`
- Modify: `src/services/evidentReport/index.js`
- Modify: `test/evidentReport/parseEvident.test.js`

**Interfaces:**
- Produces: `buildEmail()`'s returned `subject` and the email's H2 both
  read "AIM Leadership Report" instead of "Evident Consolidated Report".
  `runEvidentReport()`'s `sendEmail()` call gets `bcc:
  ['media@aimdentallab.com']` added. No change to internal module/file
  naming (`evidentReport/`, `runEvidentReport`, `[evident-report]` log
  prefixes all stay — the spec scopes this rename to the user-facing
  subject/heading only, since the underlying data source is still
  literally Evident's emails).

- [ ] **Step 1: Rename in `buildReport.js`**

In `src/services/evidentReport/buildReport.js`, change the H2
(`buildReport.js:49`):

```js
  <h2 style="margin:0 0 4px;font-size:18px;">AIM Leadership Report</h2>
```

And the subject (`buildReport.js:127`):

```js
    subject: `AIM Leadership Report - ${dateLabel}`,
```

- [ ] **Step 2: Add the bcc in `index.js`**

In `src/services/evidentReport/index.js`, change the `sendEmail()` call
(`index.js:68-75`):

```js
  console.log(`[evident-report] sending to ${RECIPIENTS.join(', ')}...`)
  await sendEmail({
    to: RECIPIENTS,
    bcc: ['media@aimdentallab.com'],
    subject,
    html: finalHtml,
    ...(pdfBuffer
      ? { attachments: [{ filename: `evident-report-${aggregate.runDate}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }] }
      : {}),
  })
```

- [ ] **Step 3: Update the existing test's assertions**

In `test/evidentReport/parseEvident.test.js`, the "email copy" test
currently asserts `subject.startsWith('Evident Consolidated Report')` —
update it:

```js
  assert.ok(subject.startsWith('AIM Leadership Report'))
```

- [ ] **Step 4: Run the tests**

```bash
npm test
```
Expected: all tests pass, including the updated subject assertion.

- [ ] **Step 5: Commit**

```bash
git add src/services/evidentReport/buildReport.js src/services/evidentReport/index.js test/evidentReport/parseEvident.test.js
git commit -m "Rename Evident Consolidated Report to AIM Leadership Report, bcc media@"
```

---

### Task 9: Parse Evident's YTD Booked Cases email

**Files:**
- Modify: `src/services/evidentReport/parseEvident.js`
- Modify: `test/evidentReport/parseEvident.test.js`
- (Already present: `test/evidentReport/fixtures/ytd-booked-james.html`,
  `test/evidentReport/fixtures/ytd-booked-william.html` — pulled from the
  real Evident emails sent 2026-09-15, same "transcribe a real email,
  assert against its own total row" discipline as the other 5 fixtures.)

**Interfaces:**
- Produces: `parseAndAggregate()`'s returned `aggregate.booked.ytd =
  { count, billed, wip, value, byRep: { james, william } }`. `EXPECTED`
  grows from 5 to 7 entries (`aggregate.missing` now flags YTD emails too).
  Consumed by Task 10's `buildReport.js` Yearly Billed tile.

- [ ] **Step 1: Write the failing tests**

In `test/evidentReport/parseEvident.test.js`, add to the `ALL_MESSAGES`
fixture list:

```js
const ALL_MESSAGES = [
  { subject: "Daily Booked Cases - James' Doctors", html: fixture('daily-booked-james.html') },
  { subject: "Daily Booked Cases - William's Doctors", html: fixture('daily-booked-william-nodata.html') },
  { subject: "MTD Booked Cases - James' Doctors", html: fixture('mtd-booked-james.html') },
  { subject: "MTD Booked Cases - William's Doctors", html: fixture('mtd-booked-william.html') },
  { subject: 'Cases Currently In Progress', html: fixture('wip-cases-in-progress.html') },
  { subject: "YTD Booked Cases - James' Doctors", html: fixture('ytd-booked-james.html') },
  { subject: "YTD Booked Cases - William's Doctors", html: fixture('ytd-booked-william.html') },
];
```

Note this changes the existing "parses and combines all 5 report types"
test's fixture set to 7 messages — update its `missing` assertion
accordingly, and add new assertions for the YTD figures (these are the
real September 15, 2026 YTD totals from the two fixtures: James 36
cases/$3866.85 billed/$515.94 WIP/$4382.79 total; William 38
cases/$4152.28 billed/$262.47 WIP/$4414.75 total):

```js
test('parses and combines all 7 report types correctly', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });

  assert.equal(agg.missing.length, 0);

  // Daily: only James had a booking (1 case, $117 WIP, $0 billed); William had none.
  assert.equal(agg.booked.daily.count, 1);
  assert.equal(agg.booked.daily.value, 117);

  // MTD: James 8 cases/$501 billed/$1061.91 WIP, William 4 cases/$77.49 billed/$262.47 WIP.
  assert.equal(agg.booked.mtd.count, 12);
  assert.equal(agg.booked.mtd.billed, 578.49);
  assert.equal(agg.booked.mtd.wip, 1324.38);
  assert.equal(Math.round(agg.booked.mtd.value * 100) / 100, 1902.87);

  // YTD: James 36 cases/$3866.85 billed/$515.94 WIP, William 38 cases/$4152.28 billed/$262.47 WIP.
  assert.equal(agg.booked.ytd.count, 74);
  assert.equal(Math.round(agg.booked.ytd.billed * 100) / 100, 8019.13);
  assert.equal(Math.round(agg.booked.ytd.wip * 100) / 100, 778.41);
  assert.equal(Math.round(agg.booked.ytd.value * 100) / 100, 8797.54);
  assert.equal(agg.booked.ytd.byRep.james.count, 36);
  assert.equal(agg.booked.ytd.byRep.william.count, 38);

  // WIP: 382 cases / $46,709.54 total, split AIM 166/$16,756.54 and KH 216/$29,953.
  assert.equal(agg.wip.cases, 382);
  assert.equal(agg.wip.value, 46709.54);
  assert.equal(agg.wip.kh.cases, 216);
  assert.equal(agg.wip.kh.value, 29953);
  assert.equal(agg.wip.aim.cases, 166);
  assert.equal(Math.round(agg.wip.aim.value * 100) / 100, 16756.54);
  assert.equal(agg.wip.byRep.james, 1061.91);
  assert.equal(agg.wip.byRep.william, 262.47);
});
```

(Rename the old `'parses and combines all 5 report types correctly'` test
above to `'parses and combines all 7 report types correctly'` in place —
do not leave both.)

The `'flags missing reports instead of silently under-reporting'` test
sends only 1 of the now-7 expected messages — update its expected missing
count:

```js
test('flags missing reports instead of silently under-reporting', () => {
  const agg = parseAndAggregate(
    [{ subject: "Daily Booked Cases - James' Doctors", html: fixture('daily-booked-james.html') }],
    { runDate: '2026-09-11' }
  );
  assert.equal(agg.missing.length, 6);
  assert.ok(agg.missing.includes('Cases Currently In Progress'));
});
```

- [ ] **Step 2: Run the tests, verify they fail**

```bash
npm test
```
Expected: the two updated tests fail — `agg.booked.ytd` is `undefined`,
and the missing-count assertion fails (still reports 4, not 6).

- [ ] **Step 3: Implement the parser changes**

In `src/services/evidentReport/parseEvident.js`, add to `classify()`
(`parseEvident.js:44-52`), after the `mtdBooked` cases and before `wip`:

```js
function classify(subject) {
  const s = subject.trim();
  if (/^Daily Booked Cases\s*-\s*James/i.test(s)) return { type: 'dailyBooked', rep: 'james' };
  if (/^Daily Booked Cases\s*-\s*William/i.test(s)) return { type: 'dailyBooked', rep: 'william' };
  if (/^MTD Booked Cases\s*-\s*James/i.test(s)) return { type: 'mtdBooked', rep: 'james' };
  if (/^MTD Booked Cases\s*-\s*William/i.test(s)) return { type: 'mtdBooked', rep: 'william' };
  if (/^YTD Booked Cases\s*-\s*James/i.test(s)) return { type: 'ytdBooked', rep: 'james' };
  if (/^YTD Booked Cases\s*-\s*William/i.test(s)) return { type: 'ytdBooked', rep: 'william' };
  if (/^Cases Currently In Progress/i.test(s)) return { type: 'wip' };
  return { type: 'other' };
}
```

Add to `EXPECTED` (`parseEvident.js:61-67`):

```js
const EXPECTED = [
  { type: 'dailyBooked', rep: 'james', label: "Daily Booked Cases - James' Doctors" },
  { type: 'dailyBooked', rep: 'william', label: "Daily Booked Cases - William's Doctors" },
  { type: 'mtdBooked', rep: 'james', label: "MTD Booked Cases - James' Doctors" },
  { type: 'mtdBooked', rep: 'william', label: "MTD Booked Cases - William's Doctors" },
  { type: 'ytdBooked', rep: 'james', label: "YTD Booked Cases - James' Doctors" },
  { type: 'ytdBooked', rep: 'william', label: "YTD Booked Cases - William's Doctors" },
  { type: 'wip', rep: null, label: 'Cases Currently In Progress' },
];
```

Initialize the new bucket in `parseAndAggregate()`
(`parseEvident.js:74`):

```js
  const found = { dailyBooked: {}, mtdBooked: {}, ytdBooked: {}, wip: null };
```

Add a new branch inside the `for (const msg of messages)` loop
(`parseEvident.js:76-139`), after the existing `dailyBooked`/`mtdBooked`
block and before the loop's closing brace — duplicated rather than
sharing a helper with the `dailyBooked`/`mtdBooked` block on purpose (see
Global Constraints: that block stays untouched):

```js
    if (cls.type === 'ytdBooked') {
      let rep = { count: 0, billed: 0, wip: 0, value: 0, hasData: false };
      if (table && table.rows.length > 0) {
        const { headers, rows } = table;
        const totalsRow = rowToObj(headers, rows[rows.length - 1]);
        const countCol = findCol(headers, 'Cases (Total)');
        const billedCol = findCol(headers, 'Total Billed');
        const wipCol = findCol(headers, 'Total WIP');
        const billed = toNum(totalsRow[billedCol]);
        const wip = toNum(totalsRow[wipCol]);
        rep = { count: toNum(totalsRow[countCol]), billed, wip, value: billed + wip, hasData: true };
      }
      found.ytdBooked[cls.rep] = rep;
      continue;
    }

```

Add the combined `ytd` figures to the return object
(`parseEvident.js:141-177`):

```js
  const zero = { count: 0, billed: 0, wip: 0, value: 0, hasData: false };
  const dj = found.dailyBooked.james || zero;
  const dw = found.dailyBooked.william || zero;
  const mj = found.mtdBooked.james || zero;
  const mw = found.mtdBooked.william || zero;
  const yj = found.ytdBooked.james || zero;
  const yw = found.ytdBooked.william || zero;
  const wip = found.wip || {
    cases: 0,
    value: 0,
    kh: { cases: 0, value: 0 },
    aim: { cases: 0, value: 0 },
    byRep: {},
  };

  const missing = EXPECTED.filter((e) => {
    if (e.type === 'wip') return !found.wip;
    return !found[e.type][e.rep];
  }).map((e) => e.label);

  return {
    runDate: runDate || new Date().toISOString().slice(0, 10),
    booked: {
      daily: {
        count: dj.count + dw.count,
        value: dj.value + dw.value,
        byRep: { james: dj, william: dw },
      },
      mtd: {
        count: mj.count + mw.count,
        billed: mj.billed + mw.billed,
        wip: mj.wip + mw.wip,
        value: mj.value + mw.value,
        byRep: { james: mj, william: mw },
      },
      ytd: {
        count: yj.count + yw.count,
        billed: yj.billed + yw.billed,
        wip: yj.wip + yw.wip,
        value: yj.value + yw.value,
        byRep: { james: yj, william: yw },
      },
    },
    wip,
    missing,
  };
```

- [ ] **Step 4: Run the tests, verify they pass**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/evidentReport/parseEvident.js test/evidentReport/parseEvident.test.js test/evidentReport/fixtures/ytd-booked-james.html test/evidentReport/fixtures/ytd-booked-william.html
git commit -m "Parse Evident's YTD Booked Cases email for the Leadership Report"
```

---

### Task 10: Yearly Billed tile

**Files:**
- Modify: `src/services/evidentReport/log.js`
- Modify: `src/services/evidentReport/buildReport.js`

**Interfaces:**
- Consumes: `agg.booked.ytd.billed` (Task 9),
  `evident_report_log.ytd_billed_value` column (Task 1).
- Produces: `buildEmail()`'s `sheetRow.ytd_billed_value`; a 5th summary
  tile ("Billed (YTD)") in the email, with the same delta-vs-yesterday
  treatment as the other four tiles.

- [ ] **Step 1: Wire the new column through `log.js`**

In `src/services/evidentReport/log.js`, add `ytd_billed_value` to
`getHistory()`'s `SELECT` (`log.js:9-18`):

```js
async function getHistory() {
  const { rows } = await db.query(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, booked_daily_count, booked_daily_value,
            booked_mtd_count, booked_mtd_billed, booked_mtd_wip, booked_mtd_value,
            wip_cases, wip_value, aim_wip_value, kh_wip_value, james_wip_value, william_wip_value,
            ytd_billed_value, created_at
     FROM evident_report_log ORDER BY date DESC`
  )
  return rows
}
```

And to `appendRow()`'s `INSERT` (`log.js:24-37`):

```js
async function appendRow(row) {
  await db.query(
    `INSERT INTO evident_report_log
     (date, booked_daily_count, booked_daily_value, booked_mtd_count, booked_mtd_billed,
      booked_mtd_wip, booked_mtd_value, wip_cases, wip_value, aim_wip_value, kh_wip_value,
      james_wip_value, william_wip_value, ytd_billed_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      row.date, row.booked_daily_count, row.booked_daily_value, row.booked_mtd_count,
      row.booked_mtd_billed, row.booked_mtd_wip, row.booked_mtd_value, row.wip_cases,
      row.wip_value, row.aim_wip_value, row.kh_wip_value, row.james_wip_value, row.william_wip_value,
      row.ytd_billed_value,
    ]
  )
}
```

- [ ] **Step 2: Add the tile and delta to `buildReport.js`**

In `src/services/evidentReport/buildReport.js`, add a delta computation
alongside the existing three (`buildReport.js:22-24`):

```js
  const bookedMtdDelta = prior ? delta(agg.booked.mtd.value, Number(prior.booked_mtd_value)) : { text: '', cls: '' };
  const billedMtdDelta = prior ? delta(agg.booked.mtd.billed, Number(prior.booked_mtd_billed)) : { text: '', cls: '' };
  const wipDelta = prior ? delta(agg.wip.value, Number(prior.wip_value)) : { text: '', cls: '' };
  const ytdBilledDelta = prior ? delta(agg.booked.ytd.billed, Number(prior.ytd_billed_value)) : { text: '', cls: '' };
```

Add a 5th tile to the tiles row (`buildReport.js:53-74`), after the "WIP
(in lab)" tile:

```js
    <div style="${tileStyle}">
      <p style="${labelStyle}">Billed (YTD)</p>
      <p style="${valueStyle}">${fmtMoney(agg.booked.ytd.billed)}</p>
      <p style="${deltaStyleFn(ytdBilledDelta.cls)}">${ytdBilledDelta.text}</p>
    </div>
```

Add `ytd_billed_value` to the returned `sheetRow` (`buildReport.js:110-124`):

```js
  const sheetRow = {
    date: agg.runDate,
    booked_daily_count: agg.booked.daily.count,
    booked_daily_value: agg.booked.daily.value,
    booked_mtd_count: agg.booked.mtd.count,
    booked_mtd_billed: agg.booked.mtd.billed,
    booked_mtd_wip: agg.booked.mtd.wip,
    booked_mtd_value: agg.booked.mtd.value,
    wip_cases: agg.wip.cases,
    wip_value: agg.wip.value,
    aim_wip_value: agg.wip.aim.value,
    kh_wip_value: agg.wip.kh.value,
    james_wip_value: agg.wip.byRep.james || 0,
    william_wip_value: agg.wip.byRep.william || 0,
    ytd_billed_value: agg.booked.ytd.billed,
  };
```

- [ ] **Step 3: Update the existing delta test**

In `test/evidentReport/parseEvident.test.js`, the day-over-day delta test
builds a `history` array with a `prior` row missing `ytd_billed_value` —
`Number(undefined)` is `NaN`, and `delta()` would then compute against
`NaN`. Add the field to that test's `history` fixture so the existing
assertion keeps passing unaffected:

```js
test('day-over-day delta shows against a logged prior day', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const history = [{ date: '2026-09-10', booked_mtd_value: '1702.87', booked_mtd_billed: '528.49', wip_value: '46209.54', ytd_billed_value: '7519.13' }];
  const { html } = buildEmail(agg, history);

  assert.match(html, /▲ \$200\.00 vs\. yesterday/);
});
```

- [ ] **Step 4: Run the tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Verify against one synthetic log row**

No staging database exists — test with exactly one synthetic
`evident_report_log` row, then delete it immediately.

```bash
node -e "
require('dotenv').config();
const { getHistory, appendRow } = require('./src/services/evidentReport/log');
const db = require('./src/config/db');
(async () => {
  await appendRow({
    date: '2026-01-02', booked_daily_count: 1, booked_daily_value: 100,
    booked_mtd_count: 1, booked_mtd_billed: 50, booked_mtd_wip: 50, booked_mtd_value: 100,
    wip_cases: 1, wip_value: 100, aim_wip_value: 100, kh_wip_value: 0,
    james_wip_value: 100, william_wip_value: 0, ytd_billed_value: 5000,
  });
  const history = await getHistory();
  const row = history.find(r => r.date === '2026-01-02');
  console.log('ytd_billed_value round-trips:', row && Number(row.ytd_billed_value) === 5000);
  await db.query(\"DELETE FROM evident_report_log WHERE date = '2026-01-02'\");
  console.log('cleaned up');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```
Expected: `ytd_billed_value round-trips: true`, then `cleaned up`.

- [ ] **Step 6: Commit**

```bash
git add src/services/evidentReport/log.js src/services/evidentReport/buildReport.js test/evidentReport/parseEvident.test.js
git commit -m "Add Yearly Billed tile to the Leadership Report"
```

---

### Task 11: 30-day booked/billed trend chart

**Files:**
- Create: `src/services/evidentReport/chart.js`
- Create: `test/evidentReport/chart.test.js`
- Modify: `src/services/evidentReport/buildReport.js`

**Interfaces:**
- Consumes: `historyRows` (already fetched by
  `index.js`/passed into `buildEmail()`), same shape `log.js`'s
  `getHistory()` returns.
- Produces: `buildTrendChartUrl(historyRows)` returning a
  `https://quickchart.io/chart?c=...` URL string, embedded as a plain
  `<img>` in the email body — no server-side fetch, no new dependency.

- [ ] **Step 1: Write the failing test**

Create `test/evidentReport/chart.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTrendChartUrl } = require('../../src/services/evidentReport/chart');

function makeRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    rows.push({
      date: d.toISOString().slice(0, 10),
      booked_mtd_value: String(1000 + i),
      booked_mtd_billed: String(500 + i),
    });
  }
  return rows;
}

test('builds a QuickChart URL with a two-line Chart.js config', () => {
  const url = buildTrendChartUrl(makeRows(10));
  assert.match(url, /^https:\/\/quickchart\.io\/chart\?c=/);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));
  assert.equal(config.type, 'line');
  assert.equal(config.data.datasets.length, 2);
  assert.equal(config.data.labels.length, 10);
});

test('trims to the trailing 30 rows when more history exists', () => {
  const url = buildTrendChartUrl(makeRows(45));
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));
  assert.equal(config.data.labels.length, 30);
  // Ascending order — oldest of the trailing 30 first, most recent last.
  assert.equal(config.data.datasets[0].data[0], 1015); // day index 15 (45-30)
  assert.equal(config.data.datasets[0].data[29], 1044); // day index 44
});

test('handles unsorted input by sorting on date before trimming', () => {
  const rows = makeRows(5).reverse();
  const url = buildTrendChartUrl(rows);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));
  assert.equal(config.data.datasets[0].data[0], 1000);
  assert.equal(config.data.datasets[0].data[4], 1004);
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
node --test test/evidentReport/chart.test.js
```
Expected: fails — `Cannot find module '../../src/services/evidentReport/chart'`.

- [ ] **Step 3: Implement the chart builder**

Create `src/services/evidentReport/chart.js`:

```js
// Builds a QuickChart.io URL for the Leadership Report's 30-day
// booked/billed trend line. No server-side fetch and no client library —
// this is a plain GET URL that the recipient's mail client (or Puppeteer,
// during the PDF render) requests directly. Booked/billed real dollar
// figures are visible in this URL's query string to QuickChart's hosted
// service — confirmed acceptable per the design spec.

function buildTrendChartUrl(historyRows) {
  const rows = (historyRows || [])
    .filter((r) => r.date)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-30);

  const labels = rows.map((r) =>
    new Date(`${r.date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );
  const booked = rows.map((r) => Number(r.booked_mtd_value));
  const billed = rows.map((r) => Number(r.booked_mtd_billed));

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Booked', data: booked, borderColor: '#06babe', fill: false },
        { label: 'Billed', data: billed, borderColor: '#207290', fill: false },
      ],
    },
    options: { plugins: { legend: { display: true } } },
  };

  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}`;
}

module.exports = { buildTrendChartUrl };
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
node --test test/evidentReport/chart.test.js
```
Expected: 3 tests pass.

- [ ] **Step 5: Embed the chart in `buildReport.js`**

In `src/services/evidentReport/buildReport.js`, add the import at the top
of the file:

```js
const { buildTrendChartUrl } = require('./chart');
```

`buildEmail(agg, historyRows = [])` already receives `historyRows` as its
second parameter (used above for the existing deltas) — reuse that same
parameter for the chart, no signature change needed. Embed the chart after
the "Breakdown by rep and brand" table, before the "PDF copy" footer line
(`buildReport.js:102-106`):

```js
  <h3 style="font-size:14px;margin:0 0 8px;color:#374151;">30-Day Booked vs. Billed Trend</h3>
  <img src="${buildTrendChartUrl(historyRows)}" alt="30-day booked vs. billed trend chart" style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:22px;" />

  <p style="font-size:11px;color:#9ca3af;margin-top:22px;">
    A PDF copy of this report is attached.
  </p>
```

- [ ] **Step 6: Run the full suite**

```bash
npm test
```
Expected: all tests pass (the existing "email copy" test's assertions
about `A PDF copy of this report is attached.` and no em dash still hold —
the chart's own copy introduces no em dash either).

- [ ] **Step 7: Commit**

```bash
git add src/services/evidentReport/chart.js src/services/evidentReport/buildReport.js test/evidentReport/chart.test.js
git commit -m "Add 30-day booked/billed trend chart to the Leadership Report"
```

---

## Final Verification (after all tasks)

Per this session's working agreement on leadership-facing reports
([[feedback-preview-before-leadership-sends]]), do not enable either
`*_ENABLED` env var until both of these have been reviewed:

1. `POST /api/reports/sales-rep-daily-report/send` with
   `{ rep_id: '<james-or-william-id>', to: '<your own inbox>', test: true }`
   — confirm the doctor list, submitted/not-submitted counts, and weekly
   goal progress bar look right for a real rep's real data.
2. `POST /api/reports/evident-report/send` (unchanged route, always live —
   no `test` flag, per its existing design) — confirm the renamed subject,
   the new Billed (YTD) tile, and the trend chart image all render
   correctly in a real send before telling stakeholders the rename shipped.

Only after both are reviewed and approved: set `SALES_REP_DAILY_REPORT_ENABLED=true`
on Render (documented in `.env.example`, added alongside `EVIDENT_REPORT_ENABLED`
during Task 5).
