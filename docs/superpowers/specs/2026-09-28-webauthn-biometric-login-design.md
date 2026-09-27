# WebAuthn Biometric Login ("Face ID / Fingerprint") — Design

**Date:** 2026-09-28
**Status:** Approved in chat 2026-09-28 (conversational design). Awaiting written-spec review before an implementation plan is written.

## 1. Problem and goal

The CRM (`Frontend/`) is a PWA used heavily on phones. Every session currently requires typing an email + password (`src/hooks/useAuth.jsx`, `Backend/src/routes/auth.js`'s `POST /api/auth/login`), even though the phone itself already has Face ID / fingerprint hardware. The user wants an option to unlock the CRM with biometrics instead of retyping a password every time, on phones that support it, without weakening security.

Both convenience and security matter equally (explicit user answer). This is **not** a replacement for password auth — it is Option A: a fast unlock of an already-password-authenticated device, layered on top of the existing password flow, using a real server-verified WebAuthn/Passkey credential (Approach 1 — not a client-side-only lock screen, since a client-side PIN/lock screen protects nothing if the JWT itself is sitting in `localStorage`; the server must independently verify a cryptographic signature before issuing a session).

## 2. User flow

1. A user logs in with email + password as today, on a given phone/browser, for the first time.
2. Immediately after that successful login, if the device supports WebAuthn platform authenticators (feature-detected — see §7), the app shows a one-time prompt with the exact wording:
   **"Use Face ID / Fingerprint for faster sign-in?"**
   with "Yes" / "Not now" actions.
3. **Yes** → the browser's native Face ID / fingerprint / Windows Hello prompt runs immediately (this is what actually captures the biometric — the CRM itself never sees or touches biometric data). On success, a credential is registered for that user on that device (§3). A confirmation toast appears ("Face ID sign-in is ready").
4. **Not now** → nothing changes. The prompt is not shown again on that device (a local dismissal flag, not a nag), but the user can turn it on later from a new "Face ID / Fingerprint sign-in" toggle added to their profile/account settings.
5. On a later visit to `/login` on a device with a registered credential, the login page shows a prominent **"Sign in with Face ID / Fingerprint"** button above the email/password fields (which remain visible and fully usable below it, never hidden). Tapping it triggers the native biometric prompt directly — no email/password typing needed at all — and on success logs the user in exactly as password login would (same token, same `useAuth` state, same redirect to `/dashboard`).
6. Declining, cancelling the biometric prompt, or any failure at any point silently falls back to the ordinary password form. It is never a blocking error — password login is always available as the primary method.

## 3. What's stored server-side / security guarantees

A new Postgres table, `webauthn_credentials`:

| column | type | notes |
|---|---|---|
| `id` | uuid, PK | `gen_random_uuid()` |
| `user_id` | uuid, NOT NULL, FK-like reference to `users(id)` (no formal FK, matching this codebase's existing convention of no ORM/enforced FKs — see `clientRevenue.js`'s doctor-name-matching note) | |
| `credential_id` | text, UNIQUE, NOT NULL | base64url-encoded WebAuthn credential ID, as returned by the authenticator |
| `public_key` | text, NOT NULL | base64url-encoded COSE public key — **not a secret**; this is what lets the server verify signatures, it never lets anyone sign as the user |
| `sign_count` | bigint, NOT NULL, DEFAULT 0 | clone-detection counter (see §6) |
| `device_label` | text | e.g. "iPhone", set at registration from a coarse User-Agent check, never a full UA-parsing library |
| `created_at` | timestamptz, NOT NULL, DEFAULT now() | |
| `last_used_at` | timestamptz | updated on every successful biometric login |

**No biometric data (fingerprint image, face geometry, etc.) ever leaves the phone or reaches this server or this codebase, in any form.** That matching happens entirely inside the phone's secure hardware. What the server stores is a public key — cryptographically useless for impersonation without the matching private key, which never leaves the device's secure enclave.

A user can have multiple rows (one per device that registered Face ID/Fingerprint) — this is expected, not an edge case.

## 4. Fallback and multi-device handling

- Password sign-in is never removed, disabled, or hidden. It is always the fallback and the only method required.
- A new phone (no registered credential yet) simply goes through the same one-time password-login → prompt → registration flow again (step 1–3 above). No separate "recovery" flow is needed, because nothing is ever locked behind biometrics alone.
- If a phone is lost or a credential should be revoked, a self-service list of the user's own registered devices (by `device_label`/`created_at`/`last_used_at`) with a "Remove" action is added to account settings — a user removes only their own device's credential; no cross-user admin management is in scope for this feature.
- If the biometric login attempt fails for any reason (revoked credential, counter mismatch, browser quirk), the app clears its local "this device has Face ID set up" flag and drops back to the password form with a short, calm note — never an alarming error.

## 5. Role / scope

Available to any role — admin, staff, sales_rep — opt-in per device, nobody forced. This is purely a faster unlock mechanism for an account that already exists and already has a role; it changes nothing about `req.user.role` or any authorization check elsewhere in the app. (This was presented as the default recommendation and not separately challenged, so it stands as scope.)

## 6. Backend design

**Library:** [`@simplewebauthn/server`](https://simplewebauthn.dev/) (the standard, actively maintained Node WebAuthn relying-party library). No hand-rolled COSE/CBOR/attestation parsing.

**New file:** `Backend/src/routes/webauthn.js`, mounted in `src/app.js` at `/api/webauthn` alongside the other route mounts.

**Shared token issuance:** `src/routes/auth.js` currently builds the JWT payload and signs it inline inside `POST /login`. This logic is extracted into a small exported helper, e.g. `issueToken(user)` in `src/routes/auth.js`, returning `{ token, user: payload }` exactly as `/login` responds today. Both `/login` and the new biometric-login-verify endpoint call this helper, so the two paths can never drift in payload shape or expiry — the same reasoning already applied in this codebase to `leadConversion.js` for the manual-Convert vs. workflow-engine paths.

**Challenge storage:** WebAuthn registration and authentication are both two-step (server issues a random challenge → browser signs it → server verifies). The challenge must be held server-side between the two steps. Given this app's existing precedent for in-memory, single-instance-scoped state on this deployment (`src/middleware/rateLimiter.js` is explicitly documented as "fine for the current single-dyno Render deployment"), the pending challenge is held in a plain in-memory `Map` keyed by `user_id` (registration) or by a random per-attempt key returned to the client (login, since the server doesn't know the user yet — see below), with a 5-minute TTL swept lazily on each access. This avoids a schema table for purely ephemeral, short-lived data.

**Endpoints:**

1. `POST /api/webauthn/register/options` — **auth-gated** (`req.user` from the existing JWT middleware; this only runs right after a real password login, so a valid session already exists). Calls `generateRegistrationOptions()` with `residentKey: 'preferred', userVerification: 'required'`, excluding any `credential_id`s the user already has registered on other devices (so re-registering the same device isn't silently duplicated). Stores the challenge in the in-memory map under `req.user.id`. Returns the options object to the browser.
2. `POST /api/webauthn/register/verify` — **auth-gated**. Receives the browser's `RegistrationResponseJSON`. Looks up the stored challenge for `req.user.id`, calls `verifyRegistrationResponse()`. On success, inserts a new `webauthn_credentials` row (`user_id`, `credential_id`, `public_key`, `sign_count` from the verified counter, `device_label` derived from `req.headers['user-agent']` via a small inline heuristic — "iPhone" / "iPad" / "Android" / "This device" — not a UA-parsing dependency). Deletes the used challenge. Returns `{ ok: true, deviceLabel }`.
3. `POST /api/webauthn/login/options` — **public** (no session exists yet — this is how you get one). Calls `generateAuthenticationOptions()` with an empty `allowCredentials` (relying on discoverable/resident credentials registered in step 1, so the OS shows its own account/biometric picker without the CRM needing to know who's asking first). Generates a random opaque `attemptId`, stores the challenge under it, and returns `{ attemptId, options }`.
4. `POST /api/webauthn/login/verify` — **public**. Receives `{ attemptId, response }` where `response` is the browser's `AuthenticationResponseJSON`. Looks up the challenge by `attemptId`. The response's own `id` field (the credential ID) is used to look up the matching `webauthn_credentials` row and, via its `user_id`, the full user record — this is how the server learns which user is authenticating without having been told in advance. Calls `verifyAuthenticationResponse()` with that row's stored `public_key` and `sign_count`. On success: updates `sign_count` to the new counter value and `last_used_at`, then calls the same `issueToken(user)` helper as `/login` and returns `{ token, user }` in the identical shape. On any failure (unknown credential id, bad signature, or a returned counter not strictly greater than the stored one — the standard WebAuthn clone-detection check) returns 401 with no further detail (never reveals *why* — e.g. never distinguishes "unknown credential" from "bad signature" in the response body, to avoid enumeration).
5. `GET /api/webauthn/credentials` — **auth-gated**. Lists the calling user's own `webauthn_credentials` rows (`id`, `device_label`, `created_at`, `last_used_at`) — backs the account-settings device list in §4.
6. `DELETE /api/webauthn/credentials/:id` — **auth-gated**. Deletes a row, scoped to `WHERE id = $1 AND user_id = $2` so a user can only ever remove their own device's credential.

**Migration:** `Backend/scripts/v26-webauthn-credentials-migration.sql` (next unused version number in this directory), applied by hand in the Supabase SQL editor per this repo's existing convention — creates the `webauthn_credentials` table and a plain index on `credential_id`.

**Dependency:** `@simplewebauthn/server` added to `Backend/package.json`.

## 7. Frontend design

**Dependency:** `@simplewebauthn/browser` (companion client library — wraps `navigator.credentials.create`/`.get` with correct base64url handling) added to `Frontend/package.json`.

**New file:** `Frontend/src/lib/webauthn.js` — thin wrapper exposing:
- `isWebAuthnSupported()` — feature-detects `window.PublicKeyCredential` and, where available, `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`.
- `registerDevice()` — calls `register/options`, passes the result to `@simplewebauthn/browser`'s `startRegistration()`, POSTs the result to `register/verify`. Throws on any step's failure; callers treat any throw as "silently skip."
- `loginWithBiometrics()` — calls `login/options`, passes the result to `startAuthentication()`, POSTs `{ attemptId, response }` to `login/verify`, returns `{ token, user }` on success (same shape `useAuth` already expects from a password login).

**`src/hooks/useAuth.jsx` changes:** after a successful password login, if `isWebAuthnSupported()` is true and a per-device `localStorage` flag (`webauthn_prompt_dismissed`) is not set, show the "Use Face ID / Fingerprint for faster sign-in?" prompt. On "Yes," call `registerDevice()`; on success set a plain, non-sensitive `localStorage` flag `has_webauthn_credential` (used only to decide whether to show the biometric button on `/login` — never anything sensitive) and show a confirmation toast. On "Not now," set `webauthn_prompt_dismissed` and do nothing else.

**New file:** `Frontend/src/components/BiometricPrompt.jsx` — the small modal/banner for the prompt in step 2 above and the confirmation toast, kept out of `useAuth.jsx` and `Login.jsx` so neither file grows a modal's JSX inline.

**`src/pages/Login.jsx` changes:** on mount, if `isWebAuthnSupported()` and the `has_webauthn_credential` flag is set, render a "Sign in with Face ID / Fingerprint" button above the existing password form (the password form stays, unchanged, below it — never hidden or removed). Clicking it calls `loginWithBiometrics()`; on success, feeds the returned `{ token, user }` into the exact same post-login path the password form already uses in `useAuth.jsx` (so redirect-to-`/dashboard`, token storage in `localStorage` as `crm_token`, etc. all stay identical). On failure or cancellation, clear `has_webauthn_credential` and do nothing further — the password form underneath is already visible and usable.

**Account settings:** this app has no existing dedicated account-settings page — the closest thing today is the avatar-upload control already sitting in the sidebar's user-info block (`Frontend/src/components/Layout.jsx`, the `title="Click to change profile photo"` avatar). This design adds a small new "Security" panel (a modal, opened from that same sidebar user-info block, next to the avatar) rather than inventing a whole new route/page for one feature. It lists the user's own devices via `GET /api/webauthn/credentials` with a "Remove" button per row calling `DELETE /api/webauthn/credentials/:id`, and, if no devices are registered yet, an explicit "Set up Face ID / Fingerprint" action that re-runs `registerDevice()` (this is how a user who tapped "Not now" earlier can still turn it on later, per §2 step 4).

## 8. Error handling summary

| Situation | Behavior |
|---|---|
| Browser/device doesn't support WebAuthn | Prompt and button are never shown. No error, no console noise beyond a debug-level log. |
| User cancels the native biometric prompt (registration or login) | Silent fallback to password form / no-op. Never a toast or blocking error. |
| Registration succeeds but network call to `/register/verify` fails | Toast: "Couldn't finish setting up Face ID — please try again from settings." No retry loop, no state corruption (no local flag is set unless the server confirmed it). |
| Login-time verification fails (401 from `/login/verify`) | Clear `has_webauthn_credential` locally, show the password form with: "Face ID sign-in isn't available right now — please sign in with your password." Never a scary or technical error message. |
| HTTPS/secure-context requirement | Both Vercel (frontend) and Render (backend) are HTTPS in production; `localhost` is treated as a secure context by browsers in dev. No gap to handle. |

## 9. Testing approach

- **Backend:** unit tests for the register/verify and login/verify route handlers, using `@simplewebauthn/server`'s own documented approach for testing without real hardware (constructing verifiable mock attestation/assertion objects against a known test challenge). Added as a new `Backend/test/webauthn/*.test.js` suite and wired into the existing `npm test` script's file list (this repo's `test` script currently runs `node --test test/evidentReport/*.test.js test/salesRepDailyReport/*.test.js` — a real, growing `node --test` suite, not a stub).
- **End-to-end:** Playwright's Chrome DevTools Protocol Virtual Authenticator (`WebAuthn.enable` / `WebAuthn.addVirtualAuthenticator`) drives a real browser through the actual frontend and actual backend — register a virtual platform authenticator, exercise the full "password login → prompt → Yes → biometric registration" flow, reload, then exercise "Sign in with Face ID / Fingerprint" on `/login" — with zero mocking of the app itself. This matches this project's established preference for real, verified end-to-end proof (e.g. the Scheduler security-fix verification earlier this project) over trusting unit tests or a build passing as sufficient.
- No test relies on a real physical phone or a staging database — per this project's standing rule, any write-path testing during development uses one synthetic user, never a sweep against real production data.

## Out of scope (explicitly)

- Passkey-only login (removing password entirely) — not requested, would fail "both convenience and security matter equally."
- Cross-role restrictions (e.g. admin-only) — not requested; default is any role.
- A dedicated account-recovery flow for "lost phone with no other device" — unnecessary because password access is never removed.
- Syncing/roaming passkeys across a user's own multiple devices via a password manager (e.g. iCloud Keychain passkey sync) — out of scope for this design; each device registers its own credential independently. (If a platform's passkey manager syncs it automatically, that's a bonus, not something this design builds or tests for.)
