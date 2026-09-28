# Rep Progress Status Page — Design Spec

**Repos:** This spans both independent git repos under `aim-crm/` — `Backend/` (new endpoint) and `Frontend/` (new page). Read alongside `Backend/CLAUDE.md` and `Frontend/CLAUDE.md`.

## Goal

Give a sales rep a page inside the CRM where they can see their full Q4 2026 progress (October/November/December) against their real sales and new-doctor targets, anytime — not just in that day's Daily Sales Rep Report email. The same page also works for an admin viewing any rep, reusing the app's existing `?rep=<id>` convention (`Leads`, `Clients`, `Cases`, `Clinics`, `Pipeline` already do this). It includes a motivational message and concrete, deterministically-computed "suggested next steps" — not a live AI call, since this backend has no LLM integration yet and adding one wasn't approved for this feature.

## Why now

The Daily Sales Rep Report (built 2026-09-28) already computes and animates this month's sales/doctors progress, but only as a GIF baked into a specific day's email. There's no way for a rep or admin to see the whole quarter's trajectory, or to revisit today's numbers later in the day, without waiting for tomorrow's email.

## Real data dependency (does not block this spec)

The real Q4 monthly targets (James's and William's actual October/November/December sales and new-doctor numbers, from the "Final Push Daily Quotas" PDFs) are **not yet in the `goals` table** — only a flat September fallback exists. Entering those real numbers, including resolving William's $50K-monthly-checkpoints-vs-$55K-quarterly-goal discrepancy (a separate email to William, drafted 2026-09-29, pending his reply), is existing, separate, already-planned work gated until October 1 (per earlier user decision: "we will just deploy this once Q4 started"). This page is built to read whatever `goals` rows exist for each month and show an honest "target not set yet" state for any month without one — it does not depend on that data-entry work finishing first, and today (still September) it will legitimately show all three Q4 months as "not set yet" until real rows are entered.

## Architecture

**Backend:** one new endpoint, `GET /api/reports/rep-progress`.
- Query param `rep_id` (optional). Defaults to `req.user.id`.
- Access control is a small pure function, `resolveViewableRepId(user, queryRepId)` in `src/services/repProgress.js`: if `user.role` is scoped (`isScopedRole`, `src/utils/roles.js`) and `queryRepId` is supplied and doesn't match `user.id`, it throws an `Error` with `.status = 403`. Otherwise it returns the resolved id (`queryRepId || user.id` for an admin, always `user.id` for a scoped caller). The route wraps this in a try/catch and responds with the thrown status — this repo has no supertest/route-testing infrastructure (confirmed: no such dependency, no existing route-level test file), so pulling the actual access-control decision out into a pure function is what makes it directly unit-testable without one.
- For the resolved `rep_id`, fetch every `goals` row with `metric IN ('monthly_revenue','new_doctors')` whose `period_start`/`period_end` falls within Q4 2026 (`2026-10-01` through `2026-12-31`), grouped by calendar month.
- For each existing row, compute progress via the existing `computeProgress` (`src/services/goalProgress.js`) — same function the email bars and Leadership Dashboard already use, so the numbers are guaranteed consistent across every surface that shows them.
- For each of October/November/December, build a month entry: `{ month: 'October', salesGoal: <computeProgress result or null>, doctorsGoal: <computeProgress result or null> }`. `null` means no `goals` row exists yet for that metric/month — the frontend renders "Target not set yet" for it, never a fabricated $0-of-$0 bar.
- Compute `suggestedSteps`: an array of short strings from real gap-to-goal math (see "Suggested steps logic" below).
- Compute a motivational message via the existing `repCoachMessage` pattern (`src/services/email.js`), extended to speak across the quarter rather than just the current month (see below).
- Response shape:
  ```json
  {
    "repName": "James Delaney",
    "quarter": "Q4 2026",
    "months": [
      { "month": "October", "salesGoal": { "current_value": 12400, "target": 15000, "progress_pct": 83 } | null, "doctorsGoal": { ... } | null },
      { "month": "November", ... },
      { "month": "December", ... }
    ],
    "suggestedSteps": ["..."],
    "coachMessage": "..."
  }
  ```

**Frontend:** one new page, `Frontend/src/pages/ProgressStatus.jsx`, routed at `/progress` in `src/App.jsx` on `ProtectedRoute` (not `AdminRoute` — reps must reach their own).

**Correction to an earlier assumption in this spec:** `?rep=<userId>` is *not* currently read by any page from its own browser URL — it's only a backend query param that `RepDetail.jsx` (`/reps/:id`, admin-only) appends when calling `/api/leads`, `/api/clients`, `/api/cases`, etc. on a *different* page's behalf. No existing page reads `?rep=` from `window.location` itself. This page introduces that specific usage fresh (a plain `useSearchParams` read, from `react-router-dom`, already a dependency — no new library): `ProgressStatus.jsx` reads `?rep=<id>` from its own URL and passes it through to the API call when present; omitted for self-view. `RepDetail.jsx` gains a new "View Q4 Progress" link pointing at `/progress?rep=<id>` (`id` from its own `useParams()`), matching how it already links to other pages' rep-scoped views.

`/progress` (self, no query param) is added to both `STAFF_NAV` and `ADMIN_NAV` in `Layout.jsx` so it's reachable from the sidebar, not just a link inside the email. The rep's own daily email's existing "View my doctors" button area gains a second link ("View full Q4 status") pointing at `/progress` (self, no `?rep=` needed since the rep is expected to already be logged in when they click it — same assumption the existing CRM deep links already make, no new token/public-access mechanism).

## Suggested steps logic (deterministic, not AI)

A new pure function, `src/services/repProgressSuggestions.js`, `buildSuggestedSteps(months, todayStr)`:
- For the **current** calendar month only (the other two months are past or future — suggestions are only actionable for "right now"):
  - If both goals for the month are `null` (not set yet): return `["Monthly targets for {month} haven't been entered yet."]` and stop — nothing else to compute.
  - If sales goal exists and isn't yet met: compute business days remaining in the month (reuse `businessDaysLeftInMonth` from `salesRepDailyReport.js`) and the $ short; if days remaining > 0, add a step like `"You need about $X/day in sales to hit your {month} goal."` If sales goal is already met, add a congratulatory step instead of a numeric target.
  - If doctors goal exists and isn't yet met: same shape — doctors short ÷ remaining weeks (reuse the existing weeks-remaining logic from the PDF's own "per week" framing) → `"About N new doctor(s) a week gets you to your {month} goal."`
  - If both goals are met: a single celebratory step, no numeric pressure.
- Returns an array of 1-3 short strings, never fabricated numbers when the underlying goal is `null`.

## Motivational message

Extends the existing `repCoachMessage({ firstName, salesGoal, doctorsGoal, daysLeft, dayOfMonth })` (`src/services/email.js:471`) — reused as-is for the *current* month's coach note (identical function, so the message on this page matches today's email exactly, no drift). A second line is added summarizing the whole quarter only when at least one full month (October or November) has already ended and has real goal data, e.g. "You're pacing at N% of your total Q4 sales goal so far." Omitted entirely pre-October or when no goals exist yet.

## Animation

The GIF pipeline built for the email (Puppeteer/canvas/gifsicle, `goalBarGifRenderer.js`) is **not used here** — this is a real page rendered by the viewer's own browser, so native CSS handles it more simply and reliably than the email workaround:
- Each progress bar renders at `width: 0%` on first paint, then a `useEffect` (post-mount) sets it to its real `progress_pct`, so the browser's own CSS `transition: width 900ms cubic-bezier(...)` animates the fill — no timers driving intermediate frames, the browser interpolates it.
- The `$current`/`N doctors` numbers next to each bar count up from 0 to their real value over the same ~900ms window, via a small reusable hook `useCountUp(targetValue, durationMs)` (a single `requestAnimationFrame` loop per number, eased, cancels cleanly on unmount).
- Every animated number/bar is always paired with its real target text (e.g. "$12,400 of $15,000", "7 of 12 doctors") — the animation always represents real data, never a decorative flourish disconnected from the actual figures.
- The three month cards fade/slide in with a small stagger (`animation-delay`) on mount, current month first.
- All of the above is skipped — final values rendered immediately, no transition/animation-delay applied — when `window.matchMedia('(prefers-reduced-motion: reduce)').matches` is true. This is checked once on mount; the page does not need to react live to the setting changing mid-session.

## Error handling

- Rep with zero `goals` rows anywhere in Q4: page still renders, all three months show "Target not set yet," `suggestedSteps` shows the "haven't been entered yet" message, no crash.
- Scoped-role caller requesting another rep's `?rep=`: backend `403`; frontend shows a plain "You don't have access to this rep's progress" message instead of a blank or broken page.
- `rep_id` that doesn't exist as a user: backend `404`.
- API failure/network error: frontend shows a simple retry state, consistent with how other CRM list pages already handle a failed fetch.

## Testing

**Backend:**
- `test/repProgressSuggestions.test.js`: unit tests on `buildSuggestedSteps` covering — both goals null, sales met but doctors not, both met, a month with real gap numbers producing the expected $/day and doctors/week text, zero business days left in the month (no divide-by-zero).
- `test/repProgress.test.js`: unit tests on `resolveViewableRepId` covering — scoped user with no `queryRepId` returns their own id, scoped user with `queryRepId` equal to their own id returns it, scoped user with a *different* `queryRepId` throws with `.status === 403`, admin with no `queryRepId` returns their own id, admin with any `queryRepId` returns it unchanged.

**Frontend:** this repo has no JS unit-test framework installed (confirmed: `package.json` has no `test` script, no vitest/jest/testing-library dependency) — adding one is out of scope for this feature and wasn't part of the approved design. Verification here is a real-browser Playwright pass instead, matching this project's established practice: load `/progress` for a rep with real Q4 goals, confirm the bars/numbers animate to their correct final values and the "target not set yet" state renders correctly for a rep/month with no goal row; then re-check with the browser's reduced-motion emulation on (Playwright's `page.emulateMedia({ reducedMotion: 'reduce' })`), confirming the same final values appear immediately with no animation. Done at phone width (~390px).

## Review Focus

- A rep with no goals at all for any Q4 month (true today, pre-October) — page must not crash or show fabricated numbers. Covered above.
- A goal that's already been exceeded (`current_value > target`) — `progress_pct` must cap at 100 (already true of `computeProgress`, reused as-is here) and the suggested-steps text must switch to a celebration, never a negative "days remaining" or a percent over 100.
- `rep_id` for a real user who has no `role` in `('staff','sales_rep')` at all (e.g. an admin's own id passed as `rep_id`) — the endpoint should still work (it's just reading `goals` rows for that id), not assume the target is always a scoped-role user.
- A viewer with `prefers-reduced-motion` on who is also an admin viewing someone else's `?rep=` page — the reduced-motion check must not depend on whose data is being viewed, only the viewer's own browser setting.
- The current month rolling over mid-session (someone has the page open across midnight) — not handled specially; the page computes "current month" once on load, consistent with how the rest of this codebase (the daily email, the dashboard) treats "today" as fixed per request/render rather than live-updating.
