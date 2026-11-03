# Scheduled jobs: cron-job.org timers

Since 2026-11-03 the daily report jobs are started by **cron-job.org** (the user's own free account). It replaced self-hosted n8n when the VPS was shut down; the files in `n8n/` are no longer used.

cron-job.org only **starts** the jobs on time. All the report logic stays on the server (`aim-crm-backend` on Render), so cron-job.org holds no Gmail access and no report code.

All timers: Monday to Friday, time zone **America/New_York**, notifications on for "execution fails" and "cronjob disabled automatically". Timers 2 to 9 are `POST` with one header, `x-cron-secret`, set to the `CRON_SECRET` from Render.

| # | Title | When (New York) | Calls | What it does |
|---|---|---|---|---|
| 1 | AIM · Keep server awake | every 10 min, 5:00 to 10:50 | `GET /health` | Keeps the free Render instance awake through the report window (cron-job.org gives up after 30 s; a cold start can take longer). |
| 2 | AIM · 5:30 Evident email check | 5:30 | `POST /api/cron/evident-email-check?alert=true` | Checks the Evident emails for the last business day arrived; the server emails the approver if any are missing. |
| 3 | AIM · 6:00 Leadership preview | 6:00 | `POST /api/cron/evident-report` | Leadership Dashboard preview to the approver. |
| 4 | AIM · 7:00 Leadership send | 7:00 | `POST /api/cron/evident-report-send` | Automatic send to leadership (unless held, already sent, or the figures are unusable). |
| 5 | AIM · 7:00 CRM sync | 7:00 | `POST /api/cron/evident-crm-sync` | Evident to CRM sync. |
| 6 | AIM · 8:00 Rep report previews | 8:00 | `POST /api/cron/sales-rep-daily-report` | Rep report previews to the approver. |
| 7 | AIM · 9:00 Rep report auto-send | 9:00 | `POST /api/cron/sales-rep-daily-report-send` | Automatic send of each rep's report. Does nothing unless `SALES_REP_REPORT_AUTO_SEND` = `true` on Render. |
| 8 | AIM · WhatsApp post tries | 6:15 to 9:45, every 30 min | `POST /api/cron/whatsapp-post` | WhatsApp progress picture to nadinekate.d.limjoco@gmail.com, once the day's figures are in. |
| 9 | AIM · WhatsApp post final try | 10:15 | `POST /api/cron/whatsapp-post?final=true` | Last try; alerts the approver if the figures never came. |

## Things to know

- **Nothing sends twice.** Each job records one run per Eastern day in `cron_job_runs`, so the built-in node-cron (still on as a backup) and cron-job.org can both fire. A run started by cron-job.org has `source = 'external'`; one started by node-cron has `source = 'cron'`.
- **30-second timeout.** The job endpoints answer 202 right away and work in the background, so they finish well inside it. The 5:30 email check answers only when done and can exceed 30 s; cron-job.org then reports a failure, but the server still finishes the check and still sends its own missing-emails alert.
- **Failure emails** from cron-job.org replace n8n's old error-alert workflow. `POST /api/cron/n8n-error` is now unused.
- **Never "Test run"** timers 2 to 9: they send real emails. Timer 1 is safe to test.
- **Changing `CRON_SECRET`:** update it on Render, then update the header value on timers 2 to 9 one by one. Cloned timers hold their own copy. Do it outside 6 PM to midnight Manila (5 to 11 AM New York), when reports are in flight.
- Evident sends nothing on holidays, so the 5:30 check reports emails missing then. Expected.
