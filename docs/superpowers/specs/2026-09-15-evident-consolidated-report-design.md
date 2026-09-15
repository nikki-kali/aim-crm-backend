# Evident Consolidated Report — Design

## Problem

AIM Dental Laboratory needs a daily leadership report consolidating Evident
Labs' booked/billed/WIP case data. A standalone Node.js project already
implements this — parsing, aggregation, and report-building logic tested
against 5 real Evident emails — at `/Users/nklimjoco/Downloads/evident-report-project/`.
That project's Gmail OAuth credentials were never actually filled in, so it
has never run against live data. Rather than finish it as a standalone
process (its own OAuth setup, its own scheduler, a Google Sheet as a log),
fold it into `aim-crm-backend` so it uses the CRM's existing email-sending
identity, database, and deployment.

This is a port, not a rewrite. `parseEvident.js` and `buildReport.js` are
pure functions with no network calls, already correct and under test — they
move over close to unchanged. The three I/O-bound modules (Gmail fetch,
Sheets log, PDF render, and the Gmail-based send) get re-architected against
what `aim-crm-backend` already has.

## Decisions from stakeholder review

- **Gmail access**: read-only (`gmail.readonly` only — no send scope,
  since sending moves to the existing email pipeline). One-time OAuth
  consent flow, signed in as `media@aimdentallab.com`, done by the user
  (Claude cannot complete an interactive Google login) — see "Gmail OAuth
  setup" below for the exact steps to hand over once this spec is approved.
- **Sender identity**: via `aim-crm-backend`'s existing `sendEmail()`
  (Resend primary, Brevo fallback) — consistent with every other automated
  CRM email (weekly rep report, unassigned leads report). Not sent as
  `media@aimdentallab.com`.
- **PDF attachment**: required for v1 (not deferred).
- **Recipients**: `ben@aimdentallab.com`, `execassistant@aimdentallab.com`,
  `yoel@khdentallab.com` — confirmed unchanged from the standalone project's
  `.env.example`.
- **Log store**: a new Postgres table, not the Google Sheet — `aim-crm-backend`
  already has a database; a Sheet would be a new, weaker dependency for
  something Postgres already does better (transactional, queryable, no
  separate service-account/sharing setup).

## Architecture

```
node-cron (jobs/evidentReport.js, weekdays 6am America/New_York)
  → gmailFetch.js: Gmail API (read-only) — last ~1 day's Evident emails
  → parseEvident.js (ported as-is): parse HTML tables → aggregate
  → Postgres: SELECT yesterday's row from evident_report_log
  → buildReport.js (ported as-is): aggregate + history → { subject, html, sheetRow }
  → pdf.js (new): puppeteer-core + @sparticuz/chromium → PDF buffer
  → services/email.js's existing sendEmail(): HTML body + PDF attachment → leadership
  → Postgres: INSERT today's row into evident_report_log
```

Runs in-process inside the existing single-dyno web service — same pattern
as `src/jobs/mediaCleanup.js` and `src/jobs/socialTokenRefresh.js` (each an
independently-registered `node-cron` job, started from `src/index.js`'s
`app.listen` callback). No new worker dyno, no change to how the rest of
the backend deploys.

## Module layout

New directory `src/services/evidentReport/`:

- `parseEvident.js` — ported verbatim from the standalone project (pure
  function, no changes needed — it takes `{subject, html}[]` in, returns
  the aggregate object).
- `buildReport.js` — ported verbatim (pure function — aggregate + history
  rows in, `{subject, html, sheetRow}` out). The `sheetRow` key name stays
  as-is even though it's now a DB row, not a Sheet row — renaming it is
  pure churn with no behavior change, and the field names inside it
  (`booked_daily_count`, `wip_value`, etc.) already match the new table's
  column names, which is what actually matters.
- `gmailFetch.js` — new. Read-only replacement for the fetch half of the
  standalone project's `gmail.js`: same OAuth2 client + `gmail.users.messages.list`/`get`
  logic, `gmail.send` code removed entirely (sending happens elsewhere now).
- `pdf.js` — new. Same `renderPdf(html)` interface as the standalone
  project, reimplemented on `puppeteer-core` + `@sparticuz/chromium`
  instead of full `puppeteer` (see "PDF rendering" below).
- `log.js` — new. Postgres replacement for `sheetsLog.js`: `getHistory()`
  and `appendRow()`, same signatures, backed by `evident_report_log`
  instead of a Sheet.
- `index.js` — new orchestrator, the direct equivalent of the standalone
  project's `index.js`'s `runOnce()` (module-only; the cron registration
  itself lives in `src/jobs/evidentReport.js`, matching this repo's
  convention of keeping schedule registration in `src/jobs/`).

`src/jobs/evidentReport.js` — new, registers the cron job, calls
`runEvidentReport()` from `services/evidentReport/index.js`. Own file
rather than added to `scheduler.js`, matching this repo's established
reason for that split (`scheduler.js` carries real in-progress unrelated
work).

## Gmail OAuth setup

Same shape as the standalone project's README, narrowed to one scope:

1. Google Cloud Console → create or reuse a project → enable the **Gmail
   API**.
2. APIs & Services → Credentials → Create Credentials → OAuth client ID →
   "Desktop app" type. Note the client ID and secret.
3. OAuth consent screen → add scope `https://www.googleapis.com/auth/gmail.readonly`
   (only this one — no `gmail.send`, no `spreadsheets`).
4. [OAuth 2.0 Playground](https://developers.google.com/oauthplayground):
   gear icon → "Use your own OAuth credentials" → paste client ID/secret →
   Step 1, select `gmail.readonly`, Authorize, **sign in as
   media@aimdentallab.com** (not a personal account — this determines
   whose inbox gets read) → Step 2, exchange for tokens, copy the refresh
   token.
5. Three new Render env vars on `aim-crm-backend`: `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. (`GMAIL_USER` doesn't
   need to be its own env var — the inbox read is implied by whichever
   account produced the refresh token; `gmailFetch.js` doesn't need to be
   told who it's reading as.)

This is the one step in this plan that requires the user directly — Claude
cannot complete an interactive Google OAuth consent flow. Hand these steps
over once this spec is approved, before or alongside plan execution (the
pipeline can be fully built and unit-tested without live credentials, same
as the standalone project was — only the manual test send at the end needs
them).

## PDF rendering — puppeteer-core + @sparticuz/chromium

`aim-crm-backend` deploys to Render as a native Node web service (no
`Dockerfile`/`render.yaml` exists). Full `puppeteer`'s bundled Chromium
needs system shared libraries (`libnss3`, `libgbm1`, `libatk-bridge2.0-0`,
etc.) that Render's native Node runtime doesn't provide — it would very
likely fail at runtime with missing-`.so` errors. The fix used elsewhere
for this exact problem (Render/Vercel/Lambda-style restricted Linux
environments) is `@sparticuz/chromium`, a Chromium build compiled
specifically for these environments, paired with `puppeteer-core` (the
same Puppeteer API, without its own bundled browser download). This avoids
switching `aim-crm-backend`'s entire deployment to Docker just for one
feature — which would be a much larger, riskier change to a service
carrying live production CRM traffic.

```js
// src/services/evidentReport/pdf.js
const chromium = require('@sparticuz/chromium')
const puppeteer = require('puppeteer-core')

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
      format: 'A4', printBackground: true,
      margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
    })
  } finally {
    await browser.close()
  }
}

module.exports = { renderPdf }
```

**Failure isolation**: `services/evidentReport/index.js`'s orchestrator
wraps the `renderPdf()` call in try/catch. If it throws, the report still
sends as an HTML-only email (no attachment) rather than failing the whole
run — matching this codebase's existing best-effort pattern (e.g.
`clientRevenue.js`'s fire-and-forget sync). A PDF failure logs loudly
(`console.error`) and is visible in the email itself (a small note replacing
"A PDF copy of this report is attached." when there's no attachment) so
it's never silently missing.

**Real residual risk, not eliminated by this choice**: `@sparticuz/chromium`
is proven on Lambda-style environments; it is *likely* but not
*guaranteed* to work unmodified on Render's native Node runtime — this
has to be confirmed by an actual test render at implementation/test time,
not assumed from this doc. If it doesn't work cleanly, the fallback is
either a Dockerfile-based Render deploy (bigger blast radius, discuss with
the user first) or dropping the PDF for a fast-follow — both are decisions
to bring back to the user if `@sparticuz/chromium` doesn't pan out, not to
decide unilaterally mid-implementation.

## Database

New migration `scripts/v19-evident-report-log-migration.sql`:

```sql
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

Same column set as the standalone project's Sheet header row, so
`buildReport.js` needs no changes to the shape it reads/produces —
`log.js`'s `getHistory()` returns `SELECT * FROM evident_report_log ORDER BY date DESC` rows
directly (Postgres `numeric`/`integer` columns come back as strings via
`pg`, same as Sheet cells did — `buildReport.js` already calls `Number()`
on everything it compares, so no adapter logic is needed beyond the SQL
itself). `appendRow()` becomes an `INSERT` keyed by `date` (the `UNIQUE`
constraint on `date` makes a same-day re-run of the pipeline fail loudly
with a constraint violation rather than silently duplicating a day's row —
appropriate for a job that should only run once/day, and matches "must not
silently under- or over-report").

## Email sending

Reuses `src/services/email.js`'s existing `sendEmail({ to, subject, html, cc, bcc, attachments })` —
no changes to that file. The orchestrator calls it directly:

```js
await sendEmail({
  to: ['ben@aimdentallab.com', 'execassistant@aimdentallab.com', 'yoel@khdentallab.com'],
  subject,
  html,
  attachments: pdfBuffer
    ? [{ filename: `evident-report-${aggregate.runDate}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
    : undefined,
})
```

Recipients are a small hardcoded array in `services/evidentReport/index.js`
(matching how `weeklyRepReport.js`'s `REPORT_CC` is a hardcoded constant in
this codebase, not a DB-configured list — this report has a fixed audience,
unlike `report_schedules`-driven reports which are user-configurable from
the CRM UI).

## Testing

- `test/evidentReport/parseEvident.test.js` and
  `test/evidentReport/fixtures/*.html` — ported unchanged from the standalone
  project (5 real Evident emails, ground truth). Path updated only to
  reflect the new location; assertions and fixture content untouched.
- `package.json`'s `test` script currently a stub that errors
  (`"echo \"Error: no test specified\" && exit 1"`) — this is `aim-crm-backend`'s
  first real test suite. Changed to `node --test test/evidentReport/`, so
  `npm test` actually runs something for the first time. (Scoped to this
  one directory rather than a repo-wide `node --test` glob, since no other
  test directories exist yet — broadening the glob is a decision for
  whoever adds the next test suite, not this task.)
- `log.js` (DB-backed history) and `gmailFetch.js` (Gmail API) are I/O and
  not unit-tested here, consistent with the standalone project's own scope
  (its README explicitly frames `parseEvident.js`/`buildReport.js` as "the
  pure functions, that's what makes them unit-testable... no live
  credentials needed" — the I/O modules were always meant to be verified by
  a real run, not a mock-heavy unit test).
- Manual verification: `POST` an admin-only test-send route (mirroring the
  existing `POST /weekly-rep-report/send` pattern) that runs the full
  pipeline once and returns which stage it reached — used once real Gmail
  credentials exist, to confirm a live email matches the standalone
  project's output shape for the same input, and to build the log table's
  first two rows so a real day-over-day delta can be observed.

## Cleanup (after this is live)

Once this is deployed and the manual test-send confirms it end-to-end, the
standalone `evident-report-project/` and its abandoned `n8n-workflow.json`,
plus the `gotenberg` container entry in
`~/Documents/n8n-selfhosted/docker-compose.yml`, are no longer needed. Not
deleted as part of this work — flagged for the user to remove when ready,
per their explicit instruction not to delete unprompted.

## Out of scope

- YTD Booked Cases reports (the standalone project's own "possible next
  steps" — not part of this port).
- Charting logged history, or a Slack version of the report (same list).
- Any change to `src/jobs/scheduler.js` itself.
- Any change to the existing manual `POST /api/cases/import-evident` CSV
  importer — this is a separate, unrelated Evident integration point (case
  import into the CRM's own `cases` table) that this report doesn't touch
  or depend on.
