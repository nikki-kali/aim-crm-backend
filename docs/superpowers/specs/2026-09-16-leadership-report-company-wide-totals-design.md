# Leadership Report — Company-Wide Totals — Design

## Problem

The Leadership Report's "Booked (Today)"/"Billed (Today)"/"Booked (MTD)"/
"Billed (MTD)" figures have only ever summed James's and William's
*individually-attributed* Evident cases. Real inspection of today's actual
Evident inbox (2026-09-16, 12 real emails) found three report types the
parser has never recognized, sent to `media@aimdentallab.com` daily
alongside the seven already-handled ones:

- **"Daily Booking Report - Nadine"** — real company-wide total booked
  today: **$8,065.22** (vs. the $0.00 the James+William-only sum showed).
- **"Daily Billed Report - Nadine"** — real company-wide total billed
  today: **$1,622.74** (vs. $0.00).
- **"Daily MTD Total Billed"** — Evident's own pre-aggregated company-wide
  MTD billed figure, broken out by brand and by named salesperson:
  **$89,442.46** total ($52,342.58 Kings Highway + $37,099.88 AIM), of
  which only **$1,956.42** ($1,458.97 James + $497.45 William) is
  attributed to a named rep — the other **$87,486.04** is real client
  billing Evident never tags to a person. The James+William-only sum this
  report has shown ($1,124.46 as of the one real logged day) is under 2%
  of the true figure.

This is a real accuracy gap, not a cosmetic one — the report has been
showing a small, misleading slice of real revenue since it shipped.

## Decisions from stakeholder review

- **Booked (Today) / Billed (Today)**: switch to the real company-wide
  totals from "Daily Booking Report - Nadine" / "Daily Billed Report -
  Nadine".
- **Billed (MTD)**: switch to Evident's own "Daily MTD Total Billed"
  grand-total column (company-wide, pre-aggregated by Evident itself — no
  accumulation needed on our side).
- **Booked (MTD)**: no company-wide "MTD Booked" report exists from
  Evident. Per the user: derive it ourselves by accumulating each day's
  real company-wide "Booked (Today)" figure (logged daily, same pattern as
  every other log-driven figure) and summing all logged days within the
  current calendar month, including today. Starts accumulating from the
  day this ships — no retroactive backfill (same "no backfill" precedent
  already set for `ytd_billed_value`).
- **Billed (YTD)**: stays James+William-only. No real company-wide YTD
  data source exists yet; confirmed not to guess one into existence.
- **These 3 new report types join the "critical" (non-YTD) set** that
  gates whether today's row gets logged at all — without them there's no
  real Today/Billed-MTD data to show, which is worse than the existing
  missing-reports protection is designed to prevent.
- **"James/William Doctors Daily Report"** (also seen in today's inbox,
  previously unrecognized) is a duplicate feed of the same data "Daily
  Booked Cases - James'/William's Doctors" already covers — confirmed by
  inspecting its content (identical filter shape: `date (booking)>=Today,
  sales rep=james/william`). Not a new data source; left unhandled on
  purpose, same as before.

## Report shapes (confirmed against real fixtures)

**"Daily Booking Report - Nadine"** — columns: `Ref`, `Case Number`,
`Customer Code`, `Customer Name`, `Sales Value (Total)`, `Salesperson`.
Grand total is the last table row's `Sales Value (Total)` cell. Real
fixture: `test/evidentReport/fixtures/company-daily-booked-nadine.html`
(total `8065.22`, 94 real case rows before the totals row).

**"Daily Billed Report - Nadine"** — columns: `Ref`, `Case Number`,
`Customer Code`, `Customer Name`, `Sales Value (Total)`, `Sales Value
(Total Billed)`, `Salesperson`. Grand total is the last row's `Sales Value
(Total Billed)` cell (equals `Sales Value (Total)` in the totals row for
this report, since it only lists already-billed items). Real fixture:
`company-daily-billed-nadine.html` (total `1622.74`, 35 rows).

**"Daily MTD Total Billed"** — columns: `Ref`, `Company`, `Sales Value
(Total Billed)`, `N/A` (Evident's own literal header text for the
unattributed-to-a-rep column), `Delaney, James`, `Alexander, WIlliam`
(sic). Three rows: a Kings Highway row, an AIM row, and a grand-total row
— the grand total is the last row's `Sales Value (Total Billed)` cell.
Real fixture: `company-mtd-total-billed.html` (total `89442.46`).

## Parsing (`parseEvident.js`)

Three new `classify()` branches, matched **before** the generic
dailyBooked/mtdBooked fallthrough (same lesson from the earlier ytdBooked
ordering bug — these are single-value, not per-rep, so they're intercepted
the same way `wip` already is, not folded into the per-rep loop):

```js
if (/^Daily Booking Report\s*-\s*Nadine/i.test(s)) return { type: 'companyDailyBooked' }
if (/^Daily Billed Report\s*-\s*Nadine/i.test(s)) return { type: 'companyDailyBilled' }
if (/^Daily MTD Total Billed/i.test(s)) return { type: 'companyMtdBilled' }
```

Three new `EXPECTED` entries (`rep: null`, matching the existing `wip`
entry's shape) — `EXPECTED.length` grows from 7 to 10, and `expectedCount`
(already dynamically derived, no further change needed there) reflects
this automatically in the missing-reports banner.

Each new type's parsing: `parseTable()` the message, take the **last**
row as the totals row (same `rows[rows.length - 1]` pattern already used
throughout this file), `findCol()` the relevant "Total"/"Total Billed"
column, `toNum()` it. Stored as single values in `found` (not per-rep,
matching `found.wip`'s shape): `found.companyDailyBooked`,
`found.companyDailyBookedCount` (the row count excluding the totals row —
replaces the James+William-only case count the "Booked (Today)" tile's
subtitle currently shows), `found.companyDailyBilled`,
`found.companyMtdBilled`.

`parseAndAggregate()`'s returned object gains three top-level fields
(alongside the existing `booked`/`wip`/`missing`/`expectedCount`):
`companyDailyBooked`, `companyDailyBookedCount`, `companyDailyBilled`,
`companyMtdBilled`. The existing `booked.daily`/`booked.mtd`/`booked.ytd`
per-rep structure is **untouched** — `booked.ytd.billed` still feeds
"Billed (YTD)" exactly as today.

## Database: one new column, one repurposed column

New migration, additive:

```sql
ALTER TABLE evident_report_log ADD COLUMN IF NOT EXISTS company_daily_booked_value numeric;
```

Deliberately **nullable, no default** — this is what lets "Booked (MTD)"
tell old rows (logged before this change, genuinely never measured this
metric) apart from new rows (always populated, even with a real `0`). A
`NOT NULL DEFAULT 0` column can't make that distinction, which matters for
avoiding a repeat of the YTD-billed "phantom spike on the transition day"
bug this session already found and fixed once.

`booked_mtd_billed` (existing column) is **repurposed, not
schema-changed** — going forward it stores `agg.companyMtdBilled` (the new
company-wide source) instead of the old James+William sum. The one
existing real row (2026-09-15, value `1124.46`) was logged under the old
method — see "Guarding the transition" below for why this doesn't produce
a misleading delta on the first day the new source goes live.

## `buildReport.js` changes

- **Booked (Today)** tile: value becomes `agg.companyDailyBooked`;
  subtitle becomes `agg.companyDailyBookedCount` cases (was
  `agg.booked.daily.count`).
- **Billed (Today)** tile: value becomes `agg.companyDailyBilled` (was
  `agg.booked.daily.billed`). No subtitle, same as today.
- **Booked (MTD)** tile: value becomes an accumulated sum — every row in
  `historyRows` whose `date` falls in the same calendar month as
  `agg.runDate`, summing `company_daily_booked_value` (treating a
  null/old-era row as `0`), **plus** `agg.companyDailyBooked` (today's own
  figure, not yet in `historyRows` at build time). No delta subtitle: since
  this is a value we accumulate ourselves one day at a time, "today's
  cumulative minus yesterday's cumulative" is mathematically always
  identical to "today's own daily figure" — showing it as a second "vs.
  yesterday" line would just duplicate the Booked (Today) tile's own
  number and read as a copy-paste bug to a leadership reader. Plain value,
  no subtitle (matching Billed (Today)'s existing minimal treatment).
- **Billed (MTD)** tile: value becomes `agg.companyMtdBilled` (was
  `agg.booked.mtd.billed`). Delta stays vs. `prior.booked_mtd_billed`,
  **guarded**: only compute a delta when `prior.company_daily_booked_value`
  is not null — see below.
- **Billed (YTD)** tile: **unchanged** (`agg.booked.ytd.billed`, existing
  zero-guard from the earlier fix stays as-is).

### Guarding the transition (avoiding a repeat of the YTD-billed bug)

`prior.company_daily_booked_value` being non-null is a reliable signal
that a log row was written *after* this change shipped (the column is
nullable with no default, so every pre-existing row has it genuinely
`NULL`, and every new row always sets it — even to `0` on a slow day).
Using that as the guard for the Billed (MTD) delta means:

```js
const billedMtdDelta = prior && prior.company_daily_booked_value !== null
  ? delta(agg.companyMtdBilled, Number(prior.booked_mtd_billed))
  : { text: '', cls: '' };
```

On the first real day this ships, `prior` is the 2026-09-15 row (old-era,
`company_daily_booked_value` genuinely `NULL`) — delta shows "no prior
data" instead of a fabricated `▲$88,318.00` spike (comparing new
$89,442.46 against the old method's $1,124.46). From the second real day
onward, `prior` is itself a new-era row, and the comparison is real,
apples-to-apples company-wide MTD billed vs. the day before.

## `log.js` changes

`getHistory()`'s SELECT and `appendRow()`'s INSERT both gain
`company_daily_booked_value` (nullable — `appendRow` writes
`row.company_daily_booked_value ?? null`, not defaulting to `0`, so a
day where this value genuinely wasn't computed — should never happen once
this ships, but matters for the transition row itself — doesn't silently
look identical to a real `$0` day).

`buildReport.js`'s `sheetRow` gains `company_daily_booked_value:
agg.companyDailyBooked`.

## Testing

Three new real fixtures already saved (pulled from today's actual inbox,
not synthetic): `test/evidentReport/fixtures/company-daily-booked-nadine.html`
(`8065.22`), `company-daily-billed-nadine.html` (`1622.74`),
`company-mtd-total-billed.html` (`89442.46`) — same "real email, ground
truth" discipline as every other fixture in this test suite.

New test cases in `parseEvident.test.js`: parsing each of the three new
types in isolation (asserting the exact real totals above), the combined
10-report `parseAndAggregate` case, a `missing` case with one of the three
new types absent (confirms it's treated as critical, not silently
optional like YTD), and the delta-guard behavior (a `prior` row with
`company_daily_booked_value: null` produces "no prior data" for Billed
(MTD); a `prior` row with it set to a real number produces a real delta).

Manual verification: same as every other change to this pipeline — the
existing `POST /api/reports/evident-report/send` admin route, previewed to
the user's own inbox before any leadership send, per the
[[feedback-preview-before-leadership-sends]] standing rule.

## Out of scope

- A company-wide YTD-billed source — none exists yet; revisit if one
  starts arriving.
- Any change to the Sales Rep Daily Report (James/William's per-rep doctor
  submit/no-submit report) — that report was never affected by this gap,
  since it was never sourced from Evident's booked/billed totals to begin
  with (it reads the CRM's own `clients`/`cases` tables).
- Historical backfill of `company_daily_booked_value` for the one
  pre-existing log row — genuinely no real data available for it.
