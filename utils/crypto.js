// Field-level encryption for sensitive data stored in MongoDB.
//
// Two primitives:
// 1. encryptField / decryptField — AES-256-GCM (random IV, authenticated).
//    Use for data we must read back later: names, addresses, carts, orders.
// 2. hashPhone — deterministic keyed hash (HMAC-SHA256).
//    Use for data we must SEARCH by: the phone number. Same input always
//    produces the same hash, so lookups and unique indexes still work while
//    the plaintext number never touches the database.
//
// The key lives in .env (ENCRYPTION_KEY). It must never be committed.

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended size for GCM

let warnedAboutKey = false;

/**
 * Get the 32-byte key derived from ENCRYPTION_KEY.
 * Accepts any passphrase length — SHA-256 normalizes it to 32 bytes.
 * Returns null when the key is missing (callers fall back to plaintext
 * with a warning instead of crashing the whole app).
 */
function getKey() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    if (!warnedAboutKey) {
      warnedAboutKey = true;
      console.error(
        'WARNING: ENCRYPTION_KEY is not set in .env — user data will be stored UNENCRYPTED until a key is added.'
      );
    }
    return null;
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a string → "iv:tag:ciphertext" (all hex). Returns '' for empty input.
 */
export function encryptField(plainText) {
  if (plainText === undefined || plainText === null || plainText === '') return '';

  const key = getKey();
  if (!key) return String(plainText); // no key — store plaintext (dev fallback)

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  let encrypted = cipher.update(String(plainText), 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an "iv:tag:ciphertext" string back to plaintext.
 * Returns '' for empty input and null for anything that fails to decrypt
 * (e.g. data written before encryption was enabled).
 */
export function decryptField(cipherText) {
  if (!cipherText || typeof cipherText !== 'string') return '';

  // Not encrypted (stored as plaintext when the key was missing) — return as-is
  if (!cipherText.includes(':')) return cipherText;

  const parts = cipherText.split(':');
  if (parts.length !== 3) return null; // not an encrypted value

  try {
    const [ivHex, tagHex, dataHex] = parts;
    if (!getKey()) return cipherText; // no key — nothing to decrypt with

    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      getKey(),
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

    let decrypted = decipher.update(dataHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null; // wrong key or corrupted data
  }
}

/**
 * Deterministic keyed hash for searchable fields (phone numbers).
 * Same input + same key → same output, so findOne({ phone: hashPhone(x) }) works.
 */
export function hashPhone(phone) {
  const key = getKey();
  if (!key) {
    // No key — fall back to the raw number so lookups still work (dev fallback)
    return String(phone).trim();
  }
  return crypto
    .createHmac('sha256', key)
    .update(String(phone).trim())
    .digest('hex');
}

/**
 * Encrypt an object (cart items, order items) into a single cipher string.
 */
export function encryptJSON(object) {
  if (!getKey()) return JSON.stringify(object); // no key — plaintext fallback
  return encryptField(JSON.stringify(object));
}

/**
 * Decrypt a cipher string produced by encryptJSON back into an object.
 * Returns the fallback value (default []) when decryption fails.
 */
export function decryptJSON(cipherText, fallback = []) {
  if (!cipherText) return fallback;
  const plain = decryptField(cipherText);
  if (!plain) return fallback;
  try {
    return JSON.parse(plain);
  } catch {
    return fallback;
  }
}
