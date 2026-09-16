# Leadership Report Company-Wide Totals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Leadership Report's Booked (Today)/Billed (Today)/Booked
(MTD)/Billed (MTD) figures, which have only ever summed James's and
William's individually-attributed Evident cases (under 2% of real
company-wide revenue), to use real company-wide totals from three
previously-unrecognized Evident report types.

**Architecture:** `parseEvident.js` gains three new single-value (not
per-rep) classifications, parsed the same way `wip` already is —
intercepted before the generic per-rep fallthrough. `buildReport.js`'s
Today tiles switch to these new values directly; Booked (MTD) becomes a
locally-accumulated running sum (no company-wide MTD-booked report exists
from Evident) using one new nullable log column; Billed (MTD) switches to
Evident's own pre-aggregated company-wide figure, with a delta guard
(mirroring the already-proven `ytd_billed_value` transition-day fix) so
the first day this ships doesn't render a fabricated spike comparing new
company-wide data against the old rep-only baseline.

**Tech Stack:** Node.js (CommonJS, no build step), raw SQL via `pg`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-16-leadership-report-company-wide-totals-design.md`

## Global Constraints

- No build step, plain CommonJS throughout.
- The three new report types are parsed **before** the generic
  dailyBooked/mtdBooked/ytdBooked fallthrough block in `parseEvident.js`'s
  loop — the same position `wip` already occupies — never folded into
  that per-rep loop. This is a hard lesson from this same pipeline's own
  history (the Evident YTD-parsing task shipped with exactly this
  ordering bug once already; don't repeat it).
- `parseEvident.js`'s existing `dailyBooked`/`mtdBooked`/`ytdBooked`/`wip`
  parsing logic, and `booked.daily`/`booked.mtd`/`booked.ytd`'s existing
  shape, are **untouched** — this plan only adds new top-level fields
  alongside them.
- The new `evident_report_log.company_daily_booked_value` column is
  **nullable, no default** — this is deliberate (see Task 1) and must not
  be changed to `NOT NULL DEFAULT 0`, which would break the transition-day
  delta guard in Task 4.
- Real fixtures already exist and are committed:
  `test/evidentReport/fixtures/company-daily-booked-nadine.html` (real
  total `8065.22`, 94 real case rows), `company-daily-billed-nadine.html`
  (real total `1622.74`), `company-mtd-total-billed.html` (real total
  `89442.46`) — pulled from the actual Evident inbox on 2026-09-16, not
  synthetic. These exact totals were independently verified against the
  live fixtures using this repo's own `parseTable`/`rowToObj`/`findCol`/
  `toNum` helpers before this plan was written — use them verbatim in
  test assertions, don't re-derive.
- No staging database exists — the one DB-touching verification step in
  this plan (Task 1) uses a read-only schema check only, no data written.
- Sending this to real leadership recipients still requires the standing
  [[feedback-preview-before-leadership-sends]] approval step — this plan
  ends at "verified correct in a local/manual preview," not "sent for
  real."

---

### Task 1: Database migration — nullable `company_daily_booked_value` column

**Files:**
- Create: `scripts/v21-company-daily-booked-migration.sql`

**Interfaces:**
- Produces: `evident_report_log.company_daily_booked_value` (nullable
  `numeric`, no default). Consumed by Task 3 (`log.js`) and Task 4
  (`buildReport.js`'s accumulation + delta guard).

- [ ] **Step 1: Write the migration**

```sql
-- v21-company-daily-booked-migration.sql
-- Supports the Leadership Report's company-wide "Booked (MTD)" figure,
-- accumulated locally day-by-day (no company-wide MTD-booked report
-- exists from Evident — see
-- docs/superpowers/specs/2026-09-16-leadership-report-company-wide-totals-design.md).
--
-- Deliberately NULLABLE with NO DEFAULT — this is not an oversight. A
-- NULL value on this column is how buildReport.js's Billed (MTD) delta
-- guard tells "this row predates the company-wide data source" (genuinely
-- NULL, since the column didn't exist yet) apart from "this row is from
-- the new source and the real figure happened to be zero" (a real `0`,
-- never NULL). A NOT NULL DEFAULT 0 column could not make that
-- distinction, and would reintroduce the exact "phantom spike on the
-- transition day" bug this codebase already found and fixed once for
-- ytd_billed_value.

ALTER TABLE evident_report_log
  ADD COLUMN IF NOT EXISTS company_daily_booked_value numeric;
```

- [ ] **Step 2: Apply the migration**

```bash
node -e "
require('dotenv').config();
const fs = require('fs');
const db = require('./src/config/db');
(async () => {
  await db.query(fs.readFileSync('scripts/v21-company-daily-booked-migration.sql', 'utf-8'));
  console.log('migration applied');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```

- [ ] **Step 3: Verify — schema check only, no data written**

```bash
node -e "
require('dotenv').config();
const db = require('./src/config/db');
(async () => {
  const { rows } = await db.query(\`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'evident_report_log' AND column_name = 'company_daily_booked_value'
  \`);
  console.log(rows);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```
Expected: one row, `is_nullable: 'YES'`, `column_default: null`. If
`column_default` is anything other than `null`, or `is_nullable` is
`'NO'`, the migration is wrong — stop and fix it before proceeding (do not
add a `NOT NULL`/`DEFAULT` clause to "fix" this check; the check existing
this way is the point).

- [ ] **Step 4: Commit**

```bash
git add scripts/v21-company-daily-booked-migration.sql
git commit -m "Add nullable company_daily_booked_value column for Leadership Report MTD accumulation"
```

---

### Task 2: Parse the three new company-wide report types

**Files:**
- Modify: `src/services/evidentReport/parseEvident.js`
- Modify: `test/evidentReport/parseEvident.test.js`

**Interfaces:**
- Consumes: real fixtures `company-daily-booked-nadine.html`,
  `company-daily-billed-nadine.html`, `company-mtd-total-billed.html`
  (already committed).
- Produces: `parseAndAggregate()`'s returned object gains four new
  top-level fields: `companyDailyBooked` (number), `companyDailyBookedCount`
  (number), `companyDailyBilled` (number), `companyMtdBilled` (number).
  `expectedCount` (already dynamically `EXPECTED.length`, no code change
  needed) becomes `10`. Consumed by Task 4 (`buildReport.js`).

- [ ] **Step 1: Add the three `classify()` branches**

In `src/services/evidentReport/parseEvident.js`, add these three lines to
`classify()` — **immediately after** the existing `Cases Currently In
Progress` line, before the `return { type: 'other' }` fallback:

```js
  if (/^Cases Currently In Progress/i.test(s)) return { type: 'wip' };
  if (/^Daily Booking Report\s*-\s*Nadine/i.test(s)) return { type: 'companyDailyBooked' };
  if (/^Daily Billed Report\s*-\s*Nadine/i.test(s)) return { type: 'companyDailyBilled' };
  if (/^Daily MTD Total Billed/i.test(s)) return { type: 'companyMtdBilled' };
  return { type: 'other' };
```

- [ ] **Step 2: Add three `EXPECTED` entries**

Immediately after the existing `wip` entry in the `EXPECTED` array:

```js
const EXPECTED = [
  { type: 'dailyBooked', rep: 'james', label: "Daily Booked Cases - James' Doctors" },
  { type: 'dailyBooked', rep: 'william', label: "Daily Booked Cases - William's Doctors" },
  { type: 'mtdBooked', rep: 'james', label: "MTD Booked Cases - James' Doctors" },
  { type: 'mtdBooked', rep: 'william', label: "MTD Booked Cases - William's Doctors" },
  { type: 'ytdBooked', rep: 'james', label: "YTD Booked Cases - James' Doctors" },
  { type: 'ytdBooked', rep: 'william', label: "YTD Booked Cases - William's Doctors" },
  { type: 'wip', rep: null, label: 'Cases Currently In Progress' },
  { type: 'companyDailyBooked', rep: null, label: 'Daily Booking Report - Nadine' },
  { type: 'companyDailyBilled', rep: null, label: 'Daily Billed Report - Nadine' },
  { type: 'companyMtdBilled', rep: null, label: 'Daily MTD Total Billed' },
];
```

- [ ] **Step 3: Initialize the three new `found` slots**

Change the `found` initializer at the top of `parseAndAggregate()`:

```js
  const found = {
    dailyBooked: {}, mtdBooked: {}, ytdBooked: {}, wip: null,
    companyDailyBooked: null, companyDailyBilled: null, companyMtdBilled: null,
  };
```

- [ ] **Step 4: Add the three parsing branches**

Immediately after the existing `if (cls.type === 'wip') { ... continue }`
block (still before the `if (cls.type === 'ytdBooked')` block — order
among these doesn't matter, only that all of them precede the generic
per-rep fallthrough):

```js
    if (cls.type === 'companyDailyBooked') {
      if (!table || table.rows.length === 0) { found.companyDailyBooked = 0; found.companyDailyBookedCount = 0; continue; }
      const { headers, rows } = table;
      const totalsRow = rowToObj(headers, rows[rows.length - 1]);
      const totalCol = findCol(headers, 'Sales Value (Total)');
      found.companyDailyBooked = toNum(totalsRow[totalCol]);
      found.companyDailyBookedCount = rows.length - 1;
      continue;
    }

    if (cls.type === 'companyDailyBilled') {
      if (!table || table.rows.length === 0) { found.companyDailyBilled = 0; continue; }
      const { headers, rows } = table;
      const totalsRow = rowToObj(headers, rows[rows.length - 1]);
      const billedCol = findCol(headers, 'Total Billed');
      found.companyDailyBilled = toNum(totalsRow[billedCol]);
      continue;
    }

    if (cls.type === 'companyMtdBilled') {
      if (!table || table.rows.length === 0) { found.companyMtdBilled = 0; continue; }
      const { headers, rows } = table;
      const totalsRow = rowToObj(headers, rows[rows.length - 1]);
      const billedCol = findCol(headers, 'Total Billed');
      found.companyMtdBilled = toNum(totalsRow[billedCol]);
      continue;
    }
```

- [ ] **Step 5: Update the `missing` filter**

The existing filter only special-cases `wip` (single-value) vs. the
default per-rep lookup. Add the three new single-value types alongside
it:

```js
  const missing = EXPECTED.filter((e) => {
    if (e.type === 'wip') return !found.wip;
    if (e.type === 'companyDailyBooked') return found.companyDailyBooked === null;
    if (e.type === 'companyDailyBilled') return found.companyDailyBilled === null;
    if (e.type === 'companyMtdBilled') return found.companyMtdBilled === null;
    return !found[e.type][e.rep];
  }).map((e) => e.label);
```

- [ ] **Step 6: Add the four new fields to the returned object**

In `parseAndAggregate()`'s `return { ... }` statement, add these
alongside the existing `wip`/`missing` fields (`booked` stays completely
unchanged):

```js
  return {
    runDate: runDate || new Date().toISOString().slice(0, 10),
    expectedCount: EXPECTED.length,
    booked: { /* unchanged */ daily: { count: dj.count + dw.count, billed: dj.billed + dw.billed, value: dj.value + dw.value, byRep: { james: dj, william: dw } }, mtd: { count: mj.count + mw.count, billed: mj.billed + mw.billed, wip: mj.wip + mw.wip, value: mj.value + mw.value, byRep: { james: mj, william: mw } }, ytd: { count: yj.count + yw.count, billed: yj.billed + yw.billed, wip: yj.wip + yw.wip, value: yj.value + yw.value, byRep: { james: yj, william: yw } } },
    wip,
    companyDailyBooked: found.companyDailyBooked || 0,
    companyDailyBookedCount: found.companyDailyBookedCount || 0,
    companyDailyBilled: found.companyDailyBilled || 0,
    companyMtdBilled: found.companyMtdBilled || 0,
    missing,
  };
```

(The `booked: { ... }` block above is written inline for brevity in this
brief — in the actual file, keep it exactly as it already is today,
unchanged; only add the four new sibling fields after `wip,`.)

- [ ] **Step 7: Update `test/evidentReport/parseEvident.test.js`**

Replace the `ALL_MESSAGES` array's comment and contents to include the
three new real fixtures:

```js
// These fixtures are real emails pulled from media@aimdentallab.com
// (Sept 10-12 2026, plus 3 company-wide report types added 2026-09-16),
// not synthetic data - the numbers asserted below are the actual totals
// Evident sent.
const ALL_MESSAGES = [
  { subject: "Daily Booked Cases - James' Doctors", html: fixture('daily-booked-james.html') },
  { subject: "Daily Booked Cases - William's Doctors", html: fixture('daily-booked-william-nodata.html') },
  { subject: "MTD Booked Cases - James' Doctors", html: fixture('mtd-booked-james.html') },
  { subject: "MTD Booked Cases - William's Doctors", html: fixture('mtd-booked-william.html') },
  { subject: 'Cases Currently In Progress', html: fixture('wip-cases-in-progress.html') },
  { subject: "YTD Booked Cases - James' Doctors", html: fixture('ytd-booked-james.html') },
  { subject: "YTD Booked Cases - William's Doctors", html: fixture('ytd-booked-william.html') },
  { subject: 'Daily Booking Report - Nadine', html: fixture('company-daily-booked-nadine.html') },
  { subject: 'Daily Billed Report - Nadine', html: fixture('company-daily-billed-nadine.html') },
  { subject: 'Daily MTD Total Billed', html: fixture('company-mtd-total-billed.html') },
];
```

Rename the first test and add the four new assertions (keep every
existing assertion in this test unchanged — only the title and the four
new lines are new):

```js
test('parses and combines all 10 report types correctly', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });

  assert.equal(agg.missing.length, 0);

  // Daily: only James had a booking (1 case, $117 WIP, $0 billed); William had none.
  assert.equal(agg.booked.daily.count, 1);
  assert.equal(agg.booked.daily.billed, 0);
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

  // Company-wide totals — real numbers from the 2026-09-16 Evident inbox.
  assert.equal(agg.companyDailyBooked, 8065.22);
  assert.equal(agg.companyDailyBookedCount, 94);
  assert.equal(agg.companyDailyBilled, 1622.74);
  assert.equal(agg.companyMtdBilled, 89442.46);
});
```

Update the missing-count assertion (`EXPECTED` grew from 7 to 10, so
providing 1 of 10 leaves 9 missing, not 6):

```js
test('flags missing reports instead of silently under-reporting', () => {
  const agg = parseAndAggregate(
    [{ subject: "Daily Booked Cases - James' Doctors", html: fixture('daily-booked-james.html') }],
    { runDate: '2026-09-11' }
  );
  assert.equal(agg.missing.length, 9);
  assert.ok(agg.missing.includes('Cases Currently In Progress'));
  assert.ok(agg.missing.includes('Daily Booking Report - Nadine'));
});
```

- [ ] **Step 8: Run the tests**

```bash
npm test
```
Expected: all tests pass (the two other existing tests in this file —
"No data was returned", "email copy has no em dashes" — are unaffected by
this task's changes and should keep passing unchanged; Task 4 will update
the delta test separately). If "email copy has no em dashes" or the
delta test fail at this point, that's expected and will be fixed in Task
4 — do not attempt to fix `buildReport.js`-dependent test failures in
this task; only `parseEvident.js` and the additions above are this task's
scope. If instead one of the NEW assertions in Step 7 fails, that's a
real bug in Steps 1-6 — fix it there.

- [ ] **Step 9: Commit**

```bash
git add src/services/evidentReport/parseEvident.js test/evidentReport/parseEvident.test.js
git commit -m "Parse 3 real company-wide Evident report types (Daily Booking/Billed Report - Nadine, Daily MTD Total Billed)"
```

---

### Task 3: Wire the new column through `log.js`

**Files:**
- Modify: `src/services/evidentReport/log.js`

**Interfaces:**
- Consumes: `evident_report_log.company_daily_booked_value` (Task 1).
- Produces: `getHistory()`'s rows include `company_daily_booked_value`
  (string or `null`, mirroring the column's own nullability — `pg`
  returns SQL `NULL` as JS `null`, not `undefined`). `appendRow()` accepts
  and writes `row.company_daily_booked_value`. Consumed by Task 4.

- [ ] **Step 1: Add the column to `getHistory()`'s SELECT**

```js
async function getHistory() {
  const { rows } = await db.query(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, booked_daily_count, booked_daily_value,
            booked_mtd_count, booked_mtd_billed, booked_mtd_wip, booked_mtd_value,
            wip_cases, wip_value, aim_wip_value, kh_wip_value, james_wip_value, william_wip_value,
            ytd_billed_value, company_daily_booked_value, created_at
     FROM evident_report_log ORDER BY date DESC`
  )
  return rows
}
```

- [ ] **Step 2: Add the column to `appendRow()`'s INSERT**

Do **not** default `row.company_daily_booked_value` to `0` — write
exactly what's passed, including a genuine `null`/`undefined` if the
caller doesn't supply it (`row.company_daily_booked_value ?? null` keeps
it explicit rather than relying on Postgres's own NULL-on-omission
behavior for a named placeholder):

```js
async function appendRow(row) {
  await db.query(
    `INSERT INTO evident_report_log
     (date, booked_daily_count, booked_daily_value, booked_mtd_count, booked_mtd_billed,
      booked_mtd_wip, booked_mtd_value, wip_cases, wip_value, aim_wip_value, kh_wip_value,
      james_wip_value, william_wip_value, ytd_billed_value, company_daily_booked_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      row.date, row.booked_daily_count, row.booked_daily_value, row.booked_mtd_count,
      row.booked_mtd_billed, row.booked_mtd_wip, row.booked_mtd_value, row.wip_cases,
      row.wip_value, row.aim_wip_value, row.kh_wip_value, row.james_wip_value, row.william_wip_value,
      row.ytd_billed_value, row.company_daily_booked_value ?? null,
    ]
  )
}
```

- [ ] **Step 3: Verify against one synthetic row**

No staging database exists — test with exactly one synthetic row, then
delete it immediately.

```bash
node -e "
require('dotenv').config();
const { getHistory, appendRow } = require('./src/services/evidentReport/log');
const db = require('./src/config/db');
(async () => {
  await appendRow({
    date: '2026-01-03', booked_daily_count: 1, booked_daily_value: 100,
    booked_mtd_count: 1, booked_mtd_billed: 50, booked_mtd_wip: 50, booked_mtd_value: 100,
    wip_cases: 1, wip_value: 100, aim_wip_value: 100, kh_wip_value: 0,
    james_wip_value: 100, william_wip_value: 0, ytd_billed_value: 5000,
    company_daily_booked_value: 250,
  });
  const history = await getHistory();
  const row = history.find(r => r.date === '2026-01-03');
  console.log('company_daily_booked_value round-trips:', row && Number(row.company_daily_booked_value) === 250);
  await db.query(\"DELETE FROM evident_report_log WHERE date = '2026-01-03'\");
  console.log('cleaned up');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```
Expected: `company_daily_booked_value round-trips: true`, then `cleaned up`.

- [ ] **Step 4: Commit**

```bash
git add src/services/evidentReport/log.js
git commit -m "Wire company_daily_booked_value through log.js's getHistory/appendRow"
```

---

### Task 4: Switch the report tiles to company-wide totals

**Files:**
- Modify: `src/services/evidentReport/buildReport.js`
- Modify: `test/evidentReport/parseEvident.test.js`

**Interfaces:**
- Consumes: `agg.companyDailyBooked`, `agg.companyDailyBookedCount`,
  `agg.companyDailyBilled`, `agg.companyMtdBilled` (Task 2);
  `historyRows[].company_daily_booked_value` (Task 3).
- Produces: updated tile rendering; `sheetRow.company_daily_booked_value`
  for Task 3's `appendRow()` to persist.

- [ ] **Step 1: Add the Booked (MTD) accumulation and the Billed (MTD) delta guard**

In `buildEmail()`, after the existing `prior` lookup and before the
existing delta computations, add the month-accumulation logic:

```js
  const prior = historyRows
    .filter((r) => r.date && r.date < agg.runDate)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];

  // Booked (MTD) has no Evident-provided company-wide equivalent — we
  // accumulate it ourselves from each day's own company-wide "Booked
  // (Today)" figure, logged daily. Sum every history row in the same
  // calendar month as today, plus today's own value (not yet in
  // historyRows at build time — appendRow() runs after this).
  const runMonth = agg.runDate.slice(0, 7); // 'YYYY-MM'
  const mtdBookedFromHistory = historyRows
    .filter((r) => r.date && r.date.slice(0, 7) === runMonth)
    .reduce((sum, r) => sum + Number(r.company_daily_booked_value || 0), 0);
  const companyMtdBooked = mtdBookedFromHistory + agg.companyDailyBooked;

  const bookedMtdDelta = prior ? delta(agg.booked.mtd.value, Number(prior.booked_mtd_value)) : { text: '', cls: '' };
  // Billed (MTD) now reads Evident's own company-wide "Daily MTD Total
  // Billed" figure instead of the James+William-only sum. A `prior` row
  // whose company_daily_booked_value is NULL predates this change (the
  // column is nullable with no default specifically so this check works —
  // see the migration's own comment) — its booked_mtd_billed value is
  // from the OLD, much-smaller data source, so comparing against it would
  // render a fabricated multi-thousand-dollar "spike" on the very first
  // day this ships. Same guard pattern already proven for ytd_billed_value.
  const billedMtdDelta = prior && prior.company_daily_booked_value != null
    ? delta(agg.companyMtdBilled, Number(prior.booked_mtd_billed))
    : { text: '', cls: '' };
```

Remove the old `bookedMtdDelta`/`billedMtdDelta` lines that previously
existed at this location (the two lines being replaced are: `const
bookedMtdDelta = prior ? delta(agg.booked.mtd.value, ...` — this one
**stays exactly as-is**, it's unrelated to this task, still comparing
`agg.booked.mtd.value` for a metric this task doesn't touch — do not
confuse it with the new `companyMtdBooked` value below, which is used
without a delta; and the old `const billedMtdDelta = prior ? delta(agg.booked.mtd.billed, Number(prior.booked_mtd_billed)) ...` **is replaced** by the new guarded version above, which reads `agg.companyMtdBilled` instead of `agg.booked.mtd.billed`).

- [ ] **Step 2: Update the Booked (Today) / Billed (Today) hero tiles**

```js
    <div style="flex:1;background-color:#e6f9f9;background-image:linear-gradient(160deg,#e6f9f9,#eaf3f7);border:1px solid #06babe;border-radius:12px;padding:20px 22px;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#207290;text-transform:uppercase;letter-spacing:.04em;">Booked (Today)</p>
      <p style="margin:0;font-size:36px;font-weight:700;color:#06babe;letter-spacing:-.01em;">${fmtMoney(agg.companyDailyBooked)}</p>
      <p style="margin:6px 0 0;font-size:13px;color:#374151;">${agg.companyDailyBookedCount} case${agg.companyDailyBookedCount === 1 ? '' : 's'}</p>
    </div>
    <div style="flex:1;background-color:#e6f9f9;background-image:linear-gradient(160deg,#e6f9f9,#eaf3f7);border:1px solid #06babe;border-radius:12px;padding:20px 22px;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#207290;text-transform:uppercase;letter-spacing:.04em;">Billed (Today)</p>
      <p style="margin:0;font-size:36px;font-weight:700;color:#06babe;letter-spacing:-.01em;">${fmtMoney(agg.companyDailyBilled)}</p>
    </div>
```

(Only the two values inside `fmtMoney(...)` and the count in the
subtitle change — `agg.booked.daily.value` → `agg.companyDailyBooked`,
`agg.booked.daily.count` → `agg.companyDailyBookedCount`,
`agg.booked.daily.billed` → `agg.companyDailyBilled`. All surrounding
markup/styles stay exactly as they are.)

- [ ] **Step 3: Update the Booked (MTD) / Billed (MTD) tiles**

```js
    <div style="${tileStyle}">
      <p style="${labelStyle}">Booked (MTD)</p>
      <p style="${valueStyle}">${fmtMoney(companyMtdBooked)}</p>
    </div>
    <div style="${tileStyle}">
      <p style="${labelStyle}">Billed (MTD)</p>
      <p style="${valueStyle}">${fmtMoney(agg.companyMtdBilled)}</p>
      <p style="${deltaStyleFn(billedMtdDelta.cls)}">${billedMtdDelta.text}</p>
    </div>
```

Note the Booked (MTD) tile **loses its delta `<p>` line entirely** — per
the spec, a self-accumulated running sum's "today vs. yesterday" delta is
mathematically always identical to the Booked (Today) tile's own value,
so showing it a second time here would read as a duplicate/bug, not real
information. This is intentional; do not add a delta line back.

The Billed (YTD) tile (third in this row) is **unchanged** — still reads
`agg.booked.ytd.billed` with its existing zero-guard `ytdBilledDelta`.

- [ ] **Step 4: Add `company_daily_booked_value` to `sheetRow`**

```js
  const sheetRow = {
    date: agg.runDate,
    booked_daily_count: agg.booked.daily.count,
    booked_daily_value: agg.booked.daily.value,
    booked_mtd_count: agg.booked.mtd.count,
    booked_mtd_billed: agg.companyMtdBilled,
    booked_mtd_wip: agg.booked.mtd.wip,
    booked_mtd_value: agg.booked.mtd.value,
    wip_cases: agg.wip.cases,
    wip_value: agg.wip.value,
    aim_wip_value: agg.wip.aim.value,
    kh_wip_value: agg.wip.kh.value,
    james_wip_value: agg.wip.byRep.james || 0,
    william_wip_value: agg.wip.byRep.william || 0,
    ytd_billed_value: agg.booked.ytd.billed,
    company_daily_booked_value: agg.companyDailyBooked,
  };
```

Note `booked_mtd_billed` now gets `agg.companyMtdBilled` (the new
company-wide source) instead of `agg.booked.mtd.billed` — this is the
"repurpose the existing column" half of the design (see the spec's
"Database" section for why no new column is needed for this one).
`booked_daily_count`/`booked_daily_value` keep logging the old
James+William daily figures unchanged — nothing currently reads them for
a delta, but there's no reason to stop logging real data that's already
being computed.

- [ ] **Step 5: Update the two affected tests in `parseEvident.test.js`**

The "email copy has no em dashes" test needs no assertion changes (still
passes once Steps 1-4 land) — but re-run it as part of Step 6 below to
confirm.

Replace the day-over-day delta test — it previously verified the
Booked-MTD delta (now removed); repurpose it to verify the Billed-MTD
delta instead, using a `prior` row that has `company_daily_booked_value`
set (so the new guard allows a real delta) and a `booked_mtd_billed`
value chosen so the delta against the real `agg.companyMtdBilled`
(`89442.46`) comes out to the same clean `$200.00` the test already
checks for:

```js
test('Billed (MTD) delta shows against a logged prior day (guard allows it once company-wide tracking exists)', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const history = [{
    date: '2026-09-10', booked_mtd_value: '1702.87', booked_mtd_billed: '89242.46',
    wip_value: '46209.54', ytd_billed_value: '7519.13', company_daily_booked_value: '100',
  }];
  const { html } = buildEmail(agg, history);

  assert.match(html, /▲ \$200\.00 vs\. yesterday/);
});

test('Billed (MTD) shows no delta when the prior row predates company-wide tracking', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const history = [{
    date: '2026-09-10', booked_mtd_value: '1702.87', booked_mtd_billed: '1124.46',
    wip_value: '46209.54', ytd_billed_value: '0', company_daily_booked_value: null,
  }];
  const { html } = buildEmail(agg, history);

  assert.ok(!html.includes('vs. yesterday'), 'no delta anywhere — both the Billed (MTD) guard and the existing Billed (YTD) zero-guard should suppress their deltas on a pre-transition prior row');
});

test('Booked (MTD) accumulates from logged same-month days plus today', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-16' });
  const history = [
    { date: '2026-09-14', company_daily_booked_value: '500' },
    { date: '2026-09-15', company_daily_booked_value: '300' },
    { date: '2026-08-30', company_daily_booked_value: '9999' },
  ];
  const { html } = buildEmail(agg, history);

  // 500 + 300 (same-month history) + 8065.22 (today's real companyDailyBooked) = 8865.22.
  // The 2026-08-30 row must NOT be included (different month).
  assert.match(html, /\$8,865\.22/);
});
```

(Replace the single old `test('day-over-day delta shows against a logged
prior day', ...)` with these three new tests — the old test's exact
assertion moves into the first of the three, repurposed for Billed (MTD)
instead of Booked (MTD).)

- [ ] **Step 6: Run the full test suite**

```bash
npm test
```
Expected: all tests pass (should be 17 total — the prior 14, minus the 1
replaced delta test, plus the 3 new ones in Step 5 = 16... recount at
implementation time and confirm the actual total rather than assuming;
the important thing is 0 failures, not hitting an exact pre-guessed
count).

- [ ] **Step 7: Live verification against real data**

This is the one step in this plan that touches real production data
end-to-end (read-only — no send, no log write). Confirm the real pipeline
produces the numbers this plan expects, using the real Gmail credentials
already configured on Render (not available locally — this step requires
the three `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`
values; if running locally without them in `.env`, pass them inline on
the command for this one invocation only, never committed to a file):

```bash
node -e "
require('dotenv').config();
const { fetchEvidentEmails } = require('./src/services/evidentReport/gmailFetch');
const { parseAndAggregate } = require('./src/services/evidentReport/parseEvident');
const { buildEmail } = require('./src/services/evidentReport/buildReport');
const { getHistory } = require('./src/services/evidentReport/log');
function todayEasternDateString() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
(async () => {
  const runDate = todayEasternDateString();
  const messages = await fetchEvidentEmails();
  const aggregate = parseAndAggregate(messages, { runDate });
  console.log('missing:', aggregate.missing);
  console.log('companyDailyBooked:', aggregate.companyDailyBooked);
  console.log('companyDailyBilled:', aggregate.companyDailyBilled);
  console.log('companyMtdBilled:', aggregate.companyMtdBilled);
  const historyRows = await getHistory();
  const { html } = buildEmail(aggregate, historyRows);
  require('fs').writeFileSync('/tmp-leadership-report-preview.html', html);
  console.log('wrote preview HTML');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```

Expected: `missing: []` (all 10 report types found — if not, this is a
real signal something about today's specific inbox differs, not
necessarily a bug; note what's missing and use judgment), real nonzero
`companyDailyBooked`/`companyDailyBilled`/`companyMtdBilled` values, and a
written preview file. Open the preview file and visually confirm the
Booked (Today)/Billed (Today) hero tiles and the Booked (MTD)/Billed
(MTD) tiles show real, sensible numbers — this is the last check before
this is ready for the user's own inbox preview (a separate, already-
existing manual step per [[feedback-preview-before-leadership-sends]],
not part of this plan).

- [ ] **Step 8: Commit**

```bash
git add src/services/evidentReport/buildReport.js test/evidentReport/parseEvident.test.js
git commit -m "Switch Leadership Report Today/MTD tiles to real company-wide Evident totals"
```

---

## Final Verification (after all tasks)

- `npm test` — full suite passes.
- `node -c` on all four touched files (`parseEvident.js`, `buildReport.js`,
  `log.js`, and the migration is SQL so N/A) — no syntax errors.
- Task 4 Step 7's live preview already confirms the real pipeline produces
  sensible output end-to-end.
- Per the standing [[feedback-preview-before-leadership-sends]] rule: the
  next real send (whenever the user next triggers
  `POST /api/reports/evident-report/send`) goes to the user's own inbox
  first for review — this plan does not itself send anything to real
  leadership recipients, and neither `EVIDENT_REPORT_ENABLED` nor any
  other automated-send gate changes as part of this work.
