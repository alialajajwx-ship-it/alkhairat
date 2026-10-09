import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import User from '../models/User.js';
import OTP from '../models/OTP.js';
import { hashPhone } from '../utils/crypto.js';
import { sendOTP } from '../utils/sms.js';
import { generateToken, setAuthCookie } from '../middleware/auth.js';
import { smsLimiter, loginLimiter, isDeviceBlocked } from '../middleware/security.js';

const router = Router();

/**
 * Convert Arabic-Indic digits (٠-٩ ۰-۹) to Latin digits (0-9) so phone
 * numbers and OTP codes typed with an Arabic keyboard validate correctly.
 */
function normalizeDigits(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

/**
 * Is this error the database being unreachable/slow rather than a bad request?
 * Those two must never be answered the same way — "the database is down" is
 * not "you are not logged in".
 */
function isDatabaseError(err) {
  const name = err?.name || '';
  return (
    name === 'MongooseError' ||
    name === 'MongoNetworkError' ||
    name === 'MongoServerSelectionError' ||
    name === 'MongoTimeoutError' ||
    /buffering timed out|before initial connection|connection.*(closed|refused)/i.test(err?.message || '')
  );
}

/** sanitizer: normalize digits then keep only Latin digits (phones) */
function digitsOnly(value) {
  if (typeof value !== 'string') return ''; // missing field -> empty, validation handles it
  return normalizeDigits(value).replace(/[^0-9]/g, '');
}

/**
 * Find a user by phone number. Since phones are stored encrypted, we look up
 * by the deterministic phoneHash. Falls back to the old plaintext field for
 * accounts created before encryption was enabled.
 */
async function findUserByPhone(phone) {
  const byHash = await User.findOne({ phoneHash: hashPhone(phone) });
  if (byHash) return byHash;

  const legacy = await User.findOne({ phone }); // old plaintext record
  if (legacy) {
    // Migrate to the encrypted format on first touch
    legacy.setPhone(phone);
    await legacy.save();
    console.log(`Migrated user ${legacy._id} phone to encrypted format`);
  }
  return legacy || null;
}

// ─── POST /api/register ──────────────────────────────────────
// Step 1: Validate input, generate OTP, send SMS
router.post(
  '/register',
  smsLimiter,
  [
    body('name')
      .trim()
      .isLength({ min: 2, max: 60 })
      .withMessage('الاسم يجب أن يكون حرفين على الأقل'),
    body('phone')
      .customSanitizer(digitsOnly)
      .matches(/^05\d{8}$/)
      .withMessage('رقم الهاتف غير صحيح'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
    body('confirmPassword')
      .custom((value, { req }) => value === req.body.password)
      .withMessage('كلمتا المرور غير متطابقتين'),
    body('termsAccepted')
      .equals('true')
      .withMessage('يجب الموافقة على الشروط والأحكام'),
    body('privacyAccepted')
      .equals('true')
      .withMessage('يجب الموافقة على سياسة الخصوصية'),
    body('deviceFingerprint')
      .optional()
      .isString()
      .withMessage('Device fingerprint must be a string')
  ],
  async (req, res) => {
    try {
      // Validate input
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { name, phone, password, deviceFingerprint } = req.body;

      // Check device fingerprint blocking
      if (isDeviceBlocked(deviceFingerprint)) {
        return res.status(429).json({
          error: 'تم حظر هذا الجهاز. يرجى المحاولة لاحقاً.'
        });
      }

      // Check if phone already registered
      const existingUser = await findUserByPhone(phone);
      if (existingUser) {
        return res.status(409).json({
          error: 'رقم الهاتف مسجل بالفعل. سجل دخولك بدلاً من ذلك.'
        });
      }

      // If a valid OTP already exists for this phone, do not send another one.
      // The user must wait until it expires (or change their phone number).
      const activeOtp = await OTP.findOne({
        phoneHash: hashPhone(phone),
        purpose: 'register',
        expiresAt: { $gt: new Date() }
      });
      if (activeOtp) {
        const minutesLeft = Math.ceil(
          (activeOtp.expiresAt.getTime() - Date.now()) / (60 * 1000)
        );
        return res.status(429).json({
          error: `تم إرسال كود تحقق لهذا الرقم بالفعل. يمكنك طلب كود جديد بعد ${minutesLeft} دقيقة.`,
          codePending: true,
          minutesLeft
        });
      }

      // Generate 6-digit OTP
      const otpCode = crypto.randomInt(100000, 999999).toString();

      // Delete any existing REGISTER-purpose OTPs for this phone
      // (a pending reset code for the same number is left untouched)
      await OTP.deleteMany({ phoneHash: hashPhone(phone), purpose: 'register' });

      // Save hashed OTP with 15-minute expiration
      const salt = await bcrypt.genSalt(10);
      const hashedOtp = await bcrypt.hash(otpCode, salt);
      const otpDoc = new OTP({
        purpose: 'register',
        code: hashedOtp,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000)
      });
      otpDoc.setPhone(phone);
      await otpDoc.save();

      // Store registration data temporarily in a server-side map (we'll need
      // it in verify). Short-lived in-memory map keyed by phone hash.
      if (!global.__pendingRegistrations) global.__pendingRegistrations = new Map();
      global.__pendingRegistrations.set(hashPhone(phone), {
        name,
        password,
        deviceFingerprint,
        timestamp: Date.now()
      });

      // Auto-cleanup after 15 minutes
      setTimeout(() => {
        global.__pendingRegistrations?.delete(hashPhone(phone));
      }, 15 * 60 * 1000);

      // Send OTP via SMS
      const smsResult = await sendOTP(phone, otpCode);
      if (!smsResult.success) {
        // Still return success to the client to not reveal SMS infrastructure issues
        // In production, you'd log this and have a retry mechanism
      }

      res.status(200).json({
        message: 'تم إرسال كود التحقق إلى هاتفك.'
      });
    } catch (err) {
      console.error('Register error:', err.message);
      res.status(500).json({ error: 'حدث خطأ أثناء التسجيل.' });
    }
  }
);

// ─── POST /api/verify ────────────────────────────────────────
// Step 2: Verify OTP, create user, issue JWT
router.post(
  '/verify',
  [
    body('phone')
      .customSanitizer(digitsOnly)
      .matches(/^05\d{8}$/)
      .withMessage('رقم الهاتف غير صحيح'),
    body('code')
      .customSanitizer(digitsOnly)
      .isLength({ min: 6, max: 6 })
      .isNumeric()
      .withMessage('كود التحقق يجب أن يكون 6 أرقام')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { phone, code } = req.body;
      const phoneKey = hashPhone(phone);

      // Find the OTP document — must be a REGISTER-purpose code
      const otpDoc = await OTP.findOne({
        phoneHash: phoneKey,
        purpose: 'register',
        expiresAt: { $gt: new Date() }
      });

      if (!otpDoc) {
        return res.status(400).json({
          error: 'كود التحقق منتهي الصلاحية أو غير موجود.'
        });
      }

      // Check attempt limit
      if (otpDoc.attempts >= 5) {
        await OTP.deleteMany({ phoneHash: phoneKey, purpose: 'register' });
        return res.status(429).json({
          error: 'تم تجاوز الحد المسموح من المحاولات.'
        });
      }

      // Compare OTP
      const isMatch = await otpDoc.compareCode(code);
      if (!isMatch) {
        otpDoc.attempts += 1;
        await otpDoc.save();
        return res.status(400).json({
          error: 'كود التحقق غير صحيح.',
          attemptsLeft: 5 - otpDoc.attempts
        });
      }

      // OTP verified — get pending registration data
      const pendingData = global.__pendingRegistrations?.get(phoneKey);
      if (!pendingData) {
        return res.status(400).json({
          error: 'انتهت صلاحية التسجيل. يرجى إعادة المحاولة.'
        });
      }

      // Create the user — the phone is encrypted, the name is whatever the
      // user picked (duplicates allowed on purpose)
      const user = new User({
        name: pendingData.name,
        password: pendingData.password,
        termsAccepted: true
      });
      user.setPhone(phone);
      await user.hashPassword();
      await user.save();

      // Delete the OTP
      await OTP.deleteMany({ phoneHash: phoneKey, purpose: 'register' });

      // Clean up pending registration
      global.__pendingRegistrations?.delete(phoneKey);

      // Generate JWT and set cookie
      const token = generateToken(user._id);
      setAuthCookie(res, token);

      res.status(201).json({
        message: 'تم التسجيل بنجاح!',
        user: user.toJSON()
      });
    } catch (err) {
      console.error('Verify error:', err.message);
      res.status(500).json({ error: 'حدث خطأ أثناء التحقق.' });
    }
  }
);

// ─── POST /api/login ─────────────────────────────────────────
// Login with phone + password (for returning users)
router.post(
  '/login',
  loginLimiter,
  [
    body('phone')
      .customSanitizer(digitsOnly)
      .matches(/^05\d{8}$/)
      .withMessage('رقم الهاتف غير صحيح'),
    body('password')
      .notEmpty()
      .withMessage('كلمة المرور مطلوبة')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { phone, password } = req.body;

      const user = await findUserByPhone(phone);
      if (!user) {
        return res.status(401).json({
          error: 'رقم الهاتف أو كلمة المرور غير صحيحة.'
        });
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(401).json({
          error: 'رقم الهاتف أو كلمة المرور غير صحيحة.'
        });
      }

      const token = generateToken(user._id);
      setAuthCookie(res, token);

      res.status(200).json({
        message: 'تم تسجيل الدخول بنجاح!',
        user: user.toJSON()
      });
    } catch (err) {
      console.error('Login error:', err.message);
      res.status(500).json({ error: 'حدث خطأ أثناء تسجيل الدخول.' });
    }
  }
);

// ─── POST /api/forgot-password ──────────────────────────────
// Step 1 of the password reset: send a reset code by SMS.
// The response is identical whether or not the phone is registered so
// attackers can't discover which numbers have accounts.
router.post(
  '/forgot-password',
  smsLimiter,
  [
    body('phone')
      .customSanitizer(digitsOnly)
      .matches(/^05\d{8}$/)
      .withMessage('رقم الهاتف غير صحيح')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { phone, deviceFingerprint } = req.body;

      // Check device fingerprint blocking
      if (isDeviceBlocked(deviceFingerprint)) {
        return res.status(429).json({
          error: 'تم حظر هذا الجهاز. يرجى المحاولة لاحقاً.'
        });
      }

      const phoneKey = hashPhone(phone);

      // Do not send a new code while a valid one is already pending —
      // same rule as registration
      const activeOtp = await OTP.findOne({
        phoneHash: phoneKey,
        purpose: 'reset',
        expiresAt: { $gt: new Date() }
      });
      if (activeOtp) {
        const minutesLeft = Math.ceil(
          (activeOtp.expiresAt.getTime() - Date.now()) / (60 * 1000)
        );
        return res.status(429).json({
          error: `تم إرسال كود تحقق لهذا الرقم بالفعل. يمكنك طلب كود جديد بعد ${minutesLeft} دقيقة.`,
          codePending: true,
          minutesLeft
        });
      }

      // Generate + save the reset code
      const otpCode = crypto.randomInt(100000, 999999).toString();
      await OTP.deleteMany({ phoneHash: phoneKey, purpose: 'reset' });

      const salt = await bcrypt.genSalt(10);
      const hashedOtp = await bcrypt.hash(otpCode, salt);
      const otpDoc = new OTP({
        purpose: 'reset',
        code: hashedOtp,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000)
      });
      otpDoc.setPhone(phone);
      await otpDoc.save();

      // Always answer the same way, registered or not
      res.status(200).json({
        message: 'إذا كان هذا الرقم مسجلاً، ستصلك رسالة نصية تحتوي على كود التحقق.'
      });

      // Send the SMS after responding (the response never depends on it)
      const user = await findUserByPhone(phone);
      if (user) {
        await sendOTP(phone, otpCode);
      }
    } catch (err) {
      console.error('Forgot password error:', err.message);
      res.status(500).json({ error: 'حدث خطأ. حاول مرة أخرى.' });
    }
  }
);

// ─── POST /api/reset-password/verify-code ──────────────────
// Step 2 of the password reset: check the code WITHOUT changing anything.
// Lets the frontend show the "new password" form only after the code is
// proven correct (the final call re-checks the same single-use code).
router.post(
  '/reset-password/verify-code',
  [
    body('phone')
      .customSanitizer(digitsOnly)
      .matches(/^05\d{8}$/)
      .withMessage('رقم الهاتف غير صحيح'),
    body('code')
      .customSanitizer(digitsOnly)
      .isLength({ min: 6, max: 6 })
      .isNumeric()
      .withMessage('كود التحقق يجب أن يكون 6 أرقام')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { phone, code } = req.body;
      const phoneKey = hashPhone(phone);

      const otpDoc = await OTP.findOne({
        phoneHash: phoneKey,
        purpose: 'reset',
        expiresAt: { $gt: new Date() }
      });

      if (!otpDoc) {
        return res.status(400).json({
          error: 'كود التحقق منتهي الصلاحية أو غير موجود.'
        });
      }

      if (otpDoc.attempts >= 5) {
        await OTP.deleteMany({ phoneHash: phoneKey, purpose: 'reset' });
        return res.status(429).json({
          error: 'تم تجاوز الحد المسموح من المحاولات.'
        });
      }

      const isMatch = await otpDoc.compareCode(code);
      if (!isMatch) {
        otpDoc.attempts += 1;
        await otpDoc.save();
        return res.status(400).json({
          error: 'كود التحقق غير صحيح.',
          attemptsLeft: 5 - otpDoc.attempts
        });
      }

      res.json({ verified: true });
    } catch (err) {
      console.error('Verify reset code error:', err.message);
      res.status(500).json({ error: 'حدث خطأ. حاول مرة أخرى.' });
    }
  }
);

// ─── POST /api/reset-password ───────────────────────────────
// Step 3: verify the reset code again and set the new password.
// A successful reset logs the user in (fresh session after a password change).
router.post(
  '/reset-password',
  [
    body('phone')
      .customSanitizer(digitsOnly)
      .matches(/^05\d{8}$/)
      .withMessage('رقم الهاتف غير صحيح'),
    body('code')
      .customSanitizer(digitsOnly)
      .isLength({ min: 6, max: 6 })
      .isNumeric()
      .withMessage('كود التحقق يجب أن يكون 6 أرقام'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { phone, code, password } = req.body;
      const phoneKey = hashPhone(phone);

      // Find the reset OTP
      const otpDoc = await OTP.findOne({
        phoneHash: phoneKey,
        purpose: 'reset',
        expiresAt: { $gt: new Date() }
      });

      if (!otpDoc) {
        return res.status(400).json({
          error: 'كود التحقق منتهي الصلاحية أو غير موجود.'
        });
      }

      // Check attempt limit
      if (otpDoc.attempts >= 5) {
        await OTP.deleteMany({ phoneHash: phoneKey, purpose: 'reset' });
        return res.status(429).json({
          error: 'تم تجاوز الحد المسموح من المحاولات.'
        });
      }

      // Compare the code
      const isMatch = await otpDoc.compareCode(code);
      if (!isMatch) {
        otpDoc.attempts += 1;
        await otpDoc.save();
        return res.status(400).json({
          error: 'كود التحقق غير صحيح.',
          attemptsLeft: 5 - otpDoc.attempts
        });
      }

      // Code is correct — find the user and set the new password
      const user = await findUserByPhone(phone);
      if (!user) {
        return res.status(400).json({
          error: 'لا يوجد حساب بهذا الرقم.'
        });
      }

      user.password = password;
      await user.hashPassword();
      await user.save();

      // Single-use: burn the reset code after a successful reset
      await OTP.deleteMany({ phoneHash: phoneKey, purpose: 'reset' });
      // Also cancel any pending REGISTER code for this phone — a stale
      // registration must not complete now that the account exists
      await OTP.deleteMany({ phoneHash: phoneKey, purpose: 'register' });
      global.__pendingRegistrations?.delete(phoneKey);

      // Generate JWT and set cookie (auto-login after reset)
      const token = generateToken(user._id);
      setAuthCookie(res, token);

      res.status(200).json({
        message: 'تم تغيير كلمة المرور بنجاح!',
        user: user.toJSON()
      });
    } catch (err) {
      console.error('Reset password error:', err.message);
      res.status(500).json({ error: 'حدث خطأ أثناء تغيير كلمة المرور.' });
    }
  }
);

// ─── POST /api/change-password ──────────────────────────────
// Change the password while logged in: verify the current password first.
// No SMS needed — the session already proves who the user is.
router.post(
  '/change-password',
  [
    body('currentPassword').notEmpty().withMessage('كلمة المرور الحالية مطلوبة'),
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل')
  ],
  async (req, res) => {
    try {
      // The JWT cookie is verified here directly to keep this route
      // self-contained (same pattern as /api/me below)
      const token = req.cookies?.token;
      if (!token) {
        return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const jwt = await import('jsonwebtoken');
      let userId;
      try {
        ({ userId } = jwt.default.verify(token, process.env.JWT_SECRET));
      } catch {
        return res.status(401).json({ error: 'جلسة منتهية. يرجى تسجيل الدخول مرة أخرى.' });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(401).json({ error: 'المستخدم غير موجود' });
      }

      const { currentPassword, newPassword } = req.body;

      const isMatch = await user.comparePassword(currentPassword);
      if (!isMatch) {
        return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة.' });
      }

      user.password = newPassword;
      await user.hashPassword();
      await user.save();

      res.json({ message: 'تم تغيير كلمة المرور بنجاح!' });
    } catch (err) {
      console.error('Change password error:', err.message);
      res.status(500).json({ error: 'حدث خطأ أثناء تغيير كلمة المرور.' });
    }
  }
);

// ─── POST /api/logout ────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.cookie('token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 0
  });
  res.status(200).json({ message: 'تم تسجيل الخروج.' });
});

// ─── GET /api/me ─────────────────────────────────────────────
// Get current user info. Returns 200 with { user: null } for guests
// so the browser console stays clean (no 401 noise on every page).
router.get('/me', async (req, res) => {
  try {
    const token = req.cookies?.token;
    if (!token) {
      return res.json({ user: null });
    }

    const jwt = await import('jsonwebtoken');
    const decoded = jwt.default.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.json({ user: null });
    }

    res.json({ user: user.toJSON() });
  } catch (err) {
    // The database is down/slow — answer 503 so the frontend can tell its
    // logged-in visitors apart from guests instead of bouncing them to /login.
    if (isDatabaseError(err)) {
      return res.status(503).json({ error: 'الخدمة غير متاحة مؤقتاً. حاول مرة اخرى.' });
    }
    res.json({ user: null });
  }
});

export default router;
