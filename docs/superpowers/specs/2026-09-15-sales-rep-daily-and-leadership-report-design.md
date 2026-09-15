# Sales Rep Daily Report + Leadership Report Evolution — Design

## Problem

Following a call with the CEO, two changes are needed to AIM's automated reporting:

1. A new **Sales Rep Daily Report** — a personalized daily email per rep showing
   which of their assigned doctors submitted a case that day and which didn't,
   plus progress toward a weekly "5 new doctors" goal. This **replaces** the
   existing Weekly Rep Report entirely (cold-lead tracking, performance tier,
   coaching suggestions — none of that carries forward).
2. The existing **Evident Consolidated Report** (shipped earlier this session)
   evolves into a renamed **Leadership Report**, adding a Yearly Billed figure
   and a 30-day booked/billed trend chart.

## Decisions from stakeholder review

- **Leadership report**: an evolution of the Evident Consolidated Report, not
  a new pipeline — same 6am ET weekday send, same underlying Evident data
  source. Adds Yearly Billed (parsed from Evident's YTD Booked Cases email,
  currently ignored by `parseEvident.js`) and a trend line chart.
- **Sales Rep Daily Report delivery**: personalized email per rep (matches the
  old Weekly Rep Report's pattern), not one consolidated email.
- **Recipients — Sales Rep Daily Report**: James Delaney and William Alexander
  only (the two real AIM reps). **Yoel Klein is cc'd on both** of their
  emails (visibility, not a separate personalized report for his own KH
  doctors).
- **Recipients — Leadership Report**: unchanged `to` list
  (`ben@aimdentallab.com`, `execassistant@aimdentallab.com`,
  `yoel@khdentallab.com`), plus `media@aimdentallab.com` added as **bcc**.
- **Old Weekly Rep Report — corrected scope.** Initial research checked the
  Frontend for the literal string `weekly-rep-report`/`weeklyRepReport` and
  found nothing, but missed that `weeklyRepReport.js`'s `computeRepSummary`/
  `buildRepReportHtml`/`sendRepWeeklyReport` are *also* the data source for
  two live Rep Dashboard widgets shipped in the customizable-dashboard work
  ("Your 1% This Week" suggestions, "Cold Leads" — `Frontend/src/pages/Dashboard.jsx:229,278-297,747-769`)
  and a working self-service "email me my report" button
  (`Frontend/src/pages/Reports.jsx:1160` → `POST /my-summary/email`), via
  `GET /api/reports/my-summary`. None of that was mentioned for
  termination — only the automated Monday all-reps broadcast was. So:
  **`weeklyRepReport.js` is not deleted.** Only `sendAllWeeklyRepReports()`
  (the automated broadcast function, `weeklyRepReport.js:322-340`) and its
  `scheduler.js` cron registration are removed, along with the two
  admin-testing routes for that specific broadcast
  (`GET /weekly-rep-report/preview`, `POST /weekly-rep-report/send`).
  `computeRepSummary`, `buildRepReportHtml`, `sendRepWeeklyReport`,
  `personalizedSuggestions`, `REPORT_CC`, `repReportEmail` (in `email.js`),
  and the `GET /my-summary`, `GET /my-summary/csv`, `POST /my-summary/email`
  routes all stay exactly as they are — they're a separate, still-live
  feature (a rep's own live dashboard summary and on-demand report), not the
  automated weekly broadcast being replaced.
- **New-doctor weekly goal**: reuses the existing Goals system
  (`src/routes/goals.js`, `goals` table) rather than a parallel mechanism —
  extended with a new `new_doctors` metric. If no admin-set goal exists for a
  rep for the current week, the report falls back to a default target of 5
  (computed in the report's own logic, not by auto-creating a goal row).
- **Yearly Billed source**: extends `parseEvident.js` to parse Evident's YTD
  Booked Cases email (currently one of the ignored report types), keeping
  every booked/billed figure in this report sourced from the same place.
- **Chart rendering**: QuickChart.io (external hosted service), embedded as a
  plain `<img src="https://quickchart.io/chart?c=...">` tag — no server-side
  fetch, the recipient's mail client (or, for the PDF, Puppeteer during
  render) requests the image directly. Confirmed acceptable that real
  booked/billed dollar figures are visible in that URL's query string to
  QuickChart's service.
- **Chart content**: booked + billed, two lines, trailing 30 days, sourced
  from `evident_report_log` (the table already being populated daily).

## Part 1 — Sales Rep Daily Report

### Schedule

Weekdays (Mon–Fri) 8:00am America/New_York — same slot the old Weekly Rep
Report used, now firing daily instead of just Monday. Gated behind
`SALES_REP_DAILY_REPORT_ENABLED` (default unset/off), matching the
established pattern for every report shipped this way in this codebase
(`WEEKLY_REPORT_ENABLED`, `UNASSIGNED_LEADS_REPORT_ENABLED`,
`EVIDENT_REPORT_ENABLED`) — code ships, automated send stays off until
explicitly reviewed and turned on.

### Data: "did this doctor submit a case today"

A doctor (`clients` row) "submitted a case" on a given day if a `cases` row
exists whose `client_name` matches that client's `doctor_name` (the same
name-matching join already used throughout this codebase —
`weeklyRepReport.js`, `cases.js`'s rep drill-down) with `created_at` falling
within that day, in America/New_York.

Day-boundary computation follows the same pattern established in the Evident
report (`services/evidentReport/index.js`'s `todayEasternDateString()`) —
an ET-anchored date string, with the actual boundary comparison done in
Postgres via `AT TIME ZONE` (not JS `Date` arithmetic), to avoid the class of
DST/UTC-drift bug the Evident report's final review already caught once in
this codebase.

```sql
SELECT cl.doctor_name, cl.clinic_name,
  EXISTS (
    SELECT 1 FROM cases c
    WHERE c.client_name = cl.doctor_name
      AND c.created_at >= ($2::date AT TIME ZONE 'America/New_York')
      AND c.created_at <  (($2::date + 1) AT TIME ZONE 'America/New_York')
  ) AS submitted_today
FROM clients cl
WHERE cl.assigned_to = $1
ORDER BY cl.doctor_name
```

### Data: weekly new-doctor goal

"New doctor" = a `clients` row assigned to the rep with `created_at` in the
current week (Monday through today, in progress — not a completed prior
week, since the report needs to show live progress building across the
week).

- Look up `SELECT * FROM goals WHERE rep_id=$1 AND metric='new_doctors' AND period='weekly' AND period_start <= today AND period_end >= today`.
- If found: use its `target`, compute progress via the same `clients.created_at`-in-range count.
- If not found: no goal row is created — the report computes progress against an implicit default target of 5, using the same current-week count.

### Schema change: extend the Goals system

`goals.metric` and `personal_goals.metric` currently `CHECK (metric IN
('leads_won','leads_contacted','proposals_sent','conversion_rate'))`
(`scripts/v4-migration.sql`). New migration adds `'new_doctors'` to both
constraints. `src/routes/goals.js`'s `computeProgress()` gets a new branch
for `metric === 'new_doctors'`, querying `clients` (not `leads`) the way
every other branch queries `leads` — this is the one metric type that counts
a different table, since "new doctor" has no `leads` equivalent (a doctor
becomes a `clients` row via conversion, not by staying a lead).

### Email content (personalized per rep)

```
Subject: Daily Sales Report — [Rep Name] — [Weekday, Month Day, Year]

Totals (top of email):
- N doctors assigned
- X submitted a case today
- Y did not submit today
- Weekly goal: P of T new doctors this week

Doctor list (table, one row per assigned doctor):
Doctor Name | Clinic | Today
Dr. X       | ...    | ▲ Submitted   (green)
Dr. Y       | ...    | ▼ Not submitted (red)
```

Brand styling matches the existing report templates in this codebase (teal
`#06babe`/navy `#207290`, per `CLAUDE.md`'s documented convention) — no new
visual system, just the up/down + green/red indicator per doctor row.

### Retiring the automated Weekly Rep Report broadcast (not the whole file)

`weeklyRepReport.js` **stays** — `computeRepSummary`, `buildRepReportHtml`,
`sendRepWeeklyReport`, `personalizedSuggestions`, `REPORT_CC` all remain
exactly as they are, because they're the live data source for the Rep
Dashboard's "Your 1% This Week"/"Cold Leads" widgets and the "email me my
report" self-service button (`Frontend/src/pages/Dashboard.jsx`,
`Frontend/src/pages/Reports.jsx` → `GET/POST /api/reports/my-summary*`) —
none of that was part of the CEO's "terminate the weekly report" ask, which
was specifically about the automated Monday broadcast to every rep.

Only removed:
- `sendAllWeeklyRepReports()` (`weeklyRepReport.js:322-340`) and its
  `module.exports` entry — the function that emails *every* staff/sales_rep
  user on Monday. Nothing else in the file calls it.
- Its cron registration in `src/jobs/scheduler.js` (the `'0 8 * * 1'` /
  `WEEKLY_REPORT_ENABLED`-gated block, `scheduler.js:109-116` per this
  session's own research), and the now-unused `sendAllWeeklyRepReports`
  import at the top of that file. This is a **scoped, deliberate exception**
  to this codebase's established "never touch `scheduler.js`" rule — that
  rule exists to protect real *unrelated* in-progress work in that file;
  this edit removes exactly the one `cron.schedule(...)` block (and its
  now-dead import) this task is tasked with retiring, nothing else in the
  file.
- Two admin-testing routes in `src/routes/reports.js` that exist
  specifically to test that broadcast: `GET /weekly-rep-report/preview`,
  `POST /weekly-rep-report/send`. The `computeRepSummary`/`buildRepReportHtml`
  imports at the top of `reports.js` stay (still used by `/my-summary` and
  `/my-summary/email`) — only remove `sendRepWeeklyReport`... no, wait:
  `sendRepWeeklyReport` is also still used by `/my-summary/email`
  (`reports.js:408`) — so the import line itself is unchanged; only the two
  route handlers that reference `REPORT_CC` exclusively for the admin-test
  broadcast path go away. (`REPORT_CC` is still imported since
  `/my-summary/email` calls `sendRepWeeklyReport(..., { cc: [] })` — check
  at implementation time whether `REPORT_CC` is referenced anywhere else in
  `reports.js` after the two routes are removed; if not, drop it from the
  import list, but do not remove it from `weeklyRepReport.js`'s own exports
  since `sendRepWeeklyReport` itself still defaults `cc = REPORT_CC`
  internally.)
- `WEEKLY_REPORT_ENABLED` was never actually documented in `.env.example`
  (confirmed during the Evident report's final review) — nothing to remove
  there.

### New files

- `src/services/salesRepDailyReport.js` — single file (matching
  `weeklyRepReport.js`'s own precedent: homogeneous CRM-internal queries +
  HTML build + send, unlike the Evident report's multi-file split, which was
  justified by genuinely distinct I/O concerns — Gmail, PDF, external DB log
  — that don't apply here).
- `src/jobs/salesRepDailyReport.js` — new cron file, own file per this
  codebase's established convention (`mediaCleanup.js`,
  `socialTokenRefresh.js`, `evidentReport.js`), weekdays 8am ET, gated behind
  `SALES_REP_DAILY_REPORT_ENABLED`.
- New route `POST /api/reports/sales-rep-daily-report/send` (admin-only,
  manual test-send) in `src/routes/reports.js`, replacing the deleted
  `weekly-rep-report/send` route in the same spot.

## Part 2 — Leadership Report (Evident Consolidated Report evolution)

### Rename

"Evident Consolidated Report" → **"AIM Leadership Report"** (subject line and
internal naming) — open to a different name if you'd prefer; this is a
one-line change wherever the current title appears
(`buildReport.js`'s subject/H2, code comments).

### Yearly Billed — extending `parseEvident.js`

Evident sends a "YTD Booked Cases" email per rep (same table shape as
Daily/MTD Booked Cases — `Sales Value (Total Billed)`/`(Total WIP)` columns),
currently unclassified and silently dropped by `classify()`. Adding:

```js
if (/^YTD Booked Cases\s*-\s*James/i.test(s)) return { type: 'ytdBooked', rep: 'james' }
if (/^YTD Booked Cases\s*-\s*William/i.test(s)) return { type: 'ytdBooked', rep: 'william' }
```

with a new `EXPECTED` entry per rep (bringing the expected-report count from
5 to 7) and a new `agg.booked.ytd` bucket (`{ count, billed, wip, value,
byRep: { james, william } }`), computed identically to the existing
`mtdBooked` aggregation logic (billed + wip = value, same column-finding
helpers). This is an **additive** change to a file the earlier Evident-report
plan marked "ported verbatim, don't modify" — that constraint applied to the
initial *port*, not permanently; the existing 5 fixture-based tests keep
passing unchanged (nothing about `dailyBooked`/`mtdBooked`/`wip` parsing
changes), and 2 new fixture-based tests get added for the YTD case.

### Yearly Billed — the report tile + day-over-day delta

New `evident_report_log` column: `ytd_billed_value numeric NOT NULL DEFAULT
0` (migration, additive `ALTER TABLE`). `buildReport.js` gets a fifth
summary tile ("Billed (YTD)") alongside the existing four (Booked
today/MTD/Billed MTD/WIP), with the same delta-vs-yesterday treatment the
other tiles already have.

### Trend chart

New helper `src/services/evidentReport/chart.js`: builds a QuickChart.io URL
for a two-line chart (booked value, billed value) over the trailing 30 rows
of `evident_report_log` (ordered by date), returns the URL string.
`buildReport.js` embeds it as `<img src="${chartUrl}" ...>` in the email
body. No new dependency, no server-side image fetch — QuickChart's
documented URL-based API (`https://quickchart.io/chart?c=<url-encoded
Chart.js config>`) is a GET request the *viewer* (mail client, or Puppeteer
during PDF render) makes, not this backend.

### Recipients

`sendEmail()`'s call in `services/evidentReport/index.js` gets
`bcc: ['media@aimdentallab.com']` added alongside the existing `to` list —
no change to who's `to`.

## Database changes (new migration, `v20-...-migration.sql`)

```sql
ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_metric_check;
ALTER TABLE goals ADD CONSTRAINT goals_metric_check
  CHECK (metric IN ('leads_won','leads_contacted','proposals_sent','conversion_rate','new_doctors'));

ALTER TABLE personal_goals DROP CONSTRAINT IF EXISTS personal_goals_metric_check;
ALTER TABLE personal_goals ADD CONSTRAINT personal_goals_metric_check
  CHECK (metric IN ('leads_won','leads_contacted','proposals_sent','conversion_rate','new_doctors'));

ALTER TABLE evident_report_log ADD COLUMN IF NOT EXISTS ytd_billed_value numeric NOT NULL DEFAULT 0;
```

(Exact constraint names to be confirmed against the live schema at
implementation time — Postgres auto-generates a default constraint name if
none was given explicitly in the original migration, which needs a quick
`\d goals` check before writing the `DROP CONSTRAINT` line for real.)

## Testing

- `test/evidentReport/parseEvident.test.js` gets 2 new cases (YTD Booked
  Cases, James + William) using 2 new real fixture files — same "transcribe
  real Evident emails, verify against the report's own total row" discipline
  already established for this test suite. (New fixtures need to be pulled
  from a real Evident YTD email, same as the original 5.)
- The new Sales Rep Daily Report's SQL (submitted-today, new-doctor-count) is
  I/O against real data, verified the same way `log.js`/`gmailFetch.js` were
  — a synthetic-record round-trip against the real DB (one test client, one
  test case, cleaned up immediately after), not a mocked unit test.
- Manual verification: the existing `sales-rep-daily-report/send` route
  (once built) and the Leadership Report's existing
  `evident-report/send` route are how both get a live end-to-end check
  before either `*_ENABLED` flag is turned on.

## Out of scope

- Any change to how `sales_rep`/`staff` roles are scoped or who counts as a
  "real" rep beyond James/William for this specific report — that's an
  existing, separate convention.
- A UI for admins to set the weekly new-doctor goal — the existing Goals
  admin UI (if one exists in the Frontend) already covers creating a `goals`
  row; this spec only extends the backend metric type it can hold.
- Historical backfill of `ytd_billed_value` for `evident_report_log` rows
  that predate this change (only today's row so far exists in production —
  no backfill needed).
