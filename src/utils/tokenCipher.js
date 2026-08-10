const crypto = require('crypto')

// Encrypts OAuth access/refresh tokens before they're stored in
// social_connections (see scripts/v10-social-connections-migration.sql).
// No prior "encrypt this before storing in Postgres" pattern exists
// anywhere in this backend — everything sensitive so far has either been
// hashed one-way (bcryptjs, passwords) or signed-not-encrypted
// (jsonwebtoken) — because nothing stored before this was itself a live
// credential capable of posting to a real external account on a lab's
// behalf. AES-256-GCM: a random 12-byte IV per call (never reused with
// the same key) plus the GCM auth tag, both stored alongside the
// ciphertext so decrypt() doesn't need anything beyond the one stored
// string and SOCIAL_TOKEN_ENCRYPTION_KEY.

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

function getKey() {
  const raw = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY
  if (!raw) throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY is not configured on this server')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (generate with `openssl rand -base64 32`)')
  }
  return key
}

// Returns a single string: base64(iv) + ':' + base64(authTag) + ':' + base64(ciphertext)
function encrypt(plaintext) {
  const key = getKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

function decrypt(payload) {
  const key = getKey()
  const [ivB64, authTagB64, ciphertextB64] = String(payload).split(':')
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Malformed encrypted payload')
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()])
  return plaintext.toString('utf8')
}

module.exports = { encrypt, decrypt }
