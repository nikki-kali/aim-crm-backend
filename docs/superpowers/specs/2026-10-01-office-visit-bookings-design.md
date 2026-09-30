# Office Visit Bookings — Design

**Status:** Approved by user (conversational design review, 2026-10-01). Ready for implementation planning.

## Goal

Let dental practices request an in-person office visit from their AIM Dental sales rep, and let reps schedule office visits themselves — both ending in a confirmed date/time and, where possible, a confirmation email to the practice. Two entry points, one underlying record and workflow.

## Why a new, self-contained feature

The CRM's embedded "Scheduler" (`/scheduler/*` in the Frontend) is a UI shell backed by a **separate live service**, `booking-platform` (its own repo/Render deployment, restored 2026-09-27 per `Frontend` commit `8082f2e`). This session does not have `booking-platform`'s source. The user explicitly chose to build Office Visit Bookings as a self-contained feature inside `aim-crm`'s own Backend/Frontend — same pattern as Case Pickup Schedules — rather than extending `booking-platform`. The new feature's UI will live as a tab inside the existing Scheduler subnav (per the user's placement request), but will call this CRM's own new backend routes, not `schedulerApi`/`VITE_SCHEDULER_API_URL`. This means the Scheduler section will have tabs backed by two different services going forward — flagged to the user during design review, accepted.

`Frontend` commit `2bb5202` (2026-09-28) added an "Office Visit" *location type* to `booking-platform`'s event types (a free-form label shown on manually-created appointments there). That is unrelated to this feature and is not touched by this work.

## Data model

Two new tables in the Backend's Postgres database (Supabase), applied by hand per this repo's existing convention (`Backend/scripts/vNN-*.sql`, no migration runner).

### `rep_territories`

Maps a named region to a rep. Small, admin-editable table (2 rows to start).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK, default `gen_random_uuid()` | |
| `rep_id` | uuid, not null, FK → `users.id` | |
| `region_name` | text, not null | e.g. `'NYC'`, `'West Coast'` — free-form label, matched against a state code (see Territory matching below) |
| `state_codes` | text[], not null | e.g. `{'NY'}` or `{'CA','OR','WA'}` — the actual matching logic uses this, `region_name` is just the human label shown in the CRM UI |
| `created_at` | timestamptz, not null, default `now()` | |

Seed data (real, from user): James Delaney → `region_name: 'NYC'`, `state_codes: {'NY'}`. William Alexander → `region_name: 'West Coast'`, `state_codes: {'CA'}`.

### `office_visit_bookings`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK, default `gen_random_uuid()` | |
| `source` | text, not null | `'public_form'` or `'rep_scheduled'` |
| `practice_name` | text | |
| `contact_name` | text, not null | |
| `contact_role` | text | job title/role |
| `address_line1` | text | |
| `address_line2` | text | |
| `city` | text | |
| `state` | text | 2-letter state code, used for territory matching |
| `zip` | text | |
| `email` | text | nullable — required on the public form, optional on rep-scheduled |
| `phone` | text | required on both — needed for the click-to-call button |
| `message` | text | free-form notes from the practice |
| `service_interests` | text[] | subset of the 6 fixed category values (see Service categories below) |
| `requested_date` | date | what the practice asked for (public form) or what the rep set (rep-scheduled) |
| `requested_time` | time | |
| `confirmed_date` | date | set once approved/rescheduled |
| `confirmed_time` | time | |
| `status` | text, not null, default `'pending'` | `'pending'`, `'approved'`, `'time_suggested'`, `'declined'` — see Status lifecycle |
| `assigned_rep_id` | uuid, FK → `users.id`, nullable | set by territory match; null if no state match |
| `rep_notes` | text | optional notes a rep leaves (e.g. why they suggested another time) |
| `brand` | text | inferred from Origin/Referer on the public form, same as `webLeads.js`; null for rep-scheduled |
| `created_at` | timestamptz, not null, default `now()` | |
| `updated_at` | timestamptz, not null, default `now()` | |

### `office_visit_tokens`

Single-use, expiring action tokens for the two email-triggered actions. Modeled on `report_approval_tokens` (`src/services/reportApproval.js`) but kept separate since it references a booking, not a report.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK, default `gen_random_uuid()` | |
| `token` | text, unique, not null | `crypto.randomBytes(32).toString('hex')` |
| `booking_id` | uuid, not null, FK → `office_visit_bookings.id` | |
| `action` | text, not null | `'approve'` or `'suggest_time'` |
| `expires_at` | timestamptz, not null | 7 days (longer than the report-approval 24h TTL, since a rep may not check this email as urgently) |
| `used_at` | timestamptz, nullable | set on consumption |
| `created_at` | timestamptz, not null, default `now()` | |

## Service categories

Fixed list (user-approved, 2026-10-01), stored as plain strings in `service_interests`:

1. Crowns & Bridges
2. Removable Partials & Dentures
3. Digital Scanning & Models
4. Whitening & Cosmetic
5. Implant Restorations
6. General / Not Sure Yet

Defined as a shared constant on both Backend (validation) and Frontend (checkbox rendering) — duplicated, not fetched from an API, matching how small fixed lists are already handled elsewhere in this codebase (e.g. `MONTHLY_NEW_DOCTOR_TARGETS`).

## Status lifecycle

```
pending ──approve──────────────▶ approved
   │
   └──suggest_time─────────────▶ time_suggested ──(rep calls practice,
                                                     then sets a new date
                                                     in the CRM UI)──────▶ approved
```

`declined` exists in the schema for a rep who wants to explicitly close out a request without approving or suggesting a time (not in the user's original spec, but needed so a booking doesn't have to sit in limbo forever — surfaced to the user as an addition during spec review, see Spec Self-Review below).

## Way 1: Public booking form

### Endpoint

`POST /api/office-visits/request` — new route file `src/routes/officeVisits.js`, mounted directly in `src/index.js` alongside the other public, self-contained-CORS routes (`webLeads.js`, `implantIntake.js`, etc.) — **before** the global `cors()` middleware in `app.js`, per this repo's existing pattern for public marketing-site-facing forms. Brand inferred from `Origin`/`Referer` exactly like `webLeads.js`.

Validates: `contact_name`, `phone`, `address` fields, `requested_date`, `requested_time` are required. `email` required (practices need to receive the confirmation/pending email). Rate-limited via the existing `src/middleware/rateLimiter.js`, same as the other public routes.

### Flow

1. Insert `office_visit_bookings` row, `source: 'public_form'`, `status: 'pending'`.
2. **Territory matching**: look up `rep_territories` where `state_codes` contains the submitted `state`. First match wins (states won't overlap given only 2 real regions today). No match → `assigned_rep_id` stays null, notification email goes to a fallback address (`media@aimdentallab.com`, matching this codebase's existing fallback-notification convention) instead of a specific rep.
3. Create two `office_visit_tokens` rows (`approve`, `suggest_time`) for this booking.
4. Email the assigned rep (or fallback): practice/contact details, requested date/time, service interests, message, and two links:
   - `{BACKEND_URL}/api/office-visits/confirm?token=<approve-token>`
   - `{BACKEND_URL}/api/office-visits/confirm?token=<suggest-token>`

### GET-safe confirmation page

`GET /api/office-visits/confirm?token=...` — **read-only**, safe for email-scanner prefetch. Looks up the token (unused, unexpired), renders a small HTML confirmation page showing the booking details and a real `<button>`/form that POSTs to the actual action endpoint. Mirrors `reportApproval.js`'s `peekApprovalToken` / banner pattern exactly.

`POST /api/office-visits/confirm` (`{ token }` in body) — consumes the token (single-use, matching `consumeApprovalToken`), then:
- **`approve`**: `status → 'approved'`, `confirmed_date/time = requested_date/time`. Sends the practice a confirmation email: date/time, rep's name + phone (from `users` table), and a plain-text summary of what they submitted (service interests, message).
- **`suggest_time`**: `status → 'time_suggested'`. Sends the practice an email **on the same thread** (via `In-Reply-To`/`References` headers, same mechanism `email.js`'s `headers` param already supports) saying: *"This booking is pending and is not yet confirmed. [Rep name] will reach out directly to find a time that works. You can also call them at [rep phone] or book@... in the meantime."* — plus a `tel:` click-to-call button for **the practice's own number** (not the rep's — this is the button the rep clicks-through from their own inbox is a separate concern; re-reading the user's spec: *the click-to-call button is for the rep's benefit*, so it actually belongs on the **confirmation page** the rep sees before submitting "suggest another time", not the email sent to the practice. Corrected here — see Spec Self-Review.)

### Rescheduling after "suggest another time"

Not an email-link action (the rep needs to have actually talked to the practice first). Handled entirely in the CRM: the rep opens the booking from the new Office Visits tab (status `time_suggested`), sets a new `confirmed_date`/`confirmed_time`, clicks "Confirm" → `status → 'approved'` → same confirmation email as the Approve path fires.

## Way 2: Rep-scheduled (in-CRM)

`POST /api/office-visits` (auth-gated, any logged-in rep/admin) — new booking with `source: 'rep_scheduled'`, `status: 'approved'` immediately (no approval step needed, the rep is creating it directly), `assigned_rep_id` = the creating user. Confirmation email fires immediately **only if `email` was provided** — same template as the Approve path.

## Frontend

New tab **"Office Visits"** in `SchedulerSubNav` (`Frontend/src/components/Layout.jsx`), route `/scheduler/office-visits`, new page `Frontend/src/pages/scheduler/OfficeVisits.jsx`. Unlike the other Scheduler tabs, this page calls the CRM's own `src/lib/api.js` wrapper (`VITE_API_URL`), not `schedulerApi`.

List/calendar view of `office_visit_bookings`, filterable by status. `pending` rows show inline Approve/Suggest-time actions (calling the same `POST /api/office-visits/confirm` the email links use — a rep at their desk shouldn't have to go find the email). `time_suggested` rows show a "Set confirmed time" action. A "New Office Visit" button opens a form for Way 2.

`ProtectedRoute` (any logged-in user), matching Case Pickup Schedules — not admin-only, since both reps need to use this for their own bookings.

## Testing

Backend: `node:test` suite at `test/officeVisits/*.test.js` — territory matching (state → rep, no-match fallback), token lifecycle (single-use, expiry), status transitions, email content (confirmation summary, click-to-call button only on the rep-facing suggest-time confirmation page, thread headers on the suggest-time email to the practice), HTML-escaping of user-submitted practice data. Added to the `test` script in `package.json` alongside the existing suites.

## Spec Self-Review

- **Placeholder scan**: none found.
- **Internal consistency fix**: the user's original description put a click-to-call button in the email sent *to the practice* when the rep suggests another time — but the practice already has their own phone number; a click-to-call button is only useful to the **rep**, on the confirmation page they see *before* sending that email (so they can call the practice right then instead of hunting for the number). Corrected in the Way 1 section above; flagging explicitly for the user to confirm this reading is right.
- **Scope check**: focused enough for one implementation plan. Touches both repos but each piece (migration, backend routes, email templates, frontend tab) is independently small.
- **Ambiguity resolved**: added a `declined` status not in the original spec, so a booking has a way to be closed out without forcing an approve/suggest-time choice. Flagging as an addition.
- **Territory fallback**: a booking with no state match (e.g. a practice outside NY/CA) goes to `media@aimdentallab.com` rather than being silently unassigned — consistent with this codebase's existing fallback-notification pattern, not previously specified by the user.
