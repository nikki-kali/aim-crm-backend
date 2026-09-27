# WebAuthn Biometric Login ("Face ID / Fingerprint") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user unlock the CRM on their phone with Face ID / Fingerprint instead of retyping their password, without ever weakening password login or letting biometric data leave the phone.

**Architecture:** A new Backend Express route (`/api/webauthn`) built on `@simplewebauthn/server` issues and verifies real WebAuthn registration/authentication ceremonies, storing only a public key per device in a new `webauthn_credentials` table. The Frontend gets a small `lib/webauthn.js` wrapper around `@simplewebauthn/browser`, a one-time post-login prompt, a biometric sign-in button on `/login`, and a device-management panel — password sign-in is never removed or hidden.

**Tech Stack:** Node/Express, raw `pg` SQL, `@simplewebauthn/server` (Backend); React/Vite, `@simplewebauthn/browser` (Frontend).

**Spec:** `Backend/docs/superpowers/specs/2026-09-28-webauthn-biometric-login-design.md`

**Repos:** This plan spans two independent git repos under `/Users/nklimjoco/Downloads/aim-crm/` — `Backend/` and `Frontend/` — each with its own history. Every task below states which repo its files live in. Commit each repo's changes separately; a task that touches both repos makes two commits, one per repo.

## Global Constraints

- Backend dependency `@simplewebauthn/server@14.0.3`; Frontend dependency `@simplewebauthn/browser@14.0.0` — exact versions confirmed against the npm registry while writing this plan (2026-09-28). Note the v14 API: `startRegistration`/`startAuthentication` take `{ optionsJSON }`, and `verifyRegistrationResponse`'s result carries `registrationInfo.credential` (`{ id, publicKey, counter }`), not the flat `credentialID`/`credentialPublicKey`/`counter` shape of older versions.
- No new environment variables. WebAuthn's `rpID`/`expectedOrigin` are derived at runtime from the Backend's existing `FRONTEND_URL` env var (already comma-separated to support multiple domains during migrations, per this repo's CLAUDE.md) — never hardcode a domain.
- Exact required UI copy: **"Use Face ID / Fingerprint for faster sign-in?"** with **"Yes" / "Not now"** actions. Do not paraphrase.
- WebAuthn challenges are held in an in-memory `Map` with a 5-minute TTL — no new DB table for them. This mirrors the existing, documented precedent in `Backend/src/middleware/rateLimiter.js` (in-memory, single-dyno Render deployment, an accepted tradeoff already written down in this codebase).
- The new migration file is applied **by hand** in the Supabase SQL editor, exactly like every other `v*-migration.sql` in `Backend/scripts/` — no task in this plan runs it automatically.
- No staging database exists for this project. Any manual/functional verification against a real environment uses exactly one synthetic test user, created for that purpose and deleted afterward — never a sweep and never real user data.
- `Frontend/` has no test runner configured at all (confirmed: no test script, no test framework dependency). Frontend tasks are verified manually against the real dev server, matching how every other Frontend feature in this repo is verified today. Do not introduce a new frontend test framework as part of this plan.
- `Backend/` tests run via `node --test`, added to the `test` script in `Backend/package.json` (currently `"node --test test/evidentReport/*.test.js test/salesRepDailyReport/*.test.js"` — a real, already-growing suite). This plan adds only tests for pure, DB-free logic, matching this repo's own established convention that DB-writing route handlers are not unit-tested here (no staging DB) — see `Backend/test/evidentCrmSync.test.js`, which tests only `evidentCrmSync.js`'s pure helpers, never its DB-writing sync function.
- Requires Node 20+ on whichever machine runs `Backend/test/webauthn/webauthnHelpers.test.js` (uses `node:test`'s built-in `t.mock` API). The Backend's own local Node is v24.16.0; no `engines` field is pinned in `package.json`, so no change is needed there.
- Password sign-in is never removed, disabled, or hidden by any task in this plan. It is always visible on `/login` and always works.
- No role restriction: every `/api/webauthn` route is gated with the plain `auth` middleware only (any authenticated role — admin, staff, sales_rep). Do not add `requireAdmin` or any role check to these routes, even though nearby route files use it — this feature is opt-in per device for any role, per the approved spec.

## Review Focus

- **Two devices, one user.** Registering Face ID on a second phone must add a second `webauthn_credentials` row, not overwrite the first — the table has no unique constraint on `user_id`, only on `credential_id`, so two real INSERTs for the same user must both succeed. Pinned by Task 1's manual migration-verification step and Task 4's `excludeCredentials` behavior (it only excludes the *current* device's own already-registered credentials, never blocks a different device).
- **Login with a deleted/unknown credential.** A biometric login attempt whose `credential_id` is not in `webauthn_credentials` (e.g. it was removed via the Security panel) must return a clean 401, never a crash from dereferencing an empty query result. Pinned by Task 5's explicit `if (!row)` guard before any verification call.
- **Two open tabs racing registration.** Calling `register/options` twice before finishing either registration (e.g. two browser tabs) must not throw — the second call's challenge simply replaces the first for that user. Pinned by Task 3's explicit unit test on the challenge store.
- **A stale, reused challenge.** A registration or login attempt that replays a challenge older than 5 minutes must be rejected cleanly (400/401), never silently accepted. Pinned by Task 3's explicit TTL-expiry unit test (using `node:test`'s mock of `Date.now`) and Task 4/5's `if (!expectedChallenge)` guards.
- **Cross-user device removal (IDOR).** `DELETE /api/webauthn/credentials/:id` for a device ID that belongs to a *different* user must return 404, never silently succeed. Pinned by Task 6's `WHERE id = $1 AND user_id = $2` scoping and its explicit cross-user manual verification step.

---

### Task 1: Database migration — `webauthn_credentials` table

**Repo:** `Backend/`

**Files:**
- Create: `Backend/scripts/v26-webauthn-credentials-migration.sql`

**Interfaces:**
- Produces: table `webauthn_credentials(id uuid PK, user_id uuid, credential_id text UNIQUE, public_key text, sign_count bigint, device_label text, created_at timestamptz, last_used_at timestamptz)` and an index `webauthn_credentials_user_id_idx` — every later Backend task queries this table by these exact column names.

- [ ] **Step 1: Write the migration file**

```sql
-- v26-webauthn-credentials-migration.sql
-- Adds the webauthn_credentials table backing the Face ID / Fingerprint
-- biometric login feature. See the design spec:
-- docs/superpowers/specs/2026-09-28-webauthn-biometric-login-design.md
-- Stores only a public key + a human-readable device label per
-- registered device — never biometric data itself, which never leaves
-- the phone. Applied by hand in the Supabase SQL editor, like every
-- other v*-migration.sql file in this directory.

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL,
  credential_id text        NOT NULL UNIQUE,
  public_key    text        NOT NULL,
  sign_count    bigint      NOT NULL DEFAULT 0,
  device_label  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

-- credential_id already has an implicit unique index from the UNIQUE
-- constraint above; this index is for the lookups every other task in
-- this plan actually performs (GET /credentials, register/options'
-- excludeCredentials check — both filter WHERE user_id = $1).
CREATE INDEX IF NOT EXISTS webauthn_credentials_user_id_idx
  ON webauthn_credentials (user_id);
```

- [ ] **Step 2: Apply it by hand and verify structurally**

This is a database script, not application code — there is no automated test for it, matching every other file in `Backend/scripts/`. Apply it in the Supabase SQL editor for the project's real database (there is no staging DB), then run these two checks in the same editor:

```sql
-- 1. Confirm the shape:
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'webauthn_credentials';

-- 2. Confirm two credentials CAN belong to the same user (Review Focus
--    item 1) — pick any real user id from `SELECT id FROM users LIMIT 1`
--    and substitute it below. Both inserts must succeed; only a repeat
--    of the same credential_id should fail.
INSERT INTO webauthn_credentials (user_id, credential_id, public_key, device_label)
VALUES ('<a real user id>', 'test-cred-1', 'dGVzdA', 'Test Device A');
INSERT INTO webauthn_credentials (user_id, credential_id, public_key, device_label)
VALUES ('<the same user id>', 'test-cred-2', 'dGVzdA', 'Test Device B');
-- Both rows should now exist:
SELECT credential_id, device_label FROM webauthn_credentials WHERE user_id = '<the same user id>';
-- Clean up the test rows:
DELETE FROM webauthn_credentials WHERE credential_id IN ('test-cred-1', 'test-cred-2');
```

- [ ] **Step 3: Commit**

```bash
cd Backend
git add scripts/v26-webauthn-credentials-migration.sql
git commit -m "Add webauthn_credentials migration for Face ID / Fingerprint login

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Extract shared JWT-issuing helper

**Repo:** `Backend/`

**Files:**
- Create: `Backend/src/services/authTokens.js`
- Modify: `Backend/src/routes/auth.js` (all of it — currently 45 lines)
- Test: `Backend/test/authTokens.test.js`
- Modify: `Backend/package.json` (`test` script)

**Interfaces:**
- Produces: `issueToken(user)` — takes a user row (`{ id, email, name, role, ...anything else }`) and returns `{ token, user: { id, email, name, role } }`, signed with `process.env.JWT_SECRET` and `process.env.JWT_EXPIRY || '24h'`. Task 5 (`login/verify`) calls this exact function so both password login and biometric login issue identical tokens.

- [ ] **Step 1: Write the failing test**

Create `Backend/test/authTokens.test.js`:

```js
process.env.JWT_SECRET = 'test-only-secret-do-not-use-in-prod';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { issueToken } = require('../src/services/authTokens');

test('issueToken signs only id/email/name/role, never password_hash', () => {
  const user = { id: 'u1', email: 'rep@aimdentallab.com', name: 'Test Rep', role: 'staff', password_hash: '$2a$secret' };
  const { token, user: payload } = issueToken(user);
  assert.deepEqual(payload, { id: 'u1', email: 'rep@aimdentallab.com', name: 'Test Rep', role: 'staff' });
  assert.equal(payload.password_hash, undefined);
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(decoded.id, 'u1');
  assert.equal(decoded.role, 'staff');
});

test('issueToken sets a real, future expiry', () => {
  const user = { id: 'u2', email: 'a@b.com', name: 'A', role: 'admin' };
  const { token } = issueToken(user);
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  assert.ok(decoded.exp - decoded.iat > 0, 'expiry must be after issued-at');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Backend && node --test test/authTokens.test.js`
Expected: FAIL — `Cannot find module '../src/services/authTokens'`

- [ ] **Step 3: Write `src/services/authTokens.js`**

```js
const jwt = require('jsonwebtoken')

// Shared by password login (routes/auth.js) and biometric login
// (routes/webauthn.js) so the two paths can never issue differently
// shaped tokens.
function issueToken(user) {
  const payload = { id: user.id, email: user.email, name: user.name, role: user.role }
  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRY || '24h',
  })
  return { token, user: payload }
}

module.exports = { issueToken }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd Backend && node --test test/authTokens.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Refactor `src/routes/auth.js` to use it**

Replace the entire file:

```js
const express = require('express')
const bcrypt = require('bcryptjs')
const db = require('../config/db')
const auth = require('../middleware/auth')
const { issueToken } = require('../services/authTokens')

const router = express.Router()

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const { rows } = await db.query(
      'SELECT id, email, name, role, password_hash FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    )
    const user = rows[0]
    if (!user) return res.status(401).json({ error: 'Invalid email or password' })

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' })

    res.json(issueToken(user))
  } catch (err) {
    next(err)
  }
})

// GET /api/auth/me — returns full profile including avatar
router.get('/me', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT avatar FROM users WHERE id=$1', [req.user.id])
    res.json({ user: { ...req.user, avatar: rows[0]?.avatar || null } })
  } catch (err) { next(err) }
})

module.exports = router
```

- [ ] **Step 6: Manually verify `/login` still behaves identically**

Run: `cd Backend && npm run dev`, then in another terminal:

```bash
curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<a real user email>","password":"<their real password>"}'
```

Expected: same `{ "token": "...", "user": { "id", "email", "name", "role" } }` shape as before this change.

- [ ] **Step 7: Update the test script and commit**

In `Backend/package.json`, change:

```json
"test": "node --test test/evidentReport/*.test.js test/salesRepDailyReport/*.test.js",
```

to:

```json
"test": "node --test test/evidentReport/*.test.js test/salesRepDailyReport/*.test.js test/authTokens.test.js",
```

```bash
cd Backend
git add src/services/authTokens.js src/routes/auth.js test/authTokens.test.js package.json
git commit -m "Extract issueToken helper so password and biometric login share it

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: WebAuthn pure helpers — device labels, credential mapping, challenge store

**Repo:** `Backend/`

**Files:**
- Create: `Backend/src/services/webauthnHelpers.js`
- Test: `Backend/test/webauthn/webauthnHelpers.test.js`
- Modify: `Backend/package.json` (dependency + `test` script)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `deviceLabelFromUserAgent(userAgent)`, `publicKeyToText(publicKeyBytes)`, `rowToWebAuthnCredential(row)` (returns `{ id, publicKey, counter }` — the exact shape `@simplewebauthn/server`'s `verifyAuthenticationResponse` expects for its `credential` option), `saveChallenge(key, challenge)`, `takeChallenge(key)` (single-use — deletes on read, returns `undefined` if missing/expired), `CHALLENGE_TTL_MS`. Tasks 4-6 import all of these.

- [ ] **Step 1: Add the dependency**

```bash
cd Backend
npm install @simplewebauthn/server@14.0.3
```

- [ ] **Step 2: Write the failing tests**

Create `Backend/test/webauthn/webauthnHelpers.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deviceLabelFromUserAgent,
  publicKeyToText,
  rowToWebAuthnCredential,
  saveChallenge,
  takeChallenge,
  CHALLENGE_TTL_MS,
} = require('../../src/services/webauthnHelpers');

test('deviceLabelFromUserAgent recognizes common platforms and falls back safely', () => {
  assert.equal(deviceLabelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iPhone');
  assert.equal(deviceLabelFromUserAgent('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)'), 'iPad');
  assert.equal(deviceLabelFromUserAgent('Mozilla/5.0 (Linux; Android 14)'), 'Android device');
  assert.equal(deviceLabelFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)'), 'Mac');
  assert.equal(deviceLabelFromUserAgent('Mozilla/5.0 (Windows NT 10.0)'), 'Windows PC');
  assert.equal(deviceLabelFromUserAgent(''), 'This device');
  assert.equal(deviceLabelFromUserAgent(undefined), 'This device');
});

test('publicKeyToText and rowToWebAuthnCredential round-trip a public key losslessly', () => {
  const originalKey = Buffer.from([1, 2, 3, 250, 251, 252, 0, 255]);
  const text = publicKeyToText(originalKey);
  const row = { credential_id: 'cred-abc', public_key: text, sign_count: '7' };
  const credential = rowToWebAuthnCredential(row);
  assert.equal(credential.id, 'cred-abc');
  assert.equal(credential.counter, 7);
  assert.ok(Buffer.from(credential.publicKey).equals(originalKey));
});

test('takeChallenge returns the saved challenge exactly once, then undefined', () => {
  saveChallenge('user-1', 'challenge-xyz');
  assert.equal(takeChallenge('user-1'), 'challenge-xyz');
  assert.equal(takeChallenge('user-1'), undefined);
});

test('takeChallenge returns undefined for a key that was never saved', () => {
  assert.equal(takeChallenge('never-saved-key'), undefined);
});

test('saving a second challenge for the same key overwrites the first (e.g. two open tabs)', () => {
  saveChallenge('user-3', 'first-challenge');
  saveChallenge('user-3', 'second-challenge');
  assert.equal(takeChallenge('user-3'), 'second-challenge');
});

test('a challenge older than the TTL is treated as expired and removed', (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  saveChallenge('user-4', 'challenge-abc');
  now += CHALLENGE_TTL_MS + 1000;
  assert.equal(takeChallenge('user-4'), undefined);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd Backend && node --test test/webauthn/webauthnHelpers.test.js`
Expected: FAIL — `Cannot find module '../../src/services/webauthnHelpers'`

- [ ] **Step 4: Write `src/services/webauthnHelpers.js`**

```js
// Coarse device label for the Security panel's device list — never a
// full User-Agent-parsing dependency, just enough to tell devices apart.
function deviceLabelFromUserAgent(userAgent) {
  const ua = userAgent || ''
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android device'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  return 'This device'
}

// webauthn_credentials.public_key is stored as base64url text; this is
// what a freshly-verified registration's public key gets encoded to
// before that INSERT.
function publicKeyToText(publicKey) {
  return Buffer.from(publicKey).toString('base64url')
}

// Converts a webauthn_credentials row into the { id, publicKey, counter }
// shape @simplewebauthn/server's verifyAuthenticationResponse expects for
// its `credential` option.
function rowToWebAuthnCredential(row) {
  return {
    id: row.credential_id,
    publicKey: Buffer.from(row.public_key, 'base64url'),
    counter: Number(row.sign_count),
  }
}

// In-memory challenge store for the two-step WebAuthn ceremonies
// (server issues a challenge, browser signs it, server verifies). Fine
// for this app's current single-dyno Render deployment — same accepted
// tradeoff as middleware/rateLimiter.js. Never persisted; a restart just
// means any ceremony mid-flight has to start over.
const CHALLENGE_TTL_MS = 5 * 60 * 1000
const challenges = new Map() // key -> { challenge, expiresAt }

function sweepExpired(now) {
  for (const [key, entry] of challenges) {
    if (entry.expiresAt <= now) challenges.delete(key)
  }
}

function saveChallenge(key, challenge) {
  const now = Date.now()
  sweepExpired(now)
  challenges.set(key, { challenge, expiresAt: now + CHALLENGE_TTL_MS })
}

// Single-use: returns the challenge and removes it. Returns undefined if
// missing or expired — callers must treat that as "start the ceremony over".
function takeChallenge(key) {
  const now = Date.now()
  sweepExpired(now)
  const entry = challenges.get(key)
  if (!entry) return undefined
  challenges.delete(key)
  return entry.challenge
}

module.exports = {
  deviceLabelFromUserAgent,
  publicKeyToText,
  rowToWebAuthnCredential,
  saveChallenge,
  takeChallenge,
  CHALLENGE_TTL_MS,
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd Backend && node --test test/webauthn/webauthnHelpers.test.js`
Expected: PASS (6 tests)

- [ ] **Step 6: Update the test script and commit**

In `Backend/package.json`, change the `test` script (from Task 2's version) to:

```json
"test": "node --test test/evidentReport/*.test.js test/salesRepDailyReport/*.test.js test/authTokens.test.js test/webauthn/*.test.js",
```

```bash
cd Backend
git add src/services/webauthnHelpers.js test/webauthn/webauthnHelpers.test.js package.json package-lock.json
git commit -m "Add WebAuthn pure helpers: device labels, credential mapping, challenge store

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: WebAuthn registration endpoints

**Repo:** `Backend/`

**Files:**
- Create: `Backend/src/routes/webauthn.js`
- Modify: `Backend/src/app.js` (add require + mount)

**Interfaces:**
- Consumes: `issueToken` (Task 2, used by Task 5 later in this same file), `deviceLabelFromUserAgent`/`publicKeyToText`/`saveChallenge`/`takeChallenge` (Task 3), `webauthn_credentials` table (Task 1).
- Produces: `POST /api/webauthn/register/options` (auth-gated) — returns a `PublicKeyCredentialCreationOptionsJSON`. `POST /api/webauthn/register/verify` (auth-gated) — body is the raw `RegistrationResponseJSON` from the browser (not wrapped), returns `{ ok: true, deviceLabel }`. Later tasks (5, 6) append more routes to this same file and reuse its module-level `RP_ID`/`RP_IDS`/`FRONTEND_ORIGINS`/`RP_NAME` constants.

- [ ] **Step 1: Write `src/routes/webauthn.js`**

```js
const express = require('express')
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} = require('@simplewebauthn/server')
const db = require('../config/db')
const auth = require('../middleware/auth')
const {
  deviceLabelFromUserAgent,
  publicKeyToText,
  saveChallenge,
  takeChallenge,
} = require('../services/webauthnHelpers')

const router = express.Router()

// Reuses FRONTEND_URL (already comma-separated during domain migrations,
// see this repo's CLAUDE.md) instead of adding new env vars — WebAuthn's
// rpID/origin are just "which frontend origins may use this", which is
// exactly what FRONTEND_URL already answers.
const FRONTEND_ORIGINS = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const RP_IDS = FRONTEND_ORIGINS.map((origin) => new URL(origin).hostname)
const RP_ID = RP_IDS[0]
const RP_NAME = 'AIM Dental CRM'

// --- Registration: adding Face ID/Fingerprint to an already-logged-in session ---

router.post('/register/options', auth, async (req, res, next) => {
  try {
    const { rows: existing } = await db.query(
      'SELECT credential_id FROM webauthn_credentials WHERE user_id = $1',
      [req.user.id]
    )
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: req.user.email,
      userID: Buffer.from(req.user.id, 'utf8'),
      userDisplayName: req.user.name || req.user.email,
      attestationType: 'none',
      excludeCredentials: existing.map((row) => ({ id: row.credential_id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    })
    saveChallenge(`register:${req.user.id}`, options.challenge)
    res.json(options)
  } catch (err) {
    next(err)
  }
})

router.post('/register/verify', auth, async (req, res, next) => {
  try {
    const expectedChallenge = takeChallenge(`register:${req.user.id}`)
    if (!expectedChallenge) {
      return res.status(400).json({ error: 'Registration challenge expired — please try again' })
    }
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: FRONTEND_ORIGINS,
      expectedRPID: RP_IDS,
    })
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Could not verify this device' })
    }
    const { credential } = verification.registrationInfo
    const deviceLabel = deviceLabelFromUserAgent(req.headers['user-agent'])
    await db.query(
      `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, sign_count, device_label)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, credential.id, publicKeyToText(credential.publicKey), credential.counter, deviceLabel]
    )
    res.json({ ok: true, deviceLabel })
  } catch (err) {
    next(err)
  }
})

module.exports = router
```

- [ ] **Step 2: Mount the router in `src/app.js`**

Add near the other route requires (after `const userRoutes = require('./routes/users')`):

```js
const webauthnRoutes = require('./routes/webauthn')
```

Add right after `app.use('/api/auth', authRoutes)`:

```js
app.use('/api/webauthn', webauthnRoutes)
```

- [ ] **Step 3: Manually verify against a real (synthetic) user**

There is no automated test for this step — it is a DB-writing route handler, matching this repo's own convention (see Global Constraints). Verify manually:

```bash
cd Backend && npm run dev
```

In another terminal, log in as any real user to get a token, then call the new endpoint:

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login -H "Content-Type: application/json" -d '{"email":"<a real user email>","password":"<their real password>"}' | node -e "process.stdin.once('data', d => console.log(JSON.parse(d).token))")

curl -s http://localhost:4000/api/webauthn/register/options -H "Authorization: Bearer $TOKEN" | head -c 300
```

Expected: a JSON object with `challenge`, `rp`, `user`, `pubKeyCredParams`, etc. — a valid `PublicKeyCredentialCreationOptionsJSON`. (Calling `register/verify` with a fabricated body is not a meaningful test — a real browser/authenticator response is needed, which Task 10's end-to-end verification provides.)

- [ ] **Step 4: Commit**

```bash
cd Backend
git add src/routes/webauthn.js src/app.js
git commit -m "Add WebAuthn registration endpoints (register/options, register/verify)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: WebAuthn login endpoints

**Repo:** `Backend/`

**Files:**
- Modify: `Backend/src/routes/webauthn.js` (append)

**Interfaces:**
- Consumes: `RP_ID`, `RP_IDS`, `FRONTEND_ORIGINS` (module-level constants from Task 4, same file), `issueToken` (Task 2), `rowToWebAuthnCredential`/`saveChallenge`/`takeChallenge` (Task 3).
- Produces: `POST /api/webauthn/login/options` (public) — returns `{ attemptId, options }`. `POST /api/webauthn/login/verify` (public) — body is `{ attemptId, response }` where `response` is the browser's `AuthenticationResponseJSON` — returns `{ token, user }`, identical in shape to `POST /api/auth/login`'s response.

- [ ] **Step 1: Append the login endpoints to `src/routes/webauthn.js`**

Add near the top of the file (with the other `@simplewebauthn/server` imports):

```js
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server')
const crypto = require('crypto')
const { issueToken } = require('../services/authTokens')
const {
  deviceLabelFromUserAgent,
  publicKeyToText,
  rowToWebAuthnCredential,
  saveChallenge,
  takeChallenge,
} = require('../services/webauthnHelpers')
```

(This replaces the Task 4 versions of these two `require` lines — merge rather than duplicate.)

Add after the `register/verify` route, before `module.exports = router`:

```js
// --- Login: biometric unlock, no session exists yet ---

router.post('/login/options', async (req, res, next) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
    })
    // The server doesn't know who's asking yet (no session) — a random
    // opaque attemptId is how login/verify finds the matching challenge
    // back, in place of the user_id key registration uses.
    const attemptId = crypto.randomBytes(16).toString('hex')
    saveChallenge(`login:${attemptId}`, options.challenge)
    res.json({ attemptId, options })
  } catch (err) {
    next(err)
  }
})

router.post('/login/verify', async (req, res, next) => {
  try {
    const { attemptId, response } = req.body
    const expectedChallenge = attemptId ? takeChallenge(`login:${attemptId}`) : undefined
    if (!expectedChallenge || !response?.id) {
      return res.status(401).json({ error: 'Face ID / Fingerprint sign-in failed' })
    }

    const { rows } = await db.query(
      `SELECT wc.credential_id, wc.public_key, wc.sign_count, u.id AS user_id, u.email, u.name, u.role
       FROM webauthn_credentials wc JOIN users u ON u.id = wc.user_id
       WHERE wc.credential_id = $1`,
      [response.id]
    )
    const row = rows[0]
    if (!row) {
      // Unknown or previously-removed credential (Review Focus item 2) —
      // same generic message as any other failure, never distinguishing
      // "unknown credential" from "bad signature" to avoid enumeration.
      return res.status(401).json({ error: 'Face ID / Fingerprint sign-in failed' })
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: FRONTEND_ORIGINS,
      expectedRPID: RP_IDS,
      credential: rowToWebAuthnCredential(row),
    })
    if (!verification.verified) {
      return res.status(401).json({ error: 'Face ID / Fingerprint sign-in failed' })
    }

    await db.query(
      'UPDATE webauthn_credentials SET sign_count = $1, last_used_at = now() WHERE credential_id = $2',
      [verification.authenticationInfo.newCounter, response.id]
    )

    res.json(issueToken({ id: row.user_id, email: row.email, name: row.name, role: row.role }))
  } catch (err) {
    next(err)
  }
})
```

- [ ] **Step 2: Manually verify the unknown-credential failure path**

Run: `cd Backend && npm run dev` (if not already running), then:

```bash
curl -s -X POST http://localhost:4000/api/webauthn/login/options | node -e "process.stdin.once('data', d => console.log(JSON.parse(d).attemptId))"
```

Take the printed `attemptId` and call verify with a credential id that cannot exist:

```bash
curl -s -w '\n%{http_code}\n' -X POST http://localhost:4000/api/webauthn/login/verify \
  -H "Content-Type: application/json" \
  -d '{"attemptId":"<the attemptId above>","response":{"id":"this-credential-id-does-not-exist"}}'
```

Expected: `401` and `{"error":"Face ID / Fingerprint sign-in failed"}` — not a 500 crash (Review Focus item 2).

Also verify the expired-challenge path (Review Focus item 4): call `login/options`, wait, then call `login/verify` with an `attemptId` that was never returned by any `login/options` call (simulating "expired and already swept" — this is equivalent since an unknown key and an expired key both make `takeChallenge` return `undefined`):

```bash
curl -s -w '\n%{http_code}\n' -X POST http://localhost:4000/api/webauthn/login/verify \
  -H "Content-Type: application/json" \
  -d '{"attemptId":"never-issued-attempt-id","response":{"id":"anything"}}'
```

Expected: `401`, not a crash.

- [ ] **Step 3: Commit**

```bash
cd Backend
git add src/routes/webauthn.js
git commit -m "Add WebAuthn login endpoints (login/options, login/verify)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: WebAuthn device-management endpoints

**Repo:** `Backend/`

**Files:**
- Modify: `Backend/src/routes/webauthn.js` (append)

**Interfaces:**
- Consumes: `auth` middleware (already imported in this file from Task 4).
- Produces: `GET /api/webauthn/credentials` (auth-gated) — returns `[{ id, device_label, created_at, last_used_at }]` for the calling user only. `DELETE /api/webauthn/credentials/:id` (auth-gated) — returns `{ ok: true }` on success, `404` if the id doesn't exist *or* belongs to a different user. Frontend's `SecurityPanel.jsx` (Task 9) calls both.

- [ ] **Step 1: Append the device-management endpoints**

Add before `module.exports = router`:

```js
// --- Device management (Security panel) ---

router.get('/credentials', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, device_label, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    )
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

router.delete('/credentials/:id', auth, async (req, res, next) => {
  try {
    // Scoped to the caller's own user_id — a device ID that exists but
    // belongs to someone else must 404, never silently succeed
    // (Review Focus item 5).
    const { rowCount } = await db.query(
      'DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    )
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
```

- [ ] **Step 2: Manually verify the cross-user delete is rejected**

Run: `cd Backend && npm run dev` (if not already running). Using two different real users' credentials (log in as each to get two tokens — call them `TOKEN_A` and `TOKEN_B`):

```bash
# As user A, register a device to get a real credential id (or, faster,
# insert one directly for this check):
psql "$DATABASE_URL" -c "INSERT INTO webauthn_credentials (user_id, credential_id, public_key, device_label) SELECT id, 'idor-check-cred', 'dGVzdA', 'IDOR check' FROM users WHERE email = '<user A email>' RETURNING id;"
# Note the returned id, call it DEVICE_ID.

# As user B (a DIFFERENT user), attempt to delete user A's device:
curl -s -w '\n%{http_code}\n' -X DELETE http://localhost:4000/api/webauthn/credentials/<DEVICE_ID> \
  -H "Authorization: Bearer $TOKEN_B"
```

Expected: `404`. Then confirm user A can still see it:

```bash
curl -s http://localhost:4000/api/webauthn/credentials -H "Authorization: Bearer $TOKEN_A"
```

Expected: the `idor-check-cred` row is still present. Clean up:

```bash
psql "$DATABASE_URL" -c "DELETE FROM webauthn_credentials WHERE credential_id = 'idor-check-cred';"
```

- [ ] **Step 3: Commit**

```bash
cd Backend
git add src/routes/webauthn.js
git commit -m "Add WebAuthn device list/remove endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend WebAuthn client wrapper

**Repo:** `Frontend/`

**Files:**
- Create: `Frontend/src/lib/webauthn.js`
- Modify: `Frontend/package.json`

**Interfaces:**
- Consumes: `api` (`Frontend/src/lib/api.js`, existing — `api.post(path, body)` attaches the bearer token when one exists in `localStorage`, but the Backend's `login/options`/`login/verify` routes never check it, so it's harmless to call them the normal way with no special "public" flag).
- Produces: `isWebAuthnSupported()` (async, returns boolean), `registerDevice()` (async, resolves `{ ok, deviceLabel }` or rejects), `loginWithBiometrics()` (async, resolves `{ token, user }` — same shape `useAuth`'s `signIn` already produces, or rejects). Tasks 8 and 9 import all three.

- [ ] **Step 1: Add the dependency**

```bash
cd Frontend
npm install @simplewebauthn/browser@14.0.0
```

- [ ] **Step 2: Write `src/lib/webauthn.js`**

```js
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
} from '@simplewebauthn/browser'
import api from './api'

export async function isWebAuthnSupported() {
  if (!browserSupportsWebAuthn()) return false
  try {
    return await platformAuthenticatorIsAvailable()
  } catch {
    return false
  }
}

export async function registerDevice() {
  const optionsJSON = await api.post('/api/webauthn/register/options')
  // Let a cancel/unsupported error from startRegistration propagate as-is
  // (callers treat any such error as "silent fallback"). Only the final
  // network call gets tagged, so callers can show a distinct message for
  // "the device-level ceremony succeeded but saving it failed" (spec
  // section 8) instead of treating it the same as a plain cancel.
  const response = await startRegistration({ optionsJSON })
  try {
    return await api.post('/api/webauthn/register/verify', response)
  } catch (err) {
    err.stage = 'verify'
    throw err
  }
}

export async function loginWithBiometrics() {
  const { attemptId, options } = await api.post('/api/webauthn/login/options')
  const response = await startAuthentication({ optionsJSON: options })
  return api.post('/api/webauthn/login/verify', { attemptId, response })
}
```

- [ ] **Step 3: Manually verify it loads with no console errors**

Run: `cd Frontend && npm run dev`, open `http://localhost:5173/login` in a real browser, open devtools console, and run:

```js
import('/src/lib/webauthn.js').then(m => m.isWebAuthnSupported().then(console.log))
```

Expected: resolves to `true` or `false` (depending on the test machine's hardware) with no thrown error. There is no automated test for this file — it is a thin wrapper around a browser API and the (already-covered) `api.js`, and this Frontend has no test runner configured (Global Constraints).

- [ ] **Step 4: Commit**

```bash
cd Frontend
git add src/lib/webauthn.js package.json package-lock.json
git commit -m "Add lib/webauthn.js wrapper around @simplewebauthn/browser

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: One-time prompt + biometric sign-in on Login

**Repo:** `Frontend/`

**Files:**
- Create: `Frontend/src/components/BiometricPrompt.jsx`
- Modify: `Frontend/src/hooks/useAuth.jsx`
- Modify: `Frontend/src/pages/Login.jsx` (all of it — currently 142 lines)

**Interfaces:**
- Consumes: `registerDevice`, `isWebAuthnSupported`, `loginWithBiometrics` (Task 7); `useToast` (`Frontend/src/components/Toast.jsx`, existing).
- Produces: `useAuth()`'s context gains `signInWithToken(token, userData)` (commits an already-obtained token/user into auth state exactly like `signIn` does — Task 9's `SecurityPanel.jsx` does not need this, but Login.jsx's biometric path does). `localStorage` flags `has_webauthn_credential` and `webauthn_prompt_dismissed` (plain booleans as the string `'true'`, never anything sensitive) — Task 9 reads/clears `has_webauthn_credential` too.

- [ ] **Step 1: Add `signInWithToken` to `src/hooks/useAuth.jsx`**

Replace the `signIn` function and add a new one right after it:

```js
  const signIn = async (email, password) => {
    try {
      const { token, user: userData } = await api.post('/api/auth/login', { email, password })
      await signInWithToken(token, userData)
      return { error: null }
    } catch (err) {
      return { error: { message: err.message || 'Invalid email or password' } }
    }
  }

  const signInWithToken = async (token, userData) => {
    api.setToken(token)
    setUser(userData)
    try {
      const { user: full } = await api.get('/api/auth/me')
      setUser(full)
    } catch {}
  }
```

And add `signInWithToken` to the context value:

```js
  return (
    <AuthContext.Provider value={{ user, loading, signIn, signInWithToken, signOut, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
```

- [ ] **Step 2: Write `src/components/BiometricPrompt.jsx`**

```jsx
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Fingerprint } from 'lucide-react'
import { registerDevice } from '../lib/webauthn'
import { useToast } from './Toast'

export default function BiometricPrompt({ onDone }) {
  const toast = useToast()
  const [loading, setLoading] = useState(false)

  const handleYes = async () => {
    setLoading(true)
    try {
      await registerDevice()
      localStorage.setItem('has_webauthn_credential', 'true')
      toast('Face ID sign-in is ready', 'success')
    } catch (err) {
      if (err?.stage === 'verify') {
        // The device-level ceremony succeeded but saving it failed
        // (network blip) — this one case gets a visible toast per the
        // approved spec's error table; a plain cancel stays silent.
        toast("Couldn't finish setting up Face ID — please try again from settings.", 'error')
      }
      // Cancelled by the user, or unsupported — silent fallback, never a
      // blocking error. Password sign-in already succeeded either way.
    } finally {
      setLoading(false)
      onDone()
    }
  }

  const handleNotNow = () => {
    localStorage.setItem('webauthn_prompt_dismissed', 'true')
    onDone()
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center p-4"
      >
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 text-center"
        >
          <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-[#06babe]/10 flex items-center justify-center">
            <Fingerprint className="text-[#06babe]" size={24} />
          </div>
          <h2 className="text-base font-bold text-slate-800 mb-2">
            Use Face ID / Fingerprint for faster sign-in?
          </h2>
          <p className="text-sm text-slate-500 mb-6">
            You'll still be able to sign in with your password anytime.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleNotNow}
              disabled={loading}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50"
            >
              Not now
            </button>
            <button
              onClick={handleYes}
              disabled={loading}
              className="flex-1 btn-primary py-2.5 disabled:opacity-50"
            >
              {loading ? 'Setting up...' : 'Yes'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
```

- [ ] **Step 3: Rewrite `src/pages/Login.jsx`**

Replace the entire file:

```jsx
import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useAuth } from '../hooks/useAuth'
import { useNavigate } from 'react-router-dom'
import { Fingerprint } from 'lucide-react'
import { isWebAuthnSupported, loginWithBiometrics } from '../lib/webauthn'
import BiometricPrompt from '../components/BiometricPrompt'

const ORBS = [
  { size: 520, top: '-10%', left: '-10%', x: [0, 40, 0], y: [0, 30, 0], dur: 12, color: '#06babe', opacity: 0.18 },
  { size: 400, top: '50%',  left: '60%',  x: [0, -35, 0], y: [0, -40, 0], dur: 15, color: '#207290', opacity: 0.14 },
  { size: 300, top: '70%',  left: '5%',   x: [0, 25, 0], y: [0, -20, 0], dur: 10, color: '#06babe', opacity: 0.10 },
  { size: 250, top: '15%',  left: '70%',  x: [0, -20, 0], y: [0, 30, 0], dur: 9,  color: '#0891b2', opacity: 0.12 },
]

export default function Login() {
  const { signIn, signInWithToken } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [bioSupported, setBioSupported] = useState(false)
  const [bioLoading, setBioLoading] = useState(false)
  const [showBiometricPrompt, setShowBiometricPrompt] = useState(false)

  useEffect(() => {
    isWebAuthnSupported().then(setBioSupported)
  }, [])

  const hasBiometricCredential = bioSupported && localStorage.getItem('has_webauthn_credential') === 'true'

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await signIn(email, password)
    setLoading(false)
    if (error) {
      setError(error.message)
      return
    }
    const alreadyDecided = localStorage.getItem('webauthn_prompt_dismissed') === 'true'
      || localStorage.getItem('has_webauthn_credential') === 'true'
    if (bioSupported && !alreadyDecided) {
      setShowBiometricPrompt(true)
    } else {
      navigate('/dashboard')
    }
  }

  const handleBiometricLogin = async () => {
    setBioLoading(true)
    setError('')
    try {
      const { token, user } = await loginWithBiometrics()
      await signInWithToken(token, user)
      navigate('/dashboard')
    } catch {
      localStorage.removeItem('has_webauthn_credential')
      setError("Face ID sign-in isn't available right now — please sign in with your password.")
    } finally {
      setBioLoading(false)
    }
  }

  return (
    <div className="relative min-h-screen bg-[#f0fbfc] flex items-center justify-center p-4 overflow-hidden">

      {/* Animated gradient orbs */}
      {ORBS.map((orb, i) => (
        <motion.div
          key={i}
          className="absolute rounded-full pointer-events-none"
          style={{
            width: orb.size,
            height: orb.size,
            top: orb.top,
            left: orb.left,
            background: orb.color,
            opacity: orb.opacity,
            filter: 'blur(80px)',
          }}
          animate={{ x: orb.x, y: orb.y }}
          transition={{ duration: orb.dur, repeat: Infinity, repeatType: 'mirror', ease: 'easeInOut' }}
        />
      ))}

      {/* Subtle grid overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: 'linear-gradient(rgba(6,186,190,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(6,186,190,0.04) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <div className="relative w-full max-w-sm z-10">
        {/* Logos */}
        <motion.div
          className="text-center mb-8"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        >
          <div className="flex items-center justify-center gap-6 mb-4">
            <img src="/logo.png" alt="Aim Dental Laboratory" className="h-10 w-auto drop-shadow-sm" />
            <div className="w-px h-8 bg-gray-300" />
            <img src="/kh-logo.png" alt="Kings Highway Dental Laboratory" className="h-10 w-auto drop-shadow-sm" />
          </div>
          <p className="text-sm text-gray-500 font-medium tracking-wide">CRM Portal</p>
        </motion.div>

        {/* Card */}
        <motion.div
          className="bg-white/80 backdrop-blur-xl rounded-2xl shadow-xl border border-white/60 p-6"
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94], delay: 0.1 }}
        >
          {hasBiometricCredential && (
            <>
              <button
                type="button"
                onClick={handleBiometricLogin}
                disabled={bioLoading}
                className="w-full flex items-center justify-center gap-2 py-2.5 mb-4 rounded-xl border border-[#06babe]/30 text-[#06babe] font-semibold text-sm hover:bg-[#06babe]/5 transition-colors disabled:opacity-50"
              >
                <Fingerprint size={18} />
                {bioLoading ? 'Verifying...' : 'Sign in with Face ID / Fingerprint'}
              </button>
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-slate-200" />
                <span className="text-xs text-slate-400">or</span>
                <div className="flex-1 h-px bg-slate-200" />
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Email</label>
              <input
                type="email"
                className="input"
                placeholder="you@aimdentallab.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                type="password"
                className="input"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>
            {error && (
              <motion.p
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2"
              >
                {error}
              </motion.p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full btn-primary py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        </motion.div>

        <motion.p
          className="text-center text-xs text-gray-400 mt-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
        >
          Contact your admin to get access
        </motion.p>
      </div>

      {showBiometricPrompt && (
        <BiometricPrompt onDone={() => { setShowBiometricPrompt(false); navigate('/dashboard') }} />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Manually verify with a real (synthetic) user, without a virtual authenticator yet**

Run: `cd Frontend && npm run dev` and `cd Backend && npm run dev` (both). Log in on `http://localhost:5173/login` as any real staff/sales_rep user on a machine/browser that reports WebAuthn support (most modern laptops with Touch ID/Windows Hello, or just check the console log from Task 7 Step 3). Expected: the "Use Face ID / Fingerprint for faster sign-in?" prompt appears immediately after a successful password login, with "Yes"/"Not now" buttons, and the app still lands on `/dashboard` either way. On a browser/machine with no platform authenticator, expected: no prompt appears, and login behaves exactly as it did before this task (this is the primary, unchanged path — most real usage today). Full biometric-registration-then-login proof (with a virtual authenticator) is Task 10.

- [ ] **Step 5: Commit**

```bash
cd Frontend
git add src/hooks/useAuth.jsx src/components/BiometricPrompt.jsx src/pages/Login.jsx
git commit -m "Add one-time Face ID / Fingerprint prompt and biometric sign-in on Login

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Security panel for managing registered devices

**Repo:** `Frontend/`

**Files:**
- Create: `Frontend/src/components/SecurityPanel.jsx`
- Modify: `Frontend/src/components/Layout.jsx`

**Interfaces:**
- Consumes: `registerDevice`, `isWebAuthnSupported` (Task 7); `useToast` (existing); `GET`/`DELETE /api/webauthn/credentials` (Task 6).
- Produces: nothing consumed by later tasks — this is the last Frontend UI task before end-to-end verification.

- [ ] **Step 1: Write `src/components/SecurityPanel.jsx`**

```jsx
import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Fingerprint, Trash2 } from 'lucide-react'
import api from '../lib/api'
import { registerDevice, isWebAuthnSupported } from '../lib/webauthn'
import { useToast } from './Toast'

export default function SecurityPanel({ open, onClose }) {
  const toast = useToast()
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [supported, setSupported] = useState(false)
  const [settingUp, setSettingUp] = useState(false)

  useEffect(() => {
    if (!open) return
    isWebAuthnSupported().then(setSupported)
    setLoading(true)
    api.get('/api/webauthn/credentials')
      .then(setDevices)
      .catch(() => setDevices([]))
      .finally(() => setLoading(false))
  }, [open])

  const handleRemove = async (id) => {
    try {
      await api.delete(`/api/webauthn/credentials/${id}`)
      const remaining = devices.filter((d) => d.id !== id)
      setDevices(remaining)
      if (remaining.length === 0) localStorage.removeItem('has_webauthn_credential')
      toast('Device removed', 'success')
    } catch {
      toast("Couldn't remove that device", 'error')
    }
  }

  const handleSetUp = async () => {
    setSettingUp(true)
    try {
      await registerDevice()
      localStorage.setItem('has_webauthn_credential', 'true')
      const rows = await api.get('/api/webauthn/credentials')
      setDevices(rows)
      toast('Face ID / Fingerprint sign-in is ready', 'success')
    } catch {
      toast("Couldn't set up Face ID / Fingerprint on this device", 'error')
    } finally {
      setSettingUp(false)
    }
  }

  if (!open) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <Fingerprint size={18} className="text-[#06babe]" />
              Face ID / Fingerprint sign-in
            </h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
              <X size={18} />
            </button>
          </div>

          {loading ? (
            <p className="text-sm text-slate-400 py-4 text-center">Loading...</p>
          ) : (
            <>
              {devices.length === 0 ? (
                <p className="text-sm text-slate-500 mb-4">No devices set up yet.</p>
              ) : (
                <div className="divide-y divide-slate-100 mb-4">
                  {devices.map((d) => (
                    <div key={d.id} className="flex items-center justify-between py-2.5">
                      <div>
                        <p className="text-sm font-semibold text-slate-700">{d.device_label || 'This device'}</p>
                        <p className="text-xs text-slate-400">
                          Added {new Date(d.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <button
                        onClick={() => handleRemove(d.id)}
                        title="Remove this device"
                        className="text-slate-400 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {supported ? (
                <button
                  onClick={handleSetUp}
                  disabled={settingUp}
                  className="w-full btn-primary py-2.5 disabled:opacity-50"
                >
                  {settingUp ? 'Setting up...' : 'Set up Face ID / Fingerprint on this device'}
                </button>
              ) : (
                <p className="text-xs text-slate-400 text-center">
                  This device doesn't support Face ID / Fingerprint sign-in.
                </p>
              )}
            </>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
```

- [ ] **Step 2: Wire it into `src/components/Layout.jsx`**

This app has no existing dedicated account-settings page — the closest thing today is the avatar-upload control already in the sidebar's user-info block. Add a small icon button there instead of a new route.

Add `Fingerprint` to the existing lucide-react import (currently `Camera, Sun, Moon, ChevronRight, CalendarDays, HelpCircle, ListChecks, Clock`):

```js
import {
  LayoutDashboard, Users, UserCheck, LogOut, ClipboardList,
  BarChart3, TrendingUp, Zap, UserCog, Shield, Building2,
  Camera, Sun, Moon, ChevronRight, CalendarDays, HelpCircle, ListChecks, Clock, Fingerprint,
} from 'lucide-react'
```

Add a new import for `SecurityPanel`:

```js
import SecurityPanel from './SecurityPanel'
```

Change `SidebarContent`'s signature (currently `function SidebarContent({ user, isAdmin, navItems, currentPath, onClose, onAvatarClick, uploading, onSignOut }) {`) to accept the new prop:

```js
function SidebarContent({ user, isAdmin, navItems, currentPath, onClose, onAvatarClick, uploading, onSignOut, onOpenSecurity }) {
```

In the "User info + avatar" block, add a button right after the name/role `<div>` (still inside the same flex row as the `Avatar`):

```jsx
        <div className="flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-white/40 dark:hover:bg-white/5 transition-colors">
          <Avatar user={user} size={36} onClick={onAvatarClick} uploading={uploading} />
          <div className="min-w-0 flex-1 max-w-0 opacity-0 overflow-hidden group-hover:max-w-[200px] group-hover:opacity-100 transition-all duration-200">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate leading-tight whitespace-nowrap">
              {user?.name || user?.email}
            </p>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot flex-shrink-0" />
              <Shield size={9} className={`flex-shrink-0 ${isAdmin ? 'text-[#06babe]' : 'text-slate-300 dark:text-slate-600'}`} />
              <p className="text-xs text-slate-400 whitespace-nowrap">{roleLabel(user?.role || 'staff')}</p>
            </div>
          </div>
          <button
            onClick={onOpenSecurity}
            title="Face ID / Fingerprint sign-in"
            className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:text-[#06babe] hover:bg-[#06babe]/10 transition-colors opacity-0 group-hover:opacity-100"
          >
            <Fingerprint size={14} />
          </button>
        </div>
```

In the `Layout` function, add state alongside `uploading`:

```js
  const [uploading, setUploading] = useState(false)
  const [showSecurityPanel, setShowSecurityPanel] = useState(false)
```

Add `onOpenSecurity` to `sidebarProps`:

```js
  const sidebarProps = {
    user, isAdmin, navItems,
    currentPath: location.pathname,
    onAvatarClick: handleAvatarClick,
    uploading,
    onSignOut: handleSignOut,
    onOpenSecurity: () => setShowSecurityPanel(true),
  }
```

Render the panel as a sibling of the sidebar/main-content div, right before the outer div's closing tag:

```jsx
        <MobileTabBar {...sidebarProps} />
        <QuickLeadButton />
      </div>

      <SecurityPanel open={showSecurityPanel} onClose={() => setShowSecurityPanel(false)} />
    </div>
  )
}
```

- [ ] **Step 3: Manually verify**

Run both dev servers, log in, hover the sidebar's user-info row, click the new fingerprint icon. Expected: the Security panel opens, shows "No devices set up yet." (for a fresh user) and a "Set up Face ID / Fingerprint on this device" button (or the "doesn't support" message on a non-biometric machine). Clicking the X or the backdrop closes it.

- [ ] **Step 4: Commit**

```bash
cd Frontend
git add src/components/SecurityPanel.jsx src/components/Layout.jsx
git commit -m "Add Security panel for managing registered Face ID / Fingerprint devices

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end verification with a virtual authenticator

**Repo:** both (verification only — no new files committed to either repo)

**Files:** none created or modified.

**Interfaces:** consumes the full stack built in Tasks 1-9.

This is the real proof that the whole feature works, using a genuine (virtual) WebAuthn authenticator rather than a mock — the same standard of proof this project has already used for its highest-stakes prior security fix (the Scheduler OAuth-token-leak fix, verified via a live Playwright click-through against production). Perform this with the Playwright browser tool, not a checked-in script — this repo has no Playwright devDependency and none should be added for a one-time verification (Global Constraints).

- [ ] **Step 1: Create one synthetic test user**

With both `Backend` (`npm run dev`, port 4000) and `Frontend` (`npm run dev`, port 5173) running, log in as an existing admin and create a throwaway user:

```bash
ADMIN_TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login -H "Content-Type: application/json" -d '{"email":"<a real admin email>","password":"<their real password>"}' | node -e "process.stdin.once('data', d => console.log(JSON.parse(d).token))")

curl -s -X POST http://localhost:4000/api/users -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"webauthn-e2e-test@aimdentallab.com","password":"TempTestPass123!","name":"WebAuthn E2E Test","role":"staff"}'
```

Note the returned `id` — needed for cleanup in Step 4.

- [ ] **Step 2: Drive the browser with a CDP virtual authenticator**

Using the Playwright browser tool's code-execution capability against a page navigated to `http://localhost:5173/login`, run:

```js
const client = await page.context().newCDPSession(page);
await client.send('WebAuthn.enable');
await client.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});

// 1. Password login with the synthetic test user.
await page.goto('http://localhost:5173/login');
await page.fill('input[type="email"]', 'webauthn-e2e-test@aimdentallab.com');
await page.fill('input[type="password"]', 'TempTestPass123!');
await page.click('button[type="submit"]');

// 2. The exact-wording one-time prompt must appear, and "Yes" must
//    register a real credential via the virtual authenticator.
await page.waitForSelector('text=Use Face ID / Fingerprint for faster sign-in?');
await page.click('text=Yes');
await page.waitForURL('**/dashboard');

// 3. Sign out, then confirm the biometric button appears and logs in
//    with NO password typed at all.
await page.click('text=Sign out');
await page.waitForURL('**/login');
await page.waitForSelector('text=Sign in with Face ID / Fingerprint');
await page.click('text=Sign in with Face ID / Fingerprint');
await page.waitForURL('**/dashboard');

console.log('WebAuthn E2E registration + biometric login: PASSED');
```

Expected: both `waitForURL('**/dashboard')` calls resolve, and the console log prints. This proves the full real cryptographic round trip (Backend's `verifyRegistrationResponse`/`verifyAuthenticationResponse` against the Frontend's actual `startRegistration`/`startAuthentication` calls) — not a mock of either side.

- [ ] **Step 3: Verify device removal disables biometric login (Review Focus item 1's flip side + general sanity)**

Continuing in the same authenticated session, open the Security panel (click the sidebar's fingerprint icon), remove the one listed device, sign out, and confirm the "Sign in with Face ID / Fingerprint" button no longer appears on `/login` (only the password form does):

```js
// Assumes still on /dashboard from Step 2.
await page.hover('text=WebAuthn E2E Test'); // reveals the sidebar's icon row
await page.click('[title="Face ID / Fingerprint sign-in"]');
await page.click('[title="Remove this device"]');
await page.click('text=Sign out');
await page.waitForURL('**/login');
const bioButtonGone = await page.locator('text=Sign in with Face ID / Fingerprint').count();
console.log(bioButtonGone === 0 ? 'Device removal correctly hides biometric button: PASSED' : 'FAILED — button still present after removal');
```

- [ ] **Step 4: Clean up the synthetic test user**

Per the standing project rule against leaving synthetic test data behind:

```bash
curl -s -X DELETE http://localhost:4000/api/users/<the id noted in Step 1> -H "Authorization: Bearer $ADMIN_TOKEN"
```

Also confirm no `webauthn_credentials` row for that user remains (Step 3 already removed it via the app itself, but double-check):

```sql
-- In the Supabase SQL editor:
SELECT * FROM webauthn_credentials WHERE user_id = '<the id noted in Step 1>';
-- Expected: 0 rows.
```

- [ ] **Step 5: Report the result**

No commit for this task (nothing to check in). Report to whoever is tracking this plan's execution: both PASSED lines from Steps 2-3, or the exact point of failure if either did not pass.
