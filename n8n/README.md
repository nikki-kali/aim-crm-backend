# n8n workflows for the daily reports

n8n only **starts** the jobs on time and checks that the Evident emails arrived. All the report logic stays on the server (`aim-crm-backend` on Render), so n8n holds no Gmail access and no report code.

| File | When (New York time, weekdays) | Calls | What it does |
|---|---|---|---|
| `1-evident-email-check-0530.json` | 5:30 AM | `POST /api/cron/evident-email-check?alert=true` | Checks that all 5 Evident emails for the last business day arrived. If any are missing, the server emails the approver. |
| `2-leadership-preview-0600.json` | 6:00 AM | `POST /api/cron/evident-report` | Sends the Leadership Dashboard preview to the approver. |
| `3-leadership-send-0700.json` | 7:00 AM | `POST /api/cron/evident-report-send` | Automatic send to leadership (unless held, already sent, or EviSmart is unusable). |
| `4-crm-sync-0700.json` | 7:00 AM | `POST /api/cron/evident-crm-sync` | Evident to CRM sync. |
| `5-rep-reports-0800.json` | 8:00 AM | `POST /api/cron/sales-rep-daily-report` | Sends the rep report previews to the approver. |
| `6-whatsapp-post.json` | every 30 min from 6:15 to 9:45, then a final try at 10:15 | `POST /api/cron/whatsapp-post` (`?final=true` on the last) | Builds the WhatsApp progress picture and caption and emails them to nadinekate.d.limjoco@gmail.com. Waits for the day's EviSmart report; sends once per day; alerts the approver only on the final try if EviSmart never came, or if a figure is missing. |
| `0-error-alert.json` | on failure | | Emails you if any workflow above fails (server asleep, Gmail access expired). |

## One-time setup

1. **Credential.** n8n -> Credentials -> New -> *Header Auth*. Name: `AIM CRM cron secret`. Header name: `x-cron-secret`. Value: the `CRON_SECRET` from Render (aim-crm-backend -> Environment). Do not paste it anywhere else.
2. **Import** all seven files (Workflows -> Import from file).
3. In workflows **1 to 6**, open the HTTP node(s) and select the credential from step 1.
4. In **0-error-alert**, pick your SMTP credential and set the From address (it sends to adivirtuosity@gmail.com; change if needed).
5. In each of workflows 1 to 6: Settings -> **Error Workflow** -> `AIM · Error alert`.
6. **Test workflow 1 only** (Execute workflow). It is read-only and returns JSON: `ok: true`, or `ok: false` with the names of the missing emails.
7. **Activate** workflows 1 to 6 (not 0).
8. **WhatsApp post only:** on Render (aim-crm-backend -> Environment) add `WHATSAPP_POST_ENABLED` = `true`. Until it is set the server skips the job. The first real run is the first weekday after activation; check nadinekate.d.limjoco@gmail.com for the email with the picture.

Do **not** click Execute on workflows 2 to 6 to test them: they run the real jobs (previews, the leadership send, a CRM write, an email to Nadine).

## Overlap with cron-job.org

If the cron-job.org timers are still on, nothing is sent twice: each job records one run per day on the server. Once n8n has run a full weekday successfully, turn the cron-job.org timers off so there is one place to look.

## Limits

- Render's free plan sleeps; the first request wakes it. The HTTP nodes allow 180 s and retry 3 times, 30 s apart.
- Evident sends nothing on holidays, so the 5:30 AM check will report them missing. Expected.
- The endpoints are POST-only with a secret header on purpose: an email scanner pre-fetching a link must never be able to trigger a send.
