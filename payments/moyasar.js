import axios from 'axios';
import crypto from 'crypto';

// ─── Moyasar payment integration ─────────────────────────────
// Authorization & Capture flow: the customer's money is HELD on their card
// when the payment is created (status: authorized) and only actually moves
// to the store account when the owner accepts the order (capture).
//
// MOCK MODE: active whenever MOYASAR_SECRET_KEY is missing, empty, or set
// to 'mock'. No real network calls happen — everything is simulated in the
// terminal so the whole flow can be developed and tested for free.

const MOYASAR_API_BASE = 'https://api.moyasar.com/v1';

// ─── Mock-mode card helpers ──────────────────────────────────
// Make the simulated gateway behave like a real one: same validation
// (Luhn check), same card-brand detection, same test-card convention.

/**
 * Luhn checksum — the exact validity test real gateways run on card numbers.
 * @param {string} digits - card number, digits only
 */
export function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length >= 12 && sum % 10 === 0;
}

/**
 * Detect the card brand from the number prefix, like the real Moyasar form.
 * @param {string} digits
 * @returns {'mada'|'visa'|'mastercard'|'unknown'}
 */
export function cardBrand(digits) {
  if (/^4/.test(digits)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'mastercard';
  // mada BINs cover several Saudi ranges — the common ones:
  if (/^(4[0-9]{5}|5[0-9]{5}|9682|508160|588845|440647)/.test(digits)) return 'mada';
  return 'unknown';
}

/**
 * Mask a card number for logs: first 4 + last 4 only (PCI-style).
 * @param {string} digits
 */
export function maskCard(digits) {
  if (!digits || digits.length < 8) return '****';
  return digits.slice(0, 4) + ' **** **** ' + digits.slice(-4);
}

/**
 * Is mock payment mode active?
 * True when MOYASAR_SECRET_KEY is missing, empty, or literally 'mock'.
 */
export function isMockMode() {
  const key = process.env.MOYASAR_SECRET_KEY;
  return !key || key.trim() === '' || key.trim().toLowerCase() === 'mock';
}

/**
 * The publishable key handed to the frontend Web SDK (real mode only).
 */
export function getPublishableKey() {
  return process.env.MOYASAR_PUBLISHABLE_KEY || '';
}

/**
 * The webhook secret registered in the Moyasar dashboard (real mode only).
 */
export function getWebhookSecret() {
  return process.env.MOYASAR_WEBHOOK_SECRET || '';
}

/**
 * Constant-time string comparison (prevents timing attacks on the webhook).
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a Moyasar webhook request.
 * Moyasar does NOT use a signature header — it includes a `secret_token`
 * field inside the JSON body, which must equal the webhook secret we set
 * when registering the endpoint.
 * @param {object} body - parsed webhook JSON body
 * @returns {boolean}
 */
export function verifyWebhookSecret(body) {
  const secret = getWebhookSecret();
  if (!secret) return false; // no secret configured → reject everything
  const provided = body?.secret_token;
  if (!provided) return false;
  return safeEqual(secret, provided);
}

/**
 * Void an authorized payment (release the hold on the customer's card).
 * Used when an order is cancelled BEFORE capture — the money was only held,
 * so voiding releases it without ever charging the customer.
 * @param {string} paymentId - Moyasar payment id
 * @returns {Promise<{ ok: boolean, status: string, raw: object }>}
 */
export async function voidPayment(paymentId) {
  const secretKey = process.env.MOYASAR_SECRET_KEY;
  if (!secretKey) {
    return { ok: false, status: 'error', raw: { message: 'Missing secret key' } };
  }

  try {
    const res = await axios.post(
      `${MOYASAR_API_BASE}/payments/${encodeURIComponent(paymentId)}/void`,
      {},
      {
        auth: { username: secretKey, password: '' },
        timeout: 30000
      }
    );
    // Voided payments report 'voided'
    return { ok: true, status: res.data?.status || 'voided', raw: res.data || {} };
  } catch (err) {
    const raw = err.response?.data || { message: err.message };
    console.error('Moyasar void failed:', raw.message || raw);
    return { ok: false, status: raw?.status || 'error', raw };
  }
}

/**
 * Capture an authorized payment (real mode only).
 * Moyasar capture endpoint, HTTP Basic auth with the SECRET key as the
 * username and an empty password.
 * @param {string} paymentId - Moyasar payment id
 * @param {number} amountSar - amount in SAR (must match the authorized amount)
 * @returns {Promise<{ ok: boolean, status: string, raw: object }>}
 */
export async function capturePayment(paymentId, amountSar) {
  const secretKey = process.env.MOYASAR_SECRET_KEY;
  if (!secretKey) {
    return { ok: false, status: 'error', raw: { message: 'Missing secret key' } };
  }

  try {
    const res = await axios.post(
      `${MOYASAR_API_BASE}/payments/${encodeURIComponent(paymentId)}/capture`,
      { amount: Math.round(amountSar * 100) }, // halalas
      {
        auth: { username: secretKey, password: '' },
        timeout: 30000
      }
    );
    // Moyasar returns the updated payment — captured payments report 'paid'
    return { ok: true, status: res.data?.status || 'paid', raw: res.data || {} };
  } catch (err) {
    const raw = err.response?.data || { message: err.message };
    console.error('Moyasar capture failed:', raw.message || raw);
    return { ok: false, status: raw?.status || 'error', raw };
  }
}

/**
 * Fetch a payment's current status directly from the Moyasar API.
 * Used as a webhook fallback on localhost (webhooks can't reach a local
 * server): the checkout polling endpoint calls this so the flow never
 * depends on the webhook being delivered.
 * @param {string} paymentId
 * @returns {Promise<{ ok: boolean, status?: string, id?: string, message?: string }>}
 */
export async function fetchPaymentStatus(paymentId) {
  const secretKey = process.env.MOYASAR_SECRET_KEY;
  if (!secretKey) {
    return { ok: false, message: 'Missing secret key' };
  }

  try {
    const res = await axios.get(
      `${MOYASAR_API_BASE}/payments/${encodeURIComponent(paymentId)}`,
      { auth: { username: secretKey, password: '' }, timeout: 15000 }
    );
    return { ok: true, status: res.data?.status, id: res.data?.id };
  } catch (err) {
    return { ok: false, message: err.response?.data?.message || err.message };
  }
}
