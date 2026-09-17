# Automated Evident → CRM Sync — Design

## Problem

The CRM's `cases`/`clients` tables only reflect whatever was last pushed
through `POST /api/cases/import-evident` — an admin manually pasting a
CSV/screenshot export, one rep at a time. Nothing keeps it current
automatically, so it silently drifts behind reality. Confirmed twice this
session on real data: a real Sep 15 booking for one of William's doctors
didn't show up as "submitted" in his own report because the CRM's case
record was still dated Sep 10, and William's most recent CRM case overall
was over a week stale. The user wants this closed: cases, doctors, and
totals should update automatically from Evident's own data, going forward
and for existing history.

## Decisions from stakeholder review

- **Scope**: both a one-time historical backfill *and* an ongoing daily
  sync going forward — not going-forward-only.
- **Unassigned ("N/A" bucket) doctors** — about 97% of real Evident
  revenue, per Elizabeth's PDFs (`$302,654.92` of `$311,452.46` YTD
  billed) — get **no invented owner**. They stay unassigned in the CRM,
  matching Evident's own "N/A" designation.
- **New-doctor handling, one unified rule** (revised mid-design from an
  earlier lead-first idea): every previously-unknown doctor found in
  Evident data is created as a **client directly** — never a lead. A
  doctor with a real booked case is already a transacting account, not a
  prospect to convert. The only difference between doctors: one gets
  `assigned_to` set to the attributed rep (James/William); the other stays
  unassigned (N/A bucket).
- Reused, not reinvented: the existing `import-evident` route's
  upsert-by-`evident_case_number` and case-insensitive doctor-name
  matching are the proven core this pipeline builds on, not something to
  redesign from scratch.

## Data sources (confirmed against real fixtures this session)

**"Daily Booking Report - Nadine"** (company-wide, daily, already parsed
for its totals row — see `company-daily-booked-nadine.html`) — row-level
columns: `Ref`, `Case Number`, `Customer Code`, `Customer Name`, `Sales
Value (Total)`, `Salesperson`. `Salesperson` is blank for the N/A bucket,
a first name (`james`/`william`) when attributed. This is the booking
event signal — one row per case, per day it was booked.

**"Daily Billed Report - Nadine"** (company-wide, daily) — row-level
columns: `Ref`, `Case Number`, `Customer Code`, `Customer Name`, `Sales
Value (Total)`, `Sales Value (Total Billed)`, `Salesperson`. Confirmed
2026-09-17 by direct inspection (not previously used at row level, only
its totals row). This is the billing event signal — one row per case, on
the day it got billed, which is normally later (often weeks later) than
its booking day.

Both reports key on the same `Ref` (Evident's case reference number) —
the existing `evident_case_number` column already tracks this, so no new
matching key is needed.

## Architecture

**`src/services/evidentCrmSync.js`** — the core, one function two callers
share:

```
syncCasesForDate(dateStr)
```

For `dateStr`: fetch that day's "Daily Booking Report - Nadine" and
"Daily Billed Report - Nadine" emails, parse every row (new
`extractBookingRows(html)` / `extractBilledRows(html)` parsers in
`parseEvident.js`, siblings of the existing `extractDailyBookedCustomerNames`/
`extractCaseTotals`), and for each row:

1. Normalize the doctor name (reuse `normalizeDoctorName` — lowercase,
   strip `.`/`,`, collapse whitespace — same as this session's new-doctor
   detection in `salesRepDailyReport.js`).
2. Look up `clients` by normalized name.
   - **Match found**: use the client's exact stored `doctor_name` as
     `cases.client_name` (same reasoning as the existing import route —
     every other join in this codebase relies on that exact string
     match).
   - **No match**: create a new `clients` row. `assigned_to` = the rep's
     user id, resolved via the same `EVIDENT_REP_KEY_BY_EMAIL`-style fixed
     mapping this session already established (`Salesperson` value
     `james`/`william` → `james@aimdentallab.com`/`williama@aimdentallab.com`
     → that user's real id). Any other `Salesperson` value — blank, a typo,
     a name this mapping doesn't recognize — resolves to `NULL`
     (unassigned), never a thrown error. Only two real reps exist in this
     CRM today; this rule doesn't need to anticipate a third.
3. Upsert `cases` by `evident_case_number` (`Ref`) — same shape as the
   existing manual route: booking rows set `client_name`, `value`,
   `created_at` (booking date); billed rows set `billed_value`, `status`
   (`billed_value > 0` → `'Completed'`, else `'In Production'`),
   `wip_value` (`value - billed_value`).
4. Call the existing `syncClientRevenue(clientName)` after each doctor's
   cases change — already built, already proven, not touched.

**`src/jobs/evidentCrmSync.js`** — new weekday cron, gated behind
`EVIDENT_CRM_SYNC_ENABLED` (same shipped-but-off rollout pattern as every
other automated job this session), calling `syncCasesForDate(today)` —
going-forward sync only.

**`scripts/backfill-evident-crm-sync.js`** — one-time, manually run via
`node scripts/backfill-evident-crm-sync.js --from=YYYY-MM-DD`, never an
HTTP route (a full backfill takes minutes and needs a human watching it,
not a request/response cycle). Walks **chronologically forward** — oldest
day to today — calling `syncCasesForDate()` per day with a deliberate
delay between Gmail requests.

### Why chronological order matters

A case's booking day and billing day are usually different, often weeks
apart. Processing oldest-to-newest means by the time the backfill reaches
a "Billed" row, that case's "Booking" row (from an earlier, already
-processed day) has normally already created the `cases` row — the billed
update lands on a real, already-existing case rather than inventing one
missing context. The one honest gap: a case billed within the backfill
window but originally booked *before* `--from` has no earlier booking row
to land on. In that case, `syncCasesForDate` creates the case from the
billed row alone, using the billed date as a fallback `created_at` — a
documented limitation, not silently wrong data. It self-heals if the
backfill's `--from` is set early enough that this rarely happens.

### Gmail quota

Confirmed real during design investigation: fetching a wide date range
(365 days, one email at a time) tripped Gmail's per-minute quota. The
backfill script adds a fixed delay between each day's fetch (and between
individual message fetches within `fetchEvidentEmailsInRange`, which
every consumer of that function benefits from, not just this one). The
exact interval gets tuned empirically during implementation against the
real quota limit hit.

## Error handling

- **Per-row**: a malformed row (blank doctor name, unparseable value)
  is skipped and logged, not fatal to the rest of that day — same
  best-effort-per-item pattern as `sendAllSalesRepDailyReports`.
- **Per-day** (backfill only): a day whose fetch or parse fails is
  skipped and logged, not fatal to the rest of the backfill. The script
  prints a final summary of which dates failed, so a human can re-run
  just those.
- **Idempotency**: safe to re-run any day (including via a resumed/
  restarted backfill) — case upserts are keyed by `evident_case_number`;
  client creation is guarded by the same name-match lookup, so a re-run
  finds the client it already created rather than duplicating it.

## Rollout

Per this project's own hard-won rule ([[feedback-scope-writes-against-prod]] —
no staging DB exists for this project): before the real backfill runs at
all, `syncCasesForDate()` runs once against a **single real day**, its
result is shown to the user, and only after that's confirmed correct does
the full historical backfill proceed. The going-forward cron job stays
`EVIDENT_CRM_SYNC_ENABLED=false` until the user explicitly turns it on,
same as every other automated send/job this session.

## Testing

- `extractBookingRows` / `extractBilledRows`: unit-tested against real
  fixture HTML (new fixtures, pulled from the real inbox, matching this
  suite's existing "real email, ground truth" convention), asserting
  exact parsed rows including the blank-`Salesperson` (N/A) case and the
  attributed-rep case.
- `normalizeDoctorName`/client-matching logic: unit-tested with real
  doctor-name variants already seen this session (`"DR BRIAN GOLD"` vs.
  `"Dr. Brian Gold"`, etc.).
- `syncCasesForDate` itself and the backfill script are **not**
  unit-tested (no staging DB) — verified instead via the single-real-day
  rollout step above, matching this codebase's established practice for
  every other DB-writing report function in this pipeline.

## Out of scope

- Leads. The earlier "create as a lead first" idea was explicitly
  dropped mid-design — no lead-creation path exists in this pipeline.
- Syncing anything beyond cases/clients/case-value totals — no change to
  the Leadership Report or Sales Rep Daily Report's own Evident-reading
  logic, which already works directly from live Gmail data independent of
  the CRM's tables.
- A UI for reviewing/undoing auto-created clients. If this turns out to
  need one (e.g., a name-matching mistake merges two real doctors), that's
  a follow-up, not part of this pass.
