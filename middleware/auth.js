import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Middleware: verify JWT from httpOnly cookie and attach user to req.
 * Does NOT block unauthenticated requests — use requireAuth for that.
 */
export async function attachUser(req, res, next) {
  try {
    const token = req.cookies?.token;
    if (!token) {
      req.user = null;
      return next();
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');
    req.user = user || null;
    next();
  } catch {
    req.user = null;
    next();
  }
}

/**
 * Middleware: require authenticated user.
 * Blocks with 401 if no valid JWT cookie.
 */
export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.token;
    if (!token) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');
    if (!user) {
      return res.status(401).json({ error: 'المستخدم غير موجود' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'جلسة منتهية. يرجى تسجيل الدخول مرة أخرى.' });
    }
    next(err);
  }
}

/**
 * Middleware: require owner role.
 * Must be used AFTER requireAuth. API routes get a JSON 403 (a redirect
 * would be silently followed by fetch/axios clients); pages redirect home.
 */
export function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'owner') {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'صلاحيات المالك مطلوبة' });
    }
    return res.redirect('/');
  }
  next();
}

/**
 * Generate a signed JWT for a user.
 */
export function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Set the JWT as an httpOnly, secure cookie on the response.
 */
export function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
}

/**
 * Clear the auth cookie (for logout).
 */
export function clearAuthCookie(res) {
  res.cookie('token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 0
  });
}
