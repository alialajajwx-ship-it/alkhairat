import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// ── General API rate limiter ─────────────────────────────────
// Only state-changing requests (POST/PUT/PATCH/DELETE) count against the
// limit. Read-only browsing — the product catalog, settings, and saved
// addresses — must never be throttled, otherwise a normal shopping session
// (which fires many GETs per page) starts returning 429 and breaks the UI.
// 300 mutations per 15 minutes per IP is generous for real use while still
// stopping abusive write floods.
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' || req.method === 'HEAD',
  message: { error: 'Too many requests, please try again later.' }
});

// ── Login brute-force rate limiter ───────────────────────────
// 10 failed login attempts per 15 minutes per IP
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تم تجاوز عدد محاولات الدخول المسموح بها. يرجى المحاولة لاحقاً.' }
});

// ── SMS request rate limiter ─────────────────────────────────
// 4 requests per 75 minutes (4,500,000 ms) per IP+device fingerprint

const SMS_WINDOW_MS = 75 * 60 * 1000; // 4,500,000 ms
const SMS_MAX = 4;

const smsAttempts = new Map(); // key -> { attempts, windowStart }

// Cleanup expired entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of smsAttempts) {
    if (now - data.windowStart > SMS_WINDOW_MS) {
      smsAttempts.delete(key);
    }
  }
}, 10 * 60 * 1000);

export const smsLimiter = rateLimit({
  windowMs: SMS_WINDOW_MS,
  max: SMS_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // ipKeyGenerator normalizes IPv6 addresses so users can't bypass limits
    const ip = ipKeyGenerator(req.ip);
    const fingerprint = req.body?.deviceFingerprint || 'no-fp';
    return `${ip}:${fingerprint}`;
  },
  handler: (req, res) => {
    const fingerprint = req.body?.deviceFingerprint || 'no-fp';

    // Track blocked devices
    const blockKey = `${ipKeyGenerator(req.ip)}:${fingerprint}`;
    const existing = smsAttempts.get(blockKey);
    if (existing) {
      existing.attempts += 1;
    } else {
      smsAttempts.set(blockKey, { attempts: 1, windowStart: Date.now() });
    }

    res.status(429).json({
      error: 'تم تجاوز الحد المسموح. يرجى المحاولة بعد 75 دقيقة.',
      retryAfter: Math.ceil(SMS_WINDOW_MS / 60000)
    });
  }
});

/**
 * Check if a device fingerprint has been blocked
 * (more than 4 SMS attempts within the 75-minute window across IPs)
 */
export function isDeviceBlocked(fingerprint) {
  if (!fingerprint) return false;
  const now = Date.now();
  let totalAttempts = 0;
  for (const [key, data] of smsAttempts) {
    if (key.includes(fingerprint) && (now - data.windowStart) < SMS_WINDOW_MS) {
      totalAttempts += data.attempts;
    }
  }
  return totalAttempts >= SMS_MAX;
}
