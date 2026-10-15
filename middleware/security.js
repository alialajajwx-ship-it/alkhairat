import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// ── General API rate limiter ─────────────────────────────────
// Only state-changing requests (POST/PUT/PATCH/DELETE) count against the
// limit. Read-only browsing - the product catalog, settings, and saved
// addresses - must never be throttled, otherwise a normal shopping session
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

// ── Chatbot abuse protection ─────────────────────────────────
//
// The store assistant has NO daily message quota - a signed-in customer may
// ask as many questions as they want for as long as they want. What it does
// keep is protection against someone spamming it: every chat message spends a
// real model call (bounded by TOTAL_BUDGET_MS in utils/ai-chat.js), so an
// uncontrolled flood would starve the provider and the event loop for every
// other customer.
//
// Two independent guards, keyed per customer (falling back to per IP):
//   1. chatLimiter     - a burst window. A human conversation never comes
//                        close to CHAT_BURST_MAX messages a minute, but a
//                        script firing requests as fast as it can is cut off.
//   2. chatBusyGuard   - a cap on how many model turns may be in flight at
//                        once, in total and per customer. Parallel floods get
//                        a fast 429 instead of piling up.
export const CHAT_BURST_WINDOW_MS = 60 * 1000;
export const CHAT_BURST_MAX = 15;              // messages per minute per customer
export const CHAT_MAX_IN_FLIGHT = 4;           // concurrent model turns, all users
export const CHAT_MAX_IN_FLIGHT_PER_USER = 2;  // concurrent model turns, one user

function chatKey(req) {
  return req.user?._id ? `u:${req.user._id}` : `ip:${ipKeyGenerator(req.ip)}`;
}

export const chatLimiter = rateLimit({
  windowMs: CHAT_BURST_WINDOW_MS,
  max: CHAT_BURST_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: chatKey,
  handler: (req, res) => {
    res.status(429).json({
      error: 'أرسلت رسائل كثيرة خلال وقت قصير. انتظر قليلاً ثم أكمل الحديث مع المساعد.',
      retryAfter: Math.ceil(CHAT_BURST_WINDOW_MS / 1000)
    });
  }
});

let chatInFlight = 0;
const chatInFlightByUser = new Map();

/** How many assistant turns are being generated right now (tests/diagnostics). */
export function chatInFlightCount() {
  return chatInFlight;
}

/**
 * Middleware: hold the request until the answer is sent, and refuse it while
 * too many other answers are still being generated.
 */
export function chatBusyGuard(req, res, next) {
  const key = String(chatKey(req));
  const userInFlight = chatInFlightByUser.get(key) || 0;

  if (chatInFlight >= CHAT_MAX_IN_FLIGHT || userInFlight >= CHAT_MAX_IN_FLIGHT_PER_USER) {
    return res.status(429).json({
      error: 'المساعد الآلي مشغول بالرد على طلبات كثيرة الآن. أعد المحاولة بعد لحظات.',
      busy: true,
      retryAfter: 3
    });
  }

  chatInFlight += 1;
  chatInFlightByUser.set(key, userInFlight + 1);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    chatInFlight = Math.max(0, chatInFlight - 1);
    const left = (chatInFlightByUser.get(key) || 1) - 1;
    if (left > 0) chatInFlightByUser.set(key, left);
    else chatInFlightByUser.delete(key);
  };

  res.on('finish', release);
  res.on('close', release);
  next();
}

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

// Cleanup expired entries every 10 minutes. The timer is unref'd so importing
// this module never keeps a process (the server, a test, a script) alive.
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of smsAttempts) {
    if (now - data.windowStart > SMS_WINDOW_MS) {
      smsAttempts.delete(key);
    }
  }
}, 10 * 60 * 1000).unref?.();

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
