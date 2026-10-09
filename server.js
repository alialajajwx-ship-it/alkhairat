import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import mongoSanitize from 'express-mongo-sanitize';
import { body, validationResult } from 'express-validator';
import path from 'path';
import { fileURLToPath } from 'url';
import dayjs from 'dayjs';
import fs from 'fs';

import { connectDB } from './config/db.js';
import { apiLimiter } from './middleware/security.js';
import { attachUser, requireAuth, requireOwner } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import cartRoutes from './routes/cart.js';
import { sendWhatsAppNotification } from './utils/whatsapp.js';
import { sendSMS } from './utils/sms.js';
import {
  hasOrderProblem,
  computeReturnQuantities,
  applyReviewAvailability,
  markSoldOut,
  restoreSoldOut
} from './utils/order-review.js';
import {
  listProducts,
  listProductsByNames,
  listProductsByIds,
  productImageMap,
  listOwnerProducts,
  createProduct,
  updateProductById,
  setProductDeleted,
  mutateProducts,
  pruneCatalog,
  catalogCount,
  CATEGORY_TYPES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE
} from './utils/catalog.js';
import Order from './models/Order.js';
import Cart from './models/Cart.js';
import { isChatConfigured, configuredModels, chatWithTools } from './utils/ai-chat.js';
import { buildSystemPrompt, CHAT_TOOLS, createToolExecutor } from './utils/chatbot.js';
import { getChatUsage, recordChatMessage, CHAT_LIMIT } from './utils/chat-limit.js';
import {
  isMockMode,
  getPublishableKey,
  verifyWebhookSecret,
  capturePayment,
  voidPayment,
  fetchPaymentStatus,
  luhnValid,
  cardBrand,
  maskCard
} from './payments/moyasar.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Connect to MongoDB ──────────────────────────────────────
connectDB();

// ─── Utility functions ───────────────────────────────────────

// ─── Product catalog ─────────────────────────────────────────
//
// The catalog lives in the MongoDB `products` collection (models/Product.js)
// and is reached through utils/catalog.js. It used to be data/products.json,
// held in memory and rewritten WHOLE on every owner edit: fine for 29 items,
// but it loses concurrent edits and re-serializes the entire catalog on each
// change. Every catalog access is async and per document now.
//
// data/products.json stays as the SEED file only — `npm run seed:products`
// copies it into the collection (scripts/seed-products.mjs).

const CATALOG_SEED_NOTE =
  'The product catalog is empty. Run `npm run seed:products` or insert your ' +
  'products into the "products" collection, then reload.';

/**
 * Express-validator custom rule for an optional { lat, lng } payload.
 * Keeps only finite numbers within real coordinate ranges (rounded to
 * ~0.1m precision); anything else becomes null so nothing garbage is stored.
 */
function sanitizeCoordinates(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

// Store-wide settings (delivery fee) — data/settings.json
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

function readSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    settings.maintenanceMode = settings.maintenanceMode === true;
    return settings;
  } catch {
    return { deliveryFee: 7, maintenanceMode: false };
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

// Replacement review store — data/replacements.json. When the owner marks
// items as available / low-stock / unavailable for a specific order, the
// review is parked here so it survives the page navigation to the SMS page.
// Keyed by orderId. (Persisted on disk, NOT in the database.)
const REPLACEMENTS_FILE = path.join(__dirname, 'data', 'replacements.json');

function readReplacements() {
  try {
    return JSON.parse(fs.readFileSync(REPLACEMENTS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeReplacements(data) {
  fs.writeFileSync(REPLACEMENTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Home hero banners — data/banners.json holds every saved banner and the
// id of the one currently visible on the home page. The legacy single-
// banner file (data/banner.json) is migrated on first read.
const BANNERS_FILE = path.join(__dirname, 'data', 'banners.json');
const LEGACY_BANNER_FILE = path.join(__dirname, 'data', 'banner.json');

const DEFAULT_BANNER = {
  id: 'banner-default',
  imageUrl: '/images/banner-image.webp',
  title: 'توصيل مجاني لطلبك الأول من الموقع',
  subtitle: '',
  link: '',
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

function readBanners() {
  try {
    const data = JSON.parse(fs.readFileSync(BANNERS_FILE, 'utf-8'));
    let banners = Array.isArray(data.banners)
      ? data.banners.filter((b) => b && typeof b.id === 'string')
      : [];

    // Ensure default banner is always present
    const hasDefault = banners.some((b) => b.id === DEFAULT_BANNER.id || b.isDefault);
    if (!hasDefault) {
      banners.unshift({ ...DEFAULT_BANNER });
    } else {
      // Ensure it has the permanent flag
      banners = banners.map((b) => (b.id === DEFAULT_BANNER.id ? { ...DEFAULT_BANNER, ...b, isDefault: true } : b));
    }

    const activeId = typeof data.activeId === 'string' && banners.some((b) => b.id === data.activeId)
      ? data.activeId
      : DEFAULT_BANNER.id;

    return { activeId, banners };
  } catch {
    // First run: adopt the legacy banner (if any) so nothing the owner
    // saved before is lost
    let legacy = null;
    try {
      const old = JSON.parse(fs.readFileSync(LEGACY_BANNER_FILE, 'utf-8'));
      if (old && (old.imageUrl || old.title || old.subtitle)) {
        legacy = {
          id: 'banner-' + Date.now(),
          imageUrl: typeof old.imageUrl === 'string' ? old.imageUrl : '',
          title: typeof old.title === 'string' ? old.title : '',
          subtitle: typeof old.subtitle === 'string' ? old.subtitle : '',
          link: typeof old.link === 'string' ? old.link : '',
          createdAt: new Date().toISOString()
        };
      }
    } catch { /* no legacy file — start empty */ }
    const banners = [{ ...DEFAULT_BANNER }];
    if (legacy) banners.push(legacy);
    return { activeId: legacy ? legacy.id : DEFAULT_BANNER.id, banners };
  }
}

function writeBanners(data) {
  fs.writeFileSync(BANNERS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/** The banner currently visible on the home page (empty fields fall back
 *  to the defaults hard-coded in the home page markup) */
function readBanner() {
  const { activeId, banners } = readBanners();
  const active = banners.find((b) => b.id === activeId);
  const src = active || DEFAULT_BANNER;
  return {
    id: src.id,
    imageUrl: typeof src.imageUrl === 'string' ? src.imageUrl : DEFAULT_BANNER.imageUrl,
    title: typeof src.title === 'string' ? src.title : DEFAULT_BANNER.title,
    subtitle: typeof src.subtitle === 'string' ? src.subtitle : '',
    link: typeof src.link === 'string' ? src.link : ''
  };
}

// ─── Security Middleware ─────────────────────────────────────

// HTTP security headers
app.use(helmet({
  contentSecurityPolicy: false // Disable CSP for inline scripts/styles in EJS
}));

// Sanitize inputs against NoSQL injection
app.use(mongoSanitize());

// General API rate limiter
app.use('/api', apiLimiter);

// ─── Body Parsing & Cookies ──────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Attach user from JWT cookie to every request
app.use(attachUser);

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'public', 'views'));

// Make dayjs and user available to all views.
// The user is serialized through toJSON so views receive the DECRYPTED phone
// and never the raw ciphertext or password hash.
app.use((req, res, next) => {
  res.locals.dayjs = dayjs;
  res.locals.currentUser = req.user ? req.user.toJSON() : null;
  next();
});

// ─── Auth Routes ─────────────────────────────────────────────
app.use('/api', authRoutes);

// ─── Cart Routes (saved per user account) ────────────────────
app.use('/api/cart', cartRoutes);

// ─── Page routes ─────────────────────────────────────────────

app.get('/', (req, res) => {
  res.render('index', { banner: readBanner() });
});

app.get('/browse', (req, res) => {
  // Replacement mode — the owner arrived from a customer's order page to
  // mark items as available / low-stock / unavailable. Only the flagged
  // items are pre-selected ("المنتجات المقترحة" view) until عرض الكل is
  // clicked. Every value is length-capped before it reaches the template.
  const replacementMode = req.query.replacement === '1' && req.query.order;
  let replacementView = null;
  if (replacementMode) {
    const items = Array.isArray(req.query.item) ? req.query.item : [req.query.item];
    replacementView = {
      orderId: String(req.query.order).slice(0, 40),
      items: items.slice(0, 50).map((name) => String(name).slice(0, 100))
    };
  }
  res.render('browse', { replacementView, categories: CATEGORY_TYPES });
});

app.get('/checkout', (req, res) => {
  res.render('checkout');
});

app.get('/confirmed', (req, res) => {
  res.render('confirmed');
});

app.get('/orders', (req, res) => {
  res.render('orders');
});

app.get('/tracking', (req, res) => {
  res.render('tracking');
});

// Login / signup page
app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  // Render the requested form server-side (?mode=register / ?mode=forgot) so
  // the user lands on the right panel immediately instead of seeing the login
  // form flash first and the script switch it seconds later.
  const mode = ['register', 'forgot'].includes(req.query.mode) ? req.query.mode : 'login';
  res.render('login', { initialMode: mode });
});

// Terms and Privacy policy pages
app.get('/terms', (req, res) => {
  res.render('terms');
});

app.get('/privacy', (req, res) => {
  res.render('privacy');
});

// Owner — product management (alternatives) and deleted items pages
app.get('/alternatives', requireAuth, requireOwner, (req, res) => {
  res.render('alternatives', { categories: CATEGORY_TYPES });
});

// Owner — alternatives SMS page (after marking the order's availability).
// Requires the order query param; guests and non-owners are turned away.
app.get('/alternatives-sms', (req, res) => {
  if (!req.user) return res.redirect('/login?redirect=/alternatives-sms');
  if (req.user.role !== 'owner') return res.redirect('/');
  res.render('alternatives-sms');
});

app.get('/deleted-products', requireAuth, requireOwner, (req, res) => {
  res.render('deleted-products');
});

// Dashboard — owner only
app.get('/dashboard', requireAuth, requireOwner, (req, res) => {
  res.render('dashboard');
});

app.get('/customer-order', requireAuth, requireOwner, (req, res) => {
  res.render('costumer-order');
});

// Owner — home banner editor
app.get('/banner', requireAuth, requireOwner, (req, res) => {
  res.render('banner', { banners: readBanners() });
});

// Owner — delivery price editor
app.get('/delivery-price', requireAuth, requireOwner, (req, res) => {
  res.render('delivery-price', { deliveryFee: readSettings().deliveryFee });
});

// Account settings — logged-in users (guests go to the login page)
app.get('/settings', (req, res) => {
  if (!req.user) return res.redirect('/login?redirect=/settings');
  res.render('settings', { activePage: 'settings' });
});

// Owner settings — same account tabs + links to the owner tool pages.
// Guests go to the login page; logged-in non-owners go home.
app.get('/owner-settings', (req, res) => {
  if (!req.user) return res.redirect('/login?redirect=/owner-settings');
  if (req.user.role !== 'owner') return res.redirect('/');
  res.render('owner-settings', { activePage: 'settings' });
});

// ─── API: Home banners (owner writes, everyone reads) ────────

app.get('/api/banner', (req, res) => {
  res.json({ banner: readBanner() });
});

// Owner: every saved banner + which one is active
app.get('/api/owner/banners', requireAuth, requireOwner, (req, res) => {
  res.json(readBanners());
});

// Owner: add a NEW banner (existing banners are never overwritten).
// multipart/form-data so the owner can upload a hero image.
app.post('/api/owner/banner', requireAuth, requireOwner, (req, res) => {
  imageUpload.single('image')(req, res, (err) => {
    if (err) {
      const isType = err.message === 'INVALID_TYPE';
      return res.status(400).json({
        error: isType ? 'Only image files are allowed' : 'Image must be 5MB or smaller'
      });
    }
    try {
      const banner = {
        id: 'banner-' + Date.now(),
        imageUrl: req.file ? '/images/' + req.file.filename : '',
        title: String(req.body.title || '').trim().slice(0, 120),
        subtitle: String(req.body.subtitle || '').trim().slice(0, 200),
        link: String(req.body.link || '').trim().slice(0, 300),
        createdAt: new Date().toISOString()
      };

      const data = readBanners();
      data.banners.push(banner);
      // The first banner ever saved becomes visible immediately; afterwards
      // the owner picks the visible one explicitly
      if (!data.activeId) data.activeId = banner.id;
      writeBanners(data);

      res.status(201).json({ banner, activeId: data.activeId });
    } catch (err2) {
      console.error('Banner add error:', err2.message);
      res.status(500).json({ error: 'Failed to add banner' });
    }
  });
});

// Owner: choose which banner is visible on the home page
app.post('/api/owner/banner/active', requireAuth, requireOwner, (req, res) => {
  const id = typeof req.body.id === 'string' ? req.body.id : '';
  const data = readBanners();
  if (!data.banners.some((b) => b.id === id)) {
    return res.status(404).json({ error: 'Banner not found' });
  }
  data.activeId = id;
  writeBanners(data);
  res.json({ activeId: id, banner: readBanner() });
});

// Owner: delete a saved banner (the active one included — the home page
// then falls back to its defaults until another banner is activated)
app.delete('/api/owner/banner/:id', requireAuth, requireOwner, (req, res) => {
  if (req.params.id === DEFAULT_BANNER.id) {
    return res.status(400).json({ error: 'لا يمكن حذف البانر الافتراضي للمتجر' });
  }
  const data = readBanners();
  const before = data.banners.length;
  data.banners = data.banners.filter((b) => b.id !== req.params.id);
  if (data.banners.length === before) {
    return res.status(404).json({ error: 'Banner not found' });
  }
  if (data.activeId === req.params.id) data.activeId = DEFAULT_BANNER.id;
  writeBanners(data);
  res.json({ activeId: data.activeId });
});

// ─── API: Store settings (delivery price) ────────────────────

// Public: the frontend cart needs the current delivery fee
app.get('/api/settings', (req, res) => {
  const settings = readSettings();
  res.json({ deliveryFee: Number(settings.deliveryFee) || 0 });
});

// Public: store status so every page can disable ordering during maintenance
app.get('/api/store-status', (req, res) => {
  res.json({ maintenanceMode: readSettings().maintenanceMode === true });
});

// Owner toggles maintenance mode (pauses all ordering site-wide)
app.post('/api/owner/maintenance-mode', requireAuth, requireOwner, [
  body('maintenanceMode').isBoolean().withMessage('Invalid maintenance value')
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid maintenance value' });
  }
  try {
    const settings = readSettings();
    settings.maintenanceMode = req.body.maintenanceMode === true;
    writeSettings(settings);
    res.json({ maintenanceMode: settings.maintenanceMode });
  } catch (err) {
    console.error('Maintenance mode update error:', err.message);
    res.status(500).json({ error: 'Failed to update maintenance mode' });
  }
});

// Owner updates the delivery price
app.post('/api/owner/delivery-price', requireAuth, requireOwner, (req, res) => {
  try {
    const fee = Number(req.body.deliveryFee);
    if (!Number.isFinite(fee) || fee < 0 || fee > 999) {
      return res.status(400).json({ error: 'Invalid delivery fee' });
    }
    const settings = readSettings();
    settings.deliveryFee = Math.round(fee * 100) / 100;
    writeSettings(settings);
    res.json({ deliveryFee: settings.deliveryFee });
  } catch (err) {
    console.error('Delivery price update error:', err.message);
    res.status(500).json({ error: 'Failed to update delivery price' });
  }
});

// ─── API: My orders (logged-in customer, own orders only) ────

// Per-order image map, filled by loadOrderImages() just before the order is
// serialized. A WeakMap keyed by the order object keeps two concurrent
// requests from ever seeing each other's products (a module-level map would).
const orderImageMaps = new WeakMap();

/**
 * Look up (once, in a single query) the photos for every item of these orders
 * that does not already carry one. Best effort: a failure just means an older
 * order shows the placeholder icon, never a failed response.
 * @param {Array} orders - mongoose Order documents
 */
async function loadOrderImages(orders) {
  const list = (orders || []).filter(Boolean);
  if (!list.length) return;

  const ids = new Set();
  list.forEach((order) => {
    const items = typeof order.getItems === 'function' ? order.getItems() : [];
    (items || []).forEach((item) => {
      if (item && item.productId && !item.imageUrl) ids.add(item.productId);
    });
  });

  try {
    const map = ids.size ? await productImageMap([...ids]) : new Map();
    list.forEach((order) => orderImageMaps.set(order, map));
  } catch (err) {
    console.error('Order image fill error:', err.message);
  }
}

/**
 * Order JSON with a usable product image on every item.
 *
 * New orders already carry `imageUrl` (computeOrderAmounts copies it in), but
 * older ones do not — and exactly those orders are the ones whose product may
 * have left the customer catalog since (sold out → hidden for 24h, «غير
 * متوفر» review mark, deleted), which is when a lookup by product id fails.
 * The map from loadOrderImages() still CONTAINS hidden and deleted products,
 * so their photo can be filled back in. Best-effort: never fails a response.
 * @param {object} order - a mongoose Order document
 */
function orderJSONWithImages(order) {
  const json = typeof order.toJSON === 'function' ? order.toJSON() : order;

  try {
    if (!Array.isArray(json.items) || !json.items.length) return json;
    const byId = orderImageMaps.get(order) || new Map();
    json.items = json.items.map((item) => {
      if (!item || item.imageUrl) return item;
      const imageUrl = byId.get(item.productId);
      return imageUrl ? { ...item, imageUrl } : item;
    });
  } catch (err) {
    console.error('Order image fill error:', err.message);
  }

  return json;
}

// All of the logged-in user's orders, newest first
app.get('/api/my-orders', requireAuth, async (req, res) => {
  try {
    // Card orders are saved by /api/create-payment BEFORE the customer pays so
    // the amount can be priced server-side and a hold placed. Until that hold
    // is authorized they are not orders yet, so they stay out of the customer's
    // list. Attempts that were simply abandoned are removed for good.
    await dropAbandonedPayments({ userId: req.user._id });

    const orders = await Order.find({
      userId: req.user._id,
      paymentStatus: { $ne: 'pending_authorization' }
    }).sort({ orderTime: -1 });
    await loadOrderImages(orders);
    res.json({ orders: orders.map(orderJSONWithImages) });
  } catch (err) {
    console.error('My orders error:', err.message);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// Single own order by ID — powers the tracking page
app.get('/api/my-orders/:id', requireAuth, async (req, res) => {
  try {
    const order = await Order.findOne({
      orderId: req.params.id,
      userId: req.user._id
    });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    await loadOrderImages([order]);
    res.json({ order: orderJSONWithImages(order) });
  } catch (err) {
    console.error('My order error:', err.message);
    res.status(500).json({ error: 'Failed to load order' });
  }
});

// ─── API: Store chatbot ──────────────────────────────────────
//
// Logged-in customers only. Each user gets CHAT_LIMIT (40) messages in a
// rolling 24-hour window (utils/chat-limit.js). The model is never handed raw
// image bytes — it only ever receives the imageUrl strings out of the
// database — and it cannot touch the database directly: every catalog lookup
// goes through the tool executor in utils/chatbot.js.

/** Current usage + remaining allowance for the signed-in customer */
app.get('/api/chat/usage', requireAuth, async (req, res) => {
  try {
    const usage = await getChatUsage(req.user._id);
    res.json({
      limit: usage.limit,
      used: usage.used,
      remaining: usage.remaining,
      resetsAt: usage.resetsAt,
      configured: isChatConfigured()
    });
  } catch (err) {
    console.error('Chat usage error:', err.message);
    res.status(500).json({ error: 'Failed to load chat usage' });
  }
});

/**
 * Send a message to the store assistant.
 * Body: { message: string, page?: string, history?: [{role,content}] }
 *
 * The assistant answers in Arabic, knows which page the customer is on, and
 * may call tools to look up products, propose a cart addition, or remove an
 * item from the cart.
 */
app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim().slice(0, 1000);
    if (!message) return res.status(400).json({ error: 'الرسالة فارغة' });

    if (!isChatConfigured()) {
      return res.status(503).json({
        error: 'المساعد الآلي غير مُفعّل حالياً. تواصل مع المتجر.',
        notConfigured: true
      });
    }

    // Enforce the rolling limit BEFORE spending any tokens
    const usage = await getChatUsage(req.user._id);
    if (usage.remaining <= 0) {
      return res.status(429).json({
        error: 'وصلت الحد الأقصى للمساعد الآلي: 40 رسالة كل 24 ساعة. جرّب لاحقاً.',
        limit: CHAT_LIMIT,
        used: usage.used,
        remaining: 0,
        resetsAt: usage.resetsAt
      });
    }

    // Conversation history sent by the client, trimmed to the last few turns
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const trimmedHistory = history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-8)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));

    // Cart + recent orders give the assistant real context for its answers
    const cartDoc = await Cart.findOne({ userId: req.user._id });
    const cartItems = cartDoc ? cartDoc.getItems() : [];
    const cartProducts = await listProductsByIds(cartItems.map((i) => i.productId), { includeHidden: true });
    const cartById = new Map(cartProducts.map((p) => [p.id, p]));
    const cartContext = cartItems
      .map((i) => {
        const p = cartById.get(i.productId);
        return p ? { id: p.id, name: p.name, quantity: i.quantity } : null;
      })
      .filter(Boolean);

    let orderContext = [];
    try {
      await dropAbandonedPayments({ userId: req.user._id });
      const recentOrders = await Order.find({
        userId: req.user._id,
        paymentStatus: { $ne: 'pending_authorization' }
      }).sort({ orderTime: -1 }).limit(5);
      orderContext = recentOrders.map((o) => ({
        orderId: o.orderId,
        date: dayjs(o.orderTime).format('YYYY-MM-DD'),
        cancelled: o.cancelled === true,
        confirmed: o.confirmed === true,
        stage: o.status === 'delivered' ? 'تم التوصيل'
          : o.status === 'on_the_way' ? 'قيد التوصيل' : 'يتم التجهيز',
        itemCount: o.itemCount,
        total: Number(o.totalAmount || o.total || 0).toFixed(2)
      }));
    } catch {
      // Orders are context only — never block the answer on them
    }

    const events = { products: [], actions: [] };
    const messages = [
      {
        role: 'system',
        content: buildSystemPrompt({
          page: req.body?.page || '/',
          cart: cartContext,
          orders: orderContext,
          userName: req.user.name || ''
        })
      },
      ...trimmedHistory,
      { role: 'user', content: message }
    ];

    const result = await chatWithTools({
      messages,
      tools: CHAT_TOOLS,
      executeTool: createToolExecutor({ events })
    });

    if (!result.ok) {
      console.error('Chat model error:', (result.errors || []).join(' | '));
      return res.status(502).json({
        error: 'تعذّر الوصول للمساعد الآلي الآن. جرّب مرة أخرى بعد قليل.'
      });
    }

    // The message was answered — count it against the window
    const after = await recordChatMessage(req.user._id);

    res.json({
      reply: result.text || 'عذراً، لم أفهم. هل يمكنك إعادة صياغة السؤال؟',
      model: result.model || null,
      products: events.products,
      actions: events.actions,
      usage: { limit: after.limit, used: after.used, remaining: after.remaining, resetsAt: after.resetsAt }
    });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'حدث خطأ غير متوقع في المساعد الآلي' });
  }
});

// ─── API: Products ───────────────────────────────────────────

// The customer catalog. Paginated on purpose: the store holds thousands of
// products and shipping them ALL to every browser is what made the browse
// page unusable. The response always carries the page metadata the browse UI
// needs (total / pages / per-category counts), so the sidebar counts stay
// right without ever downloading the whole catalog.
//
//   ?type=…             filter by category
//   ?priceRange=…       under10 | 10to30 | over30
//   ?search=…           name or keyword
//   ?discount=on        only products with a running discount
//   ?sort=newest        newest discounts first
//   ?random=1           first page is a random selection (browse landing)
//   ?page=2&limit=24    the page to return (limit is capped at MAX_PAGE_SIZE)
//   ?ids=a,b,c          exact products (cart / checkout / order pages)
//   ?items=name1&items=name2   «متوفر ومشابه لطلبك» products, returned first
//   ?featured=4         the newest discounted products for the home page
app.get('/api/products', async (req, res) => {
  try {
    const { type, priceRange, search, discount, sort, page, limit, ids, featured, random } = req.query;

    // Exact products by id — the cart, the checkout quantity limits and the
    // order pages only need the handful of products they reference.
    if (ids !== undefined) {
      const wanted = String(ids).split(',').map((id) => id.trim()).filter(Boolean);
      const products = await listProductsByIds(wanted);
      return res.json({
        products,
        total: products.length,
        page: 1,
        pages: 1,
        limit: products.length
      });
    }

    const options = {
      type,
      priceRange,
      search,
      discount: discount === 'on' || discount === '1' || discount === 'true',
      sort,
      page,
      limit: limit || DEFAULT_PAGE_SIZE,
      // ?random=1 → first page is a fresh random selection (browse landing)
      random: random === '1' || random === 'true'
    };

    // The home page wants the newest discounted products, nothing else
    if (featured) {
      options.sort = 'newest';
      options.discount = true;
      options.page = 1;
      options.limit = Number(featured) || 4;
    }

    // Expired hides, quantity caps and discounts are cleaned before the read.
    // The rules live in utils/catalog.js and only touch what actually expired.
    await pruneCatalog();

    const result = await listProducts(options);

    const payload = {
      products: result.products,
      total: result.total,
      page: result.page,
      pages: result.pages,
      limit: result.limit,
      counts: result.counts
    };

    // The alternatives-SMS link pins «متوفر ومشابه لطلبك» products: they must
    // be found even when they sit on a page the customer is not looking at.
    const suggestedNames = [];
    [].concat(req.query.items || []).forEach((entry) => {
      String(entry).split(',').forEach((name) => {
        const trimmed = name.trim();
        if (trimmed) suggestedNames.push(trimmed);
      });
    });
    if (suggestedNames.length) {
      payload.suggested = await listProductsByNames(suggestedNames);
    }

    res.json(payload);
  } catch (err) {
    console.error('Load products error:', err.message);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// ─── API: Orders (owner only) ────────────────────────────────

// All orders, decrypted — powers the dashboard table
app.get('/api/admin/orders', requireAuth, requireOwner, async (req, res) => {
  try {
    // Same rule as the customer list: an unpaid card order is not an order
    // yet (there is no hold to capture and nothing to accept).
    await dropAbandonedPayments();

    const orders = await Order.find({
      paymentStatus: { $ne: 'pending_authorization' }
    }).sort({ orderTime: -1 });
    await loadOrderImages(orders);
    res.json({ orders: orders.map(orderJSONWithImages) });
  } catch (err) {
    console.error('Admin orders error:', err.message);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// Single order by ID, decrypted — powers the customer-order page
app.get('/api/admin/orders/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    await loadOrderImages([order]);
    res.json({ order: orderJSONWithImages(order) });
  } catch (err) {
    console.error('Admin order error:', err.message);
    res.status(500).json({ error: 'Failed to load order' });
  }
});

// Owner updates the delivery stage of an order
app.put('/api/admin/orders/:id/stage', requireAuth, requireOwner, async (req, res) => {
  try {
    const { stage } = req.body;
    const allowed = ['preparing', 'on_the_way', 'delivered'];
    if (!allowed.includes(stage)) {
      return res.status(400).json({ error: 'Invalid stage' });
    }

    const order = await Order.findOneAndUpdate(
      { orderId: req.params.id },
      { status: stage },
      { returnDocument: 'after' }
    );
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ order: order.toJSON() });
  } catch (err) {
    console.error('Update stage error:', err.message);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// Owner marks an order as confirmed (called after the SMS is sent)
app.put('/api/admin/orders/:id/confirm', requireAuth, requireOwner, async (req, res) => {
  try {
    const order = await Order.findOneAndUpdate(
      { orderId: req.params.id },
      { confirmed: true },
      { returnDocument: 'after' }
    );
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ order: order.toJSON() });
  } catch (err) {
    console.error('Confirm order error:', err.message);
    res.status(500).json({ error: 'Failed to confirm order' });
  }
});

// ─── Owner image uploads (alternatives page) ────────────────

const IMAGES_DIR = path.join(__dirname, 'public', 'images');

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: IMAGES_DIR,
    filename: (req, file, cb) => {
      // product-<random>.<original extension> — no collisions, no user path input
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `product-${crypto.randomBytes(8).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'].includes(file.mimetype);
    cb(ok ? null : new Error('INVALID_TYPE'), ok);
  }
});

// ─── API: Product management (owner only) ───────────────────

/**
 * Create a new product. Sent as multipart/form-data from the alternatives
 * page: name, price, type, keyWords, optional discountPercent, quantity
 * mode/limit and the image file. The image is saved into public/images and
 * the generated object is written to the `products` collection immediately.
 */
app.post('/api/owner/products', requireAuth, requireOwner, (req, res) => {
  imageUpload.single('image')(req, res, async (err) => {
    if (err) {
      const isType = err.message === 'INVALID_TYPE';
      return res.status(400).json({
        error: isType ? 'Only image files are allowed' : 'Image too large (max 5 MB)'
      });
    }

    try {
      const { name, price, type, keyWords, discountPercent, discountHours, quantityMode, quantityValue } = req.body;

      // ── Validation ──
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'Product name is required' });
      }
      const priceCents = Math.round(Number(price) * 100);
      if (!Number.isFinite(Number(price)) || Number(price) < 0 || priceCents === 0) {
        return res.status(400).json({ error: 'Invalid price' });
      }
      const validTypes = CATEGORY_TYPES;
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: 'Invalid category' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'Product image is required' });
      }

      const keywords = String(keyWords || '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);

      // Quantity: default is unlimited; a positive limit makes it limited
      const unlimited = quantityMode !== 'limited';
      let stockQuantity = null;
      if (!unlimited) {
        stockQuantity = Number.parseInt(quantityValue, 10);
        if (!Number.isInteger(stockQuantity) || stockQuantity < 0) {
          return res.status(400).json({ error: 'Invalid quantity value' });
        }
      }

      // Optional discount with an optional duration (hours)
      let discount = null;
      if (discountPercent !== undefined && discountPercent !== '') {
        discount = { percent: Number(discountPercent) };
        if (!Number.isInteger(discount.percent) || discount.percent < 1 || discount.percent > 99) {
          return res.status(400).json({ error: 'Invalid discount percent' });
        }
        if (discountHours !== undefined && discountHours !== '') {
          discount.hours = Number(discountHours);
          if (!Number.isFinite(discount.hours) || discount.hours <= 0 || discount.hours > 8760) {
            return res.status(400).json({ error: 'Invalid discount duration' });
          }
        }
      }

      const product = {
        id: crypto.randomBytes(4).toString('hex'),
        name: String(name).trim(),
        priceCents,
        keyWords: keywords,
        type,
        imageUrl: `/images/${req.file.filename}`
      };
      if (discount !== null) {
        product.discountPercent = discount.percent;
        product.discountSetAt = new Date().toISOString();
        if (discount.hours) {
          product.discountUntil = new Date(Date.now() + discount.hours * 60 * 60 * 1000).toISOString();
        }
      }
      if (unlimited) product.unlimitedQuantity = true;
      else {
        product.stockQuantity = stockQuantity;
        // A brand-new capped product: the owner's stock is what they entered
        product.ownerStock = stockQuantity;
      }

      await createProduct(product);

      res.status(201).json({ product: enrichStockStatus(product) });
    } catch (err) {
      // Clean up the uploaded file if the product could not be saved
      if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
      console.error('Create product error:', err.message);
      res.status(500).json({ error: 'Failed to create product' });
    }
  });
});

// Full catalog with stock status — powers the alternatives page
app.get('/api/owner/products', requireAuth, requireOwner, async (req, res) => {
  try {
    const includeDeleted = req.query.includeDeleted === 'true';
    // Expired hides/caps/discounts are cleaned out here too, so the owner
    // never sees a stale «انتهت مدة الإخفاء» tag or a dead quantity cap.
    await pruneCatalog();

    // Exact products, hidden and deleted included — the owner's order page and
    // the alternatives page resolve a handful of products, not the whole
    // catalog, now that it can hold thousands.
    if (req.query.ids !== undefined) {
      const wanted = String(req.query.ids).split(',').map((id) => id.trim()).filter(Boolean);
      const byIds = await listProductsByIds(wanted, { includeHidden: true });
      return res.json({ products: byIds.map(enrichStockStatus) });
    }

    const products = await listOwnerProducts({ includeDeleted });
    res.json({ products: products.map(enrichStockStatus) });
  } catch (err) {
    console.error('Owner products error:', err.message);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

/**
 * Update a product's stock settings.
 * Body may contain:
 *  - quantity: { mode: 'limited', value: number, inStock?: number } | { mode: 'unlimited' }
 *    value    = what customers may still order (the checkout cap)
 *    inStock  = the owner's own stock count; it is NOT reduced by orders
 *               (defaults to value when the owner did not send it)
 *  - hide: { hidden: boolean, hours?: number }  (hours optional — no expiry = manual unhide)
 *  - deleted: boolean  (soft delete / restore)
 */
app.put('/api/owner/products/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    const { quantity, hide, deleted, discount, priceCents } = req.body || {};

    // ── Validate everything BEFORE the product is touched, so a bad field can
    //    never leave a half-applied update behind.
    let cents = null;
    if (priceCents !== undefined) {
      cents = Number(priceCents);
      if (!Number.isFinite(cents) || cents <= 0 || cents > 100000000) {
        return res.status(400).json({ error: 'Invalid price' });
      }
    }

    // Discount settings
    let discountPatch = null;
    if (discount !== undefined) {
      if (discount === null || discount.percent === null || discount.percent === '') {
        // Remove the discount completely
        discountPatch = { clear: true };
      } else {
        const percent = Number(discount.percent);
        if (!Number.isFinite(percent) || percent < 1 || percent > 99 || !Number.isInteger(percent)) {
          return res.status(400).json({ error: 'Invalid discount percent' });
        }
        let until = null;
        if (discount.hours !== undefined && discount.hours !== null && discount.hours !== '') {
          const hours = Number(discount.hours);
          if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
            return res.status(400).json({ error: 'Invalid discount duration' });
          }
          until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
        }
        discountPatch = { clear: false, percent, until };
      }
    }

    // Quantity settings
    let quantityPatch = null;
    if (quantity !== undefined) {
      if (quantity.mode === 'unlimited') {
        quantityPatch = { mode: 'unlimited' };
      } else if (quantity.mode === 'limited') {
        const value = Number(quantity.value);
        if (!Number.isInteger(value) || value < 0) {
          return res.status(400).json({ error: 'Invalid quantity value' });
        }
        // The owner-facing «في المخزون» count is optional: without it the
        // availability they sent is also what they say they have on the shelf.
        const inStock = quantity.inStock === undefined || quantity.inStock === null
          ? value
          : Number(quantity.inStock);
        if (!Number.isInteger(inStock) || inStock < 0) {
          return res.status(400).json({ error: 'Invalid in-stock value' });
        }
        quantityPatch = { mode: 'limited', value, inStock };
      } else {
        return res.status(400).json({ error: 'Invalid quantity mode' });
      }
    }

    // Hide settings
    let hidePatch = null;
    if (hide !== undefined) {
      if (typeof hide.hidden !== 'boolean') {
        return res.status(400).json({ error: 'Invalid hide value' });
      }
      let until = null;
      if (hide.hidden && hide.hours !== undefined && hide.hours !== null) {
        const hours = Number(hide.hours);
        if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
          return res.status(400).json({ error: 'Invalid hide duration' });
        }
        until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      }
      hidePatch = { hidden: hide.hidden, until };
    }

    // Soft delete / restore
    if (deleted !== undefined && typeof deleted !== 'boolean') {
      return res.status(400).json({ error: 'Invalid deleted value' });
    }

    // ── Apply as ONE per-document update (no whole-catalog rewrite) ──
    const product = await updateProductById(req.params.id, (product) => {
      if (cents !== null) product.priceCents = Math.round(cents);

      if (discountPatch) {
        if (discountPatch.clear) {
          delete product.discountPercent;
          delete product.discountUntil;
          delete product.discountSetAt;
        } else {
          product.discountPercent = discountPatch.percent;
          product.discountSetAt = new Date().toISOString();
          if (discountPatch.until) product.discountUntil = discountPatch.until;
          else delete product.discountUntil;
        }
      }

      if (quantityPatch) {
        if (quantityPatch.mode === 'unlimited') {
          delete product.stockQuantity;
          delete product.ownerStock;
          product.unlimitedQuantity = true;
        } else {
          const { value, inStock } = quantityPatch;
          delete product.unlimitedQuantity;
          product.stockQuantity = value;
          product.ownerStock = inStock;
        }
      }

      if (hidePatch) {
        if (hidePatch.hidden) {
          product.hidden = true;
          // A manual hide is the owner's decision, not a system one: no reason
          // means it survives order cancellations (see restoreSoldOut)
          delete product.hideReason;
          if (hidePatch.until) product.hideUntil = hidePatch.until;
          // Hidden with no duration — stays hidden until the owner unhides it
          else delete product.hideUntil;
        } else {
          delete product.hidden;
          delete product.hideUntil;
          delete product.hideReason;
        }
      }

      if (deleted !== undefined) {
        if (deleted) product.deleted = true;
        else delete product.deleted;
      }
    });

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ product: enrichStockStatus(product) });
  } catch (err) {
    console.error('Update product error:', err.message);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

/**
 * Soft-delete a product — it moves to the deleted items page with
 * "deleted: true" and disappears from the customer catalog.
 */
app.delete('/api/owner/products/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    const product = await setProductDeleted(req.params.id, true);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ product: enrichStockStatus(product) });
  } catch (err) {
    console.error('Delete product error:', err.message);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

/**
 * Attach customer-facing stock status flags so the frontend can render
 * the card badges and enforce cart limits.
 */
function enrichStockStatus(product) {
  const hidden = product.hidden === true;
  const hideUntil = product.hideUntil || null;
  // A finished hide is not a hide: the product is visible to customers again
  // (pruneCatalog() also clears it from the JSON — this keeps the response
  // honest for the split second before that happens)
  const hideExpired = hidden && hideUntil && new Date(hideUntil).getTime() <= Date.now();
  // No quantity set = unlimited (customers can add as many as they want).
  // A pending unlimitedUntil window (owner promise after a low-stock review)
  // also counts as unlimited until it expires.
  const unlimitedWindow = product.unlimitedUntil &&
    new Date(product.unlimitedUntil).getTime() > Date.now();
  const unlimited = product.unlimitedQuantity === true ||
    product.stockQuantity == null || unlimitedWindow;
  // A discount is only real while it has a percentage and its deadline has
  // not passed (deadline optional — no discountUntil = runs until removed)
  const hasDiscount = product.discountPercent > 0 &&
    (!product.discountUntil || new Date(product.discountUntil).getTime() > Date.now());
  // The owner's own «الكمية في المخزون»: what they said they have. Customer
  // orders never touch it — they consume stockQuantity above. A product that
  // only ever had a cap falls back to it, so the figure is never missing.
  const ownerStock = product.ownerStock != null
    ? Math.max(0, Number(product.ownerStock) || 0)
    : null;
  return {
    ...product,
    unlimitedQuantity: unlimited,
    stockQuantity: product.stockQuantity ?? null,
    ownerStock: unlimited ? null : (ownerStock != null ? ownerStock : (product.stockQuantity ?? null)),
    stockUntil: product.stockUntil || null,
    unlimitedUntil: unlimitedWindow ? product.unlimitedUntil : null,
    hidden: hidden && !hideExpired,
    hideUntil,
    hideReason: product.hideReason || null,
    hideExpired,
    discountActive: hasDiscount,
    deleted: product.deleted === true
  };
}

// Place order — requires authentication, saves to MongoDB.
// Blocked entirely while the store is in maintenance mode.
app.post('/api/place-order', requireAuth, (req, res, next) => {
  if (readSettings().maintenanceMode) {
    return res.status(503).json({ error: 'المتجر مغلق مؤقتاً ولا يمكن إتمام الطلب حالياً' });
  }
  next();
}, async (req, res) => {
  try {
    const { items, total, customerName, customerPhone, customerAddress, customerLocation, subtotal, delivery, paymentMethod } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ error: 'No items in order' });
    }

    // Optional geolocation the customer shared — validate the shape strictly
    // (numbers, sane ranges) and round to ~0.1m precision before storing
    let location = null;
    if (customerLocation && typeof customerLocation === 'object') {
      const lat = Number(customerLocation.lat);
      const lng = Number(customerLocation.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        location = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
      }
    }

    const orderId = 'ORD-' + dayjs().format('YYMMDDHHmmss');

    // Cart items only contain productId + quantity — enrich them with the
    // real product names/prices from the catalog so the owner's WhatsApp
    // message shows actual names instead of "undefined x3".
    // The total is ALWAYS recomputed here from the catalog with discounts
    // applied — the frontend's number is never trusted.
    const deliveryFee = readSettings().deliveryFee ?? 0;
    const { subtotalSar, totalSar, enriched: enrichedItems } = await computeOrderAmounts(items, deliveryFee);
    if (!enrichedItems.length) {
      return res.status(400).json({ error: 'No valid items in order' });
    }

    // Save order to MongoDB — customer details and items are encrypted at rest
    const order = new Order({
      orderId,
      userId: req.user._id,
      total: totalSar,
      subtotal: subtotalSar,
      delivery: deliveryFee,
      paymentMethod: paymentMethod || 'card',
      // Cash orders are settled at the door — no Moyasar involvement.
      // Card orders only reach this route via the legacy path; the normal
      // card flow goes through /api/create-payment instead.
      paymentStatus: paymentMethod === 'cash' ? 'cash' : 'pending_authorization',
      status: 'preparing',
      // Opt-out only: the checkout sends `invoiceSms: false` when the customer
      // turned the «استلام الفواتير وتفاصيل الطلب عبر رقم الجوال» toggle off.
      invoiceSms: req.body.invoiceSms !== false,
      orderTime: new Date()
    });
    order.setItems(enrichedItems);
    order.setCustomer({
      name: customerName,
      phone: customerPhone,
      address: customerAddress,
      location
    });
    await saveOrderWithUniqueId(order);

    // Notify the owner over WhatsApp (fire and forget — do not block the
    // response). Cash orders are complete the moment they are saved; card
    // orders only notify once the payment hold is authorized, so the legacy
    // card path below stays silent until then.
    if (order.paymentStatus !== 'pending_authorization') {
      acceptOrder(order).catch(() => {});
    }

    res.status(201).json({ order: order.toJSON() });
  } catch (err) {
    console.error('Place order error:', err.message);
    res.status(500).json({ error: 'Failed to place order' });
  }
});

// ─── API: Account settings (profile + saved addresses) ───────

// GET /api/me/summary — account tab: name, phone, registration date,
// and how many orders the account has placed.
app.get('/api/me/summary', requireAuth, async (req, res) => {
  try {
    const ordersCount = await Order.countDocuments({ userId: req.user._id });
    res.json({
      user: {
        name: req.user.name || '',
        phone: req.user.getPhone(),
        role: req.user.role,
        registeredAt: req.user.getRegisteredAt(),
        ordersCount
      }
    });
  } catch (err) {
    console.error('Account summary error:', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب بيانات الحساب.' });
  }
});

// PUT /api/me/profile — change the display name only (phone is fixed)
app.put('/api/me/profile', requireAuth, [
  body('name')
    .trim()
    .isLength({ min: 2, max: 60 })
    .withMessage('الاسم يجب أن يكون حرفين على الأقل')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  try {
    req.user.name = req.body.name;
    await req.user.save();
    res.json({ user: req.user.toJSON() });
  } catch (err) {
    console.error('Profile update error:', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء حفظ البيانات.' });
  }
});

// GET /api/me/addresses — the saved-addresses tab
app.get('/api/me/addresses', requireAuth, async (req, res) => {
  try {
    res.json({ addresses: req.user.getAddresses() });
  } catch (err) {
    console.error('Addresses read error:', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب العناوين.' });
  }
});

// POST /api/me/addresses — add an address
app.post('/api/me/addresses', requireAuth, [
  body('label').trim().isLength({ min: 1, max: 40 }).withMessage('اسم العنوان مطلوب'),
  body('address').trim().isLength({ min: 5, max: 300 }).withMessage('العنوان يجب أن يكون 5 أحرف على الأقل'),
  body('isDefault').optional().isBoolean(),
  body('location').optional().customSanitizer(sanitizeCoordinates)
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  try {
    const list = req.user.getAddresses();
    const isDefault = req.body.isDefault === true || list.length === 0;
    const entry = {
      id: 'addr-' + crypto.randomBytes(6).toString('hex'),
      label: req.body.label,
      address: req.body.address,
      isDefault
    };
    if (req.body.location) entry.location = req.body.location;
    if (isDefault) list.forEach((a) => { a.isDefault = false; });
    list.push(entry);
    req.user.setAddresses(list);
    await req.user.save();
    res.status(201).json({ addresses: req.user.getAddresses() });
  } catch (err) {
    console.error('Address add error:', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء حفظ العنوان.' });
  }
});

// PUT /api/me/addresses/:id — edit an address (label/text/default flag)
app.put('/api/me/addresses/:id', requireAuth, [
  body('label').trim().isLength({ min: 1, max: 40 }).withMessage('اسم العنوان مطلوب'),
  body('address').trim().isLength({ min: 5, max: 300 }).withMessage('العنوان يجب أن يكون 5 أحرف على الأقل'),
  body('location').optional().customSanitizer(sanitizeCoordinates)
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  try {
    const list = req.user.getAddresses();
    const entry = list.find((a) => a.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'العنوان غير موجود.' });

    entry.label = req.body.label;
    entry.address = req.body.address;
    if (req.body.location) entry.location = req.body.location;
    if (req.body.isDefault === true) {
      list.forEach((a) => { a.isDefault = false; });
      entry.isDefault = true;
    }
    req.user.setAddresses(list);
    await req.user.save();
    res.json({ addresses: req.user.getAddresses() });
  } catch (err) {
    console.error('Address update error:', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء تعديل العنوان.' });
  }
});

// POST /api/me/addresses/:id/default — set one address as the default
app.post('/api/me/addresses/:id/default', requireAuth, async (req, res) => {
  try {
    const list = req.user.getAddresses();
    const entry = list.find((a) => a.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'العنوان غير موجود.' });

    list.forEach((a) => { a.isDefault = a.id === entry.id; });
    req.user.setAddresses(list);
    await req.user.save();
    res.json({ addresses: req.user.getAddresses() });
  } catch (err) {
    console.error('Address default error:', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء تعيين العنوان الافتراضي.' });
  }
});

// DELETE /api/me/addresses/:id — remove an address
app.delete('/api/me/addresses/:id', requireAuth, async (req, res) => {
  try {
    const list = req.user.getAddresses().filter((a) => a.id !== req.params.id);
    // Keep at least one default when any address remains
    if (list.length > 0 && !list.some((a) => a.isDefault)) list[0].isDefault = true;
    req.user.setAddresses(list);
    await req.user.save();
    res.json({ addresses: req.user.getAddresses() });
  } catch (err) {
    console.error('Address delete error:', err.message);
    res.status(500).json({ error: 'حدث خطأ أثناء حذف العنوان.' });
  }
});

// Confirm order — owner only, sends the confirmation SMS to the customer.
// The SMS must succeed before the order is marked confirmed.
app.post('/api/confirm-order', requireAuth, requireOwner, async (req, res) => {
  try {
    const { phone, message, orderId } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message are required' });
    }

    const order = orderId ? await Order.findOne({ orderId }) : null;

    // ─── Payment capture (card orders only) ───────────────────
    // Confirming the order IS accepting it: the authorized hold is captured
    // and the money moves to the store account. Cash orders skip this.
    if (order && order.paymentMethod === 'card' && order.paymentStatus !== 'paid') {
      if (order.paymentStatus === 'pending_authorization') {
        // The customer never completed the card form — no hold exists, so
        // there is nothing to capture and the order must not be confirmed.
        return res.status(409).json({
          error: 'العميل لم يكمل عملية الدفع بعد، لذلك لا يمكن تأكيد الطلب. يمكنك التواصل مع العميل أو انتظار إكماله للدفع.'
        });
      }
      if (order.paymentStatus === 'authorized') {
        if (isMockMode()) {
          order.paymentStatus = 'paid';
          await order.save();
          logMockCaptured(order);
        } else if (order.paymentId) {
          const result = await capturePayment(order.paymentId, order.totalAmount);
          if (!result.ok || (result.status !== 'captured' && result.status !== 'paid')) {
            console.error('Capture failed during confirm for order', order.orderId, result.raw?.message || '');
            return res.status(502).json({ error: 'فشل تحصيل المبلغ من بطاقة العميل. لم يتم تأكيد الطلب — حاول مجدداً.' });
          }
          order.paymentStatus = 'paid';
          await order.save();
        } else {
          // Legacy order from before the payment system — no payment to
          // capture, confirm it as-is
          order.paymentStatus = 'paid';
          await order.save();
        }
      }
    }

    const result = await sendSMS(phone, message);

    if (!result.success) {
      return res.status(502).json({ error: 'Failed to send SMS' });
    }

    // Mark the order confirmed in the database (localStorage is client-side
    // only and invisible to other sessions, including the owner's)
    if (order) {
      order.confirmed = true;
      await order.save();
    }

    res.json({ success: true, paymentCaptured: order ? order.paymentStatus === 'paid' : false });
  } catch (err) {
    console.error('Confirm order error:', err.message);
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

// ─── API: Replacement review (owner marks order availability) ─────

// GET the parked review for an order (so the alternatives page can pick up
// where the owner left off, e.g. after pressing عودة for more marking)
app.get('/api/admin/replacements/:orderId', requireAuth, requireOwner, (req, res) => {
  const reviews = readReplacements();
  res.json({ replacements: reviews[req.params.orderId] || null });
});

// Park the owner's availability review for an order (NOT the SMS yet).
// The mark must reference an order that exists; each entry is a product
// state: 'available' | 'low' | 'unavailable'. Nothing is validated against
// the order items here — the owner may add or skip items freely.
app.put('/api/admin/orders/:orderId/replacements', requireAuth, requireOwner, [
  body('replacements').isArray({ max: 200 }).withMessage('replacements must be an array'),
  body('replacements.*.productId').isString().trim().isLength({ min: 1, max: 64 }),
  body('replacements.*.name').isString().trim().isLength({ min: 1, max: 120 }),
  body('replacements.*.state').isIn(['available', 'low', 'unavailable']),
  body('replacements.*.ordered').optional({ nullable: true }).isInt({ min: 0, max: 9999 }),
  body('replacements.*.available').optional({ nullable: true }).isInt({ min: 0, max: 9999 }),
  body('replacements.*.unlimitedUntil').optional({ nullable: true }).isISO8601()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'بيانات المراجعة غير صحيحة' });
  }

  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    if (order.cancelled) {
      return res.status(400).json({ error: 'لا يمكن تعديل مراجعة طلب ملغي' });
    }

    const review = {
      orderId: req.params.orderId.slice(0, 40),
      replacements: req.body.replacements.map((r) => ({
        productId: r.productId,
        name: r.name,
        state: r.state,
        ordered: Number.isFinite(Number(r.ordered)) ? Number(r.ordered) : null,
        available: Number.isFinite(Number(r.available)) ? Number(r.available) : null,
        unlimitedUntil: r.unlimitedUntil ? new Date(r.unlimitedUntil).toISOString() : null
      })),
      markedAt: new Date().toISOString()
    };

    const reviews = readReplacements();
    reviews[review.orderId] = review;
    writeReplacements(reviews);

    res.json({ success: true, replacements: review });
  } catch (err) {
    console.error('Replacement save error:', err.message);
    res.status(500).json({ error: 'Failed to save replacements' });
  }
});

// Owner sends the alternatives SMS after the review. Two outcomes:
// 1. Every ordered item is 'available' → the order is confirmed normally
//    (same path as /api/confirm-order).
// 2. At least one item is low/unavailable → the order is CANCELLED: the
//    customer gets the SMS, the review is encrypted onto the order, and
//    the ordered items (minus the unavailable ones) go back to their cart.
// 3. The SMS fails → nothing changes, the owner can retry safely.
app.post('/api/admin/orders/:orderId/alternatives-sms', requireAuth, requireOwner, [
  body('message').isString().trim().isLength({ min: 5, max: 1000 }).withMessage('message is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'الرسالة مطلوبة' });
  }

  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    if (order.cancelled) {
      return res.status(400).json({ error: 'تم إلغاء هذا الطلب مسبقاً' });
    }

    const message = String(req.body.message).trim();
    const sms = await sendSMS(order.getCustomer().phone, message);
    if (!sms.success) {
      return res.status(502).json({ error: 'Failed to send SMS' });
    }

    const review = readReplacements()[order.orderId] || null;
    const items = order.getItems();
    // Only the customer's OWN items decide whether the order can be made:
    // an alternative product the owner marked low/unavailable while browsing
    // the catalog must never cancel an order whose items are all available.
    const hasProblem = !!(review && hasOrderProblem(items, review.replacements));

    if (hasProblem) {
      // Cancel the order and return what is still obtainable to the cart.
      // Card payments: release the hold — the customer is never charged.
      order.cancelled = true;
      if (review) order.setReplacements(review);
      if (order.paymentMethod === 'card') await releaseCardPayment(order);
      await order.save();

      // The order never consumed its stock, so its sold-out hides are lifted
      // first; the owner's marks then take over (cap 24h / hide 24h)
      await restoreSoldOutToCatalog(items);
      await applyReviewToCatalog(review);
      returnItemsToCart(order.userId, items, review);
      deleteReplacements(order.orderId);

      console.log(`Order ${order.orderId} cancelled — unavailable items returned to the customer's cart`);
    } else {
      // Everything marked available → ordinary confirmation (which captures
      // the authorized card payment, exactly like /api/confirm-order)
      order.confirmed = true;
      if (order.paymentMethod === 'card' && order.paymentStatus === 'pending_authorization') {
        // Customer never completed the card form — cannot confirm
        return res.status(409).json({
          error: 'العميل لم يكمل عملية الدفع بعد، لذلك لا يمكن تأكيد الطلب.'
        });
      }
      if (order.paymentMethod === 'card' && order.paymentStatus !== 'paid' &&
          order.paymentStatus === 'authorized') {
        if (isMockMode()) {
          order.paymentStatus = 'paid';
          logMockCaptured(order);
        } else if (order.paymentId) {
          const result = await capturePayment(order.paymentId, order.totalAmount);
          if (!result.ok || (result.status !== 'captured' && result.status !== 'paid')) {
            console.error('Capture failed during alternatives confirmation for order', order.orderId, result.raw?.message || '');
            return res.status(502).json({ error: 'فشل تحصيل المبلغ من بطاقة العميل. لم يتم تأكيد الطلب — حاول مجدداً.' });
          }
        }
        // No paymentId → legacy order, nothing to capture
      }
      if (review) {
        order.setReplacements(review);
        deleteReplacements(order.orderId);
      }
      // The order is confirmed, but the owner's findings still describe the
      // stock (e.g. an alternative they marked غير متوفر while browsing)
      await applyReviewToCatalog(review);
      await order.save();
    }

    res.json({ success: true, cancelled: hasProblem });
  } catch (err) {
    console.error('Alternatives SMS error:', err.message);
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

// Delete the parked review for an order
function deleteReplacements(orderId) {
  const reviews = readReplacements();
  if (reviews[orderId]) {
    delete reviews[orderId];
    writeReplacements(reviews);
  }
}

/**
 * Apply the owner's review marks to the catalog (see utils/order-review.js):
 * «متوفر N فقط» caps the whole store for 24 hours, «غير متوفر» hides the
 * product for 24 hours, «متوفر» makes it orderable again.
 */
async function applyReviewToCatalog(review) {
  try {
    // Only the reviewed products are loaded, mutated by the same pure rule,
    // and written back individually.
    const ids = (review && Array.isArray(review.replacements) ? review.replacements : [])
      .map((r) => r && r.productId);
    await mutateProducts(ids, (products) => applyReviewAvailability(products, review));
  } catch (err) {
    console.error('Apply review availability error:', err.message);
  }
}

/**
 * A cancelled order never consumed its stock — give the ordered quantity back
 * to the cap and lift the sold-out hides it caused (an owner hide or
 * «غير متوفر» mark is left in place).
 */
async function restoreSoldOutToCatalog(items) {
  try {
    await mutateProducts(
      (items || []).map((item) => item && item.productId),
      (products) => restoreSoldOut(products, items)
    );
  } catch (err) {
    console.error('Restore sold-out stock error:', err.message);
  }
}

/**
 * The order just became real (cash order saved, card hold authorized): the
 * stock it consumed is gone for every customer — a capped product loses the
 * ordered quantity, and when that empties it the product sells out and is
 * hidden for every customer for 24 hours.
 */
async function markOrderSoldOut(order) {
  try {
    const items = typeof order.getItems === 'function' ? order.getItems() : [];
    await mutateProducts(
      items.map((item) => item && item.productId),
      (products) => markSoldOut(products, items)
    );
  } catch (err) {
    console.error('Sold-out stock update error:', err.message);
  }
}

// Explicit cancel — owner only, no SMS. Marks the order cancelled and
// returns ALL its items to the customer's cart (no review to filter by).
// Card payments: the authorized hold is VOIDED (released) — the customer
// is never charged for a cancelled order.
app.post('/api/admin/orders/:orderId/cancel', requireAuth, requireOwner, async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    if (order.cancelled) {
      return res.status(400).json({ error: 'تم إلغاء هذا الطلب مسبقاً' });
    }

    order.cancelled = true;
    if (order.paymentMethod === 'card') await releaseCardPayment(order);
    await order.save();

    await restoreSoldOutToCatalog(order.getItems());
    await returnItemsToCart(order.userId, order.getItems(), null);
    deleteReplacements(order.orderId);

    res.json({ success: true, cancelled: true });
  } catch (err) {
    console.error('Cancel order error:', err.message);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

/**
 * Return order items to the customer's saved cart after a cancellation.
 * Items marked 'unavailable' (or low-stock with 0 available) are dropped;
 * everything else goes back. A 'low' item is capped at the available
 * quantity the owner set (ordered 3, only 2 left → 2 go back), so the
 * customer never sees a cart quantity the store cannot fulfill. If a
 * replacement item no longer exists in the catalog it is returned anyway —
 * the customer will see it missing at checkout and can remove it.
 * @param {mongoose.Types.ObjectId} userId
 * @param {Array} items - decrypted order items [{ productId, quantity }]
 * @param {Object|null} review - the owner's replacement review
 */
async function returnItemsToCart(userId, items, review) {
  try {
    const Cart = (await import('./models/Cart.js')).default;
    const cart = await Cart.findOneAndUpdate(
      { userId },
      { userId },
      { upsert: true, returnDocument: 'after' }
    );

    const current = cart.getItems();
    const toReturn = computeReturnQuantities(items, review && review.replacements);

    toReturn.forEach(({ quantity, capped }, productId) => {
      const existing = current.find((c) => c.productId === productId);
      if (existing) {
        // A capped (low-stock) item must never keep a larger stale quantity
        existing.quantity = capped
          ? Math.min(existing.quantity, quantity)
          : Math.max(existing.quantity, quantity);
      } else {
        current.push({ productId, quantity });
      }
    });

    cart.setItems(current);
    await cart.save();
  } catch (err) {
    // Never fail the SMS response because the cart restore hiccuped
    console.error('Return items to cart error:', err.message);
  }
}

// ─── Moyasar payment flow (authorization & capture) ─────────
// 1. POST /api/create-payment       → order is priced SERVER-SIDE and saved
//                                     with status pending_authorization
// 2. POST /api/webhook/moyasar      → Moyasar tells us the payment was
//                                     authorized (money HELD on the card)
// 3. Confirming the order (إرسال رسالة وتأكيد الطلب) CAPTURES the hold →
//                                     the money moves to the store account
// 4. Cancelling the order VOIDs the hold → the customer is never charged

/**
 * Release the authorized card hold on a cancelled order (void in real mode,
 * a plain status flip in mock mode). The order object is mutated and saved
 * by the CALLER. Failures are logged but never block the cancellation —
 * a stuck hold is better than losing the cancel action.
 * @param {object} order - Mongoose Order document (mutated, not saved)
 */
async function releaseCardPayment(order) {
  if (order.paymentStatus === 'voided' || order.paymentStatus === 'paid' || order.paymentStatus === 'cash') return;

  if (isMockMode()) {
    order.paymentStatus = 'voided';
    logMockReleased(order);
    return;
  }

  if (!order.paymentId) {
    order.paymentStatus = 'voided';
    return;
  }

  const result = await voidPayment(order.paymentId);
  if (result.ok) {
    order.paymentStatus = 'voided';
  } else {
    // Hold stays 'authorized' — the owner can void it manually in the
    // Moyasar dashboard; the order itself is still cancelled
    console.error(`Could not void the hold for order ${order.orderId}:`, result.raw?.message || '');
  }
}

/**
 * Recalculate the exact order total on the server from the catalog.
 * The frontend total is NEVER trusted — the cart only sends productId +
 * quantity and the price lookup happens here.
 * @param {Array} items - [{ productId, quantity }]
 * @param {number} deliveryFee - delivery fee from settings
 * @returns {Promise<{ subtotalSar: number, totalSar: number, enriched: Array }>}
 */
async function computeOrderAmounts(items, deliveryFee) {
  // Only the products THIS order references are loaded — never the whole
  // catalog. `includeHidden` keeps the old behaviour where an owner-hidden
  // product could still be priced and ordered from a stale cart.
  const catalog = await listProductsByIds(
    (items || []).map((item) => item && item.productId),
    { includeHidden: true }
  );
  const byId = new Map(catalog.map((product) => [product.id, product]));
  let subtotalCents = 0;

  const enriched = items.map((item) => {
    const product = byId.get(item.productId);
    if (!product) return null;

    // Apply the product discount exactly like the frontend does
    let unitCents = product.priceCents;
    if (product.discountPercent) {
      unitCents = unitCents * (1 - product.discountPercent / 100);
    }
    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    subtotalCents += unitCents * quantity;

    return {
      productId: product.id,
      name: product.name,
      price: unitCents / 100,
      quantity,
      // The image travels WITH the order. Looking it up later fails exactly
      // when it matters most: a product the owner marked «غير متوفر» is
      // hidden from the customer catalog, so a review→cancel flow used to
      // drop the photo from the order pages.
      imageUrl: product.imageUrl || ''
    };
  }).filter(Boolean);

  const subtotalSar = Math.round(subtotalCents) / 100;
  return {
    subtotalSar,
    totalSar: Math.round((subtotalSar + (Number(deliveryFee) || 0)) * 100) / 100,
    enriched
  };
}

/**
 * The formatted mock-mode terminal log blocks. Customer name/phone are
 * decrypted on demand (encrypted at rest like everything else).
 */
function mockCustomerInfo(order) {
  const c = typeof order.getCustomer === 'function' ? order.getCustomer() : {};
  return { name: c.name || '—', phone: c.phone || '—' };
}

/**
 * One order line per console line, e.g. "  ×2 حليب المراعي — 12.00 SAR".
 */
function formatOrderItems(order) {
  let items = [];
  try { items = order.getItems() || []; } catch { /* decryption issue — skip lines */ }
  if (!items.length) return;
  console.log('Items:');
  for (const it of items) {
    const lineTotal = ((it.price || 0) * (it.quantity || 0)).toFixed(2);
    console.log(`  - ${it.name || 'منتج'} ×${it.quantity || 0} — ${lineTotal} SAR`);
  }
}

function logMockAuthorized(order, card) {
  const { name, phone } = mockCustomerInfo(order);
  console.log('\n[MOCK PAYMENT - HOLD AUTHORIZED]');
  console.log('----------------------------------------');
  console.log(`Order ID: #${order.orderId}`);
  console.log(`Customer: ${name} (${phone})`);
  console.log(`Card: ${card.mask} (${card.brand.toUpperCase()})`);
  console.log(`Cardholder: ${card.holder || '—'}`);
  formatOrderItems(order);
  console.log(`Amount HOLD (not charged): ${order.totalAmount.toFixed(2)} SAR`);
  console.log('Status: Funds Held on Card (Awaiting Owner Acceptance)');
  console.log('Money moves ONLY when the owner confirms the order.');
  console.log('----------------------------------------\n');
}

function logMockCaptured(order) {
  const { name, phone } = mockCustomerInfo(order);
  console.log('\n[MOCK PAYMENT - CAPTURE SUCCESSFUL]');
  console.log('----------------------------------------');
  console.log(`Order ID: #${order.orderId}`);
  console.log(`Customer: ${name} (${phone})`);
  console.log(`Customer ${name} was CHARGED ${order.totalAmount.toFixed(2)} SAR`);
  formatOrderItems(order);
  console.log(`Amount Captured: ${order.totalAmount.toFixed(2)} SAR`);
  console.log('Payout Destination: Arab National Bank (Simulated)');
  console.log('Status: Money Captured & Sent to Store Account');
  console.log('----------------------------------------\n');
}

function logMockReleased(order) {
  const { name, phone } = mockCustomerInfo(order);
  console.log('\n[MOCK PAYMENT - HOLD RELEASED]');
  console.log('----------------------------------------');
  console.log(`Order ID: #${order.orderId}`);
  console.log(`Customer: ${name} (${phone})`);
  formatOrderItems(order);
  console.log(`Amount Released: ${order.totalAmount.toFixed(2)} SAR`);
  console.log('Status: Hold voided — the customer was NEVER charged');
  console.log('----------------------------------------\n');
}

/**
 * Build the customer's order-summary message — their bill: what they ordered
 * and the payment summary.
 * @param {object} order - a mongoose Order document
 * @returns {string}
 */
function buildOrderBillMessage(order) {
  const items = typeof order.getItems === 'function' ? order.getItems() : [];
  const money = (value) => (Number(value) || 0).toFixed(2);

  const paymentLabels = {
    card: 'بطاقة ائتمانية',
    cash: 'الدفع عند الاستلام'
  };
  const paymentStateLabels = {
    paid: 'مدفوع',
    authorized: 'محجوز على البطاقة (يُسحب بعد قبول المتجر)',
    pending_authorization: 'بانتظار إتمام الدفع',
    voided: 'تم إرجاع المبلغ',
    cash: 'يُدفع عند الاستلام'
  };

  const lines = items.map((item) => {
    const quantity = Number(item.quantity) || 0;
    const lineTotal = (Number(item.price) || 0) * quantity;
    return `- ${item.name || 'منتج'} ×${quantity} — ${money(lineTotal)} ر.س`;
  });

  return [
    'بقالة الخيرات — فاتورة طلبك',
    `رقم الطلب: ${order.orderId}`,
    '',
    ...lines,
    '',
    `المجموع الفرعي: ${money(order.subtotal)} ر.س`,
    `رسوم التوصيل: ${money(order.delivery)} ر.س`,
    `الإجمالي: ${money(order.total)} ر.س`,
    `طريقة الدفع: ${paymentLabels[order.paymentMethod] || 'بطاقة ائتمانية'}`,
    `حالة الدفع: ${paymentStateLabels[order.paymentStatus] || '—'}`
  ].join('\n');
}

/**
 * Send the order-summary (bill) SMS to the number the customer entered at
 * checkout. Skipped only when they turned «استلام الفواتير وتفاصيل الطلب عبر
 * رقم الجوال» off — that toggle governs THIS message and nothing else.
 *
 * `sendSMS` prints a simulated message to the server console while the
 * Yamamah credentials are blank and sends it for real once they are set, so
 * no separate mock path is needed here. Fully best-effort: a failed SMS must
 * never fail the order.
 * @param {object} order - a mongoose Order document
 */
async function sendOrderBill(order) {
  if (!order || order.invoiceSms === false) return;

  try {
    const customer = typeof order.getCustomer === 'function' ? order.getCustomer() : {};
    const phone = customer.phone || '';
    if (!phone) return;

    const result = await sendSMS(phone, buildOrderBillMessage(order));
    if (!result.success) {
      console.error(`Order ${order.orderId}: the bill SMS could not be sent (${result.error || 'unknown error'})`);
    }
  } catch (err) {
    console.error('Order bill SMS error:', err.message);
  }
}

/**
 * The order just became real (cash order saved, or the card hold authorized).
 * Consume the stock it took and notify the owner — each exactly once.
 *
 * The order is CLAIMED with a single atomic update first: the stock is a
 * quantity now (not just a sold-out flag), so two callers arriving together
 * (the payment webhook and the customer's status polling, for example) must
 * not consume the same order twice.
 */
async function acceptOrder(order) {
  if (!order || order.ownerNotified) return; // already accepted

  // findOneAndUpdate only matches while ownerNotified is still unset, so only
  // the first caller gets the order back and does the work
  let claimed;
  try {
    claimed = await Order.findOneAndUpdate(
      { _id: order._id, ownerNotified: { $ne: true } },
      { $set: { ownerNotified: true } },
      { new: true }
    );
  } catch (err) {
    // Without a claim nothing is consumed — a later caller can still retry
    console.error('Accept order error:', err.message);
    return;
  }
  if (!claimed) return; // another caller accepted this order first

  await markOrderSoldOut(claimed);
  await notifyOwnerForOrder(claimed);

  // …and the customer gets their bill. This is the one place an order is
  // known to be real exactly once, so both card (authorized) and cash orders
  // land here — and a payment attempt that is never authorized gets nothing.
  await sendOrderBill(claimed);
}

/**
 * Send the owner's WhatsApp notification for an order. The caller
 * (acceptOrder) has already claimed the order, so this only sends.
 * Cash orders reach it right after saving; card orders the moment the payment
 * hold is authorized, because that is when the order really exists (before
 * that the customer has not paid anything).
 * @param {object} order - a mongoose Order document
 */
async function notifyOwnerForOrder(order) {
  if (!order) return;

  const customer = typeof order.getCustomer === 'function' ? order.getCustomer() : {};

  // Fire and forget — the WhatsApp API must never block the HTTP response.
  sendWhatsAppNotification({
    orderId: order.orderId,
    customerName: customer.name || '',
    customerPhone: customer.phone || '',
    customerAddress: customer.address || '',
    items: typeof order.getItems === 'function' ? order.getItems() : [],
    total: order.total,
    paymentMethod: order.paymentMethod
  }).catch((err) => console.error('WhatsApp notification error:', err.message));
}

// A card order that is still pending_authorization is a checkout attempt, not
// a placed order. After this long without a completed payment it is dropped.
const ABANDONED_PAYMENT_MS = 30 * 60 * 1000;

/**
 * Delete card orders whose payment was never authorized (the customer closed
 * the gateway or walked away). They are invisible everywhere, so this just
 * keeps the database clean.
 * @param {object} [filter] - extra Mongo filter, e.g. { userId }
 */
async function dropAbandonedPayments(filter = {}) {
  try {
    const result = await Order.deleteMany({
      ...filter,
      paymentStatus: 'pending_authorization',
      orderTime: { $lt: new Date(Date.now() - ABANDONED_PAYMENT_MS) }
    });
    if (result.deletedCount) {
      console.log(`[PAYMENT] Removed ${result.deletedCount} abandoned unpaid card order(s)`);
    }
  } catch (err) {
    console.error('Abandoned payment cleanup error:', err.message);
  }
}

/**
 * Save an order, retrying with a suffixed id on the (rare) duplicate key
 * collision when two orders are created within the same second.
 */
async function saveOrderWithUniqueId(order) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (attempt > 0) {
        order.orderId = 'ORD-' + dayjs().format('YYMMDDHHmmss') + '-' + attempt;
      }
      await order.save();
      return;
    } catch (err) {
      const isDupOrderId = err?.code === 11000 && String(err?.message || '').includes('orderId');
      if (!isDupOrderId || attempt === 4) throw err;
    }
  }
}

// ─── POST /api/create-payment ────────────────────────────────
// Priced & saved here; in mock mode the payment is instantly authorized.
// Blocked during maintenance like every other ordering endpoint.
app.post('/api/create-payment', requireAuth, (req, res, next) => {
  if (readSettings().maintenanceMode) {
    return res.status(503).json({ error: 'المتجر مغلق مؤقتاً ولا يمكن إتمام الطلب حالياً' });
  }
  next();
}, async (req, res) => {
  try {
    const { items, customerName, customerPhone, customerAddress, customerLocation, paymentMethod } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items in order' });
    }

    // Cash orders skip Moyasar entirely
    if (paymentMethod === 'cash') {
      return res.status(400).json({ error: 'Cash orders do not require an online payment' });
    }

    const deliveryFee = readSettings().deliveryFee;
    const { subtotalSar, totalSar, enriched } = await computeOrderAmounts(items, deliveryFee);
    if (!enriched.length) {
      return res.status(400).json({ error: 'No valid products in order' });
    }

    const orderId = 'ORD-' + dayjs().format('YYMMDDHHmmss');

    // Create the order — the SERVER-computed total is stored, never the
    // frontend's number
    const order = new Order({
      orderId,
      userId: req.user._id,
      total: totalSar,
      subtotal: subtotalSar,
      delivery: deliveryFee,
      totalAmount: totalSar,
      paymentMethod: 'card',
      paymentStatus: 'pending_authorization',
      status: 'preparing',
      // Same opt-out as the cash path — read from the checkout request
      invoiceSms: req.body.invoiceSms !== false,
      orderTime: new Date()
    });
    order.setItems(enriched);
    order.setCustomer({
      name: customerName,
      phone: customerPhone,
      address: customerAddress,
      location: customerLocation
    });
    await saveOrderWithUniqueId(order);

    // ─── MOCK and REAL share the same frontend flow from here ───
    // The order stays pending_authorization. The frontend ALWAYS shows the
    // card form; in mock mode it submits to /api/mock/authorize which
    // simulates the gateway, in real mode the Moyasar Web SDK handles it.
    return res.status(201).json({
      mock: isMockMode(),
      orderId: order.orderId,
      paymentId: order.paymentId || '',
      amount: totalSar,
      amountHalalas: Math.round(totalSar * 100), // 1 SAR = 100 halalas
      publishableKey: getPublishableKey(),
      description: `Grocery order ${order.orderId}`
    });
  } catch (err) {
    console.error('Create payment error:', err.message);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// ─── POST /api/mock/authorize ────────────────────────────────
// MOCK MODE ONLY — the simulated gateway. The frontend's mock card form
// submits here; the card is validated exactly like a real gateway (Luhn),
// the hold is placed, and a detailed breakdown is printed to the console.
// Card data is NEVER stored — only a PCI-style mask is logged.
app.post('/api/mock/authorize', requireAuth, [
  body('orderId').trim().notEmpty().withMessage('Missing order id'),
  body('cardNumber').isString().trim().isLength({ min: 12, max: 25 }).withMessage('رقم البطاقة غير صحيح'),
  body('cardHolder').isString().trim().isLength({ min: 2, max: 60 }).withMessage('اسم حامل البطاقة مطلوب'),
  body('expiry').matches(/^(0[1-9]|1[0-2])\s*\/\s*\d{2}$/).withMessage('تاريخ الانتهاء غير صحيح'),
  body('cvv').matches(/^\d{3,4}$/).withMessage('رمز CVV غير صحيح')
], async (req, res) => {
  if (!isMockMode()) {
    // Real keys are configured — the mock gateway is closed.
    return res.status(403).json({ error: 'Mock payments are disabled in live mode' });
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  try {
    const order = await Order.findOne({ orderId: req.body.orderId, userId: req.user._id });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.paymentStatus === 'authorized' || order.paymentStatus === 'paid') {
      return res.status(409).json({ error: 'This order is already paid or authorized' });
    }

    // Validate the number with the Luhn checksum like a real gateway
    const digits = String(req.body.cardNumber).replace(/\D/g, '');
    if (!luhnValid(digits)) {
      console.log(`[MOCK PAYMENT - DECLINED] Order #${order.orderId} — card ${maskCard(digits)} failed Luhn validation`);
      return res.status(402).json({ error: 'تم رفض البطاقة. تأكد من رقم البطاقة وحاول مرة اخرى.' });
    }

    // Simulate a small random decline rate? No — deterministic behavior is
    // better for testing. Only invalid numbers are declined.

    const card = {
      mask: maskCard(digits),
      brand: cardBrand(digits),
      holder: String(req.body.cardHolder).trim()
    };

    // Place the hold
    order.paymentId = 'mock_pay_' + crypto.randomBytes(6).toString('hex');
    order.paymentStatus = 'authorized';
    await order.save();

    logMockAuthorized(order, card);

    // The hold is authorized, so this is now a real order — notify the owner
    // over WhatsApp exactly like a cash order does.
    acceptOrder(order).catch(() => {});

    res.json({
      success: true,
      paymentId: order.paymentId,
      status: 'authorized',
      brand: card.brand,
      mask: card.mask
    });
  } catch (err) {
    console.error('Mock authorize error:', err.message);
    res.status(500).json({ error: 'Failed to authorize payment' });
  }
});

// ─── POST /api/cancel-payment ────────────────────────────────
// The customer closed the payment gateway without paying. The order that
// /api/create-payment saved is still pending_authorization — it was never
// paid, so it is dropped instead of looking like a placed order.
app.post('/api/cancel-payment', requireAuth, [
  body('orderId').trim().notEmpty().withMessage('Missing order id')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  try {
    const result = await Order.deleteOne({
      orderId: req.body.orderId,
      userId: req.user._id,
      // Only unpaid attempts can be removed — an authorized/paid order is
      // cancelled through the normal cancel flow (which releases the hold).
      paymentStatus: 'pending_authorization'
    });

    if (result.deletedCount) {
      console.log(`[PAYMENT] Unpaid card order ${req.body.orderId} dropped — the customer closed the gateway`);
    }
    res.json({ success: true, removed: result.deletedCount === 1 });
  } catch (err) {
    console.error('Cancel pending payment error:', err.message);
    res.status(500).json({ error: 'Failed to cancel the pending payment' });
  }
});

// ─── POST /api/attach-payment ──────────────────────────────────
// Real mode only: the Web SDK's on_completed callback reports the created
// payment id so we can link it to the order while the webhook / polling
// confirms the authorization.
app.post('/api/attach-payment', requireAuth, [
  body('orderId').trim().notEmpty().withMessage('Missing order id'),
  body('paymentId').trim().notEmpty().withMessage('Missing payment id')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  try {
    const order = await Order.findOne({ orderId: req.body.orderId, userId: req.user._id });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    order.paymentId = req.body.paymentId;
    await order.save();
    res.json({ success: true });
  } catch (err) {
    console.error('Attach payment error:', err.message);
    res.status(500).json({ error: 'Failed to attach payment' });
  }
});

// ─── POST /api/webhook/moyasar ───────────────────────────────
// Moyasar calls this when a payment changes status. Registered in the
// Moyasar dashboard with MOYASAR_WEBHOOK_SECRET as the endpoint secret.
// Moyasar has NO signature header — the secret_token field inside the JSON
// body IS the authentication, compared constant-time.
app.post('/api/webhook/moyasar', (req, res) => {
  const event = req.body || {};

  // 1. Verify the request is genuinely from Moyasar
  if (!verifyWebhookSecret(event)) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  // 2. Update the matching order when the payment is authorized
  const payment = event.data || event.payment || event;
  const paymentId = payment.id || payment.paymentId;
  const status = payment.status;

  if (paymentId && status === 'authorized') {
    Order.findOneAndUpdate(
      { paymentId },
      { paymentStatus: 'authorized' },
      { returnDocument: 'after' }
    )
      .then((order) => {
        if (order) {
          console.log(`[WEBHOOK] Payment ${paymentId} authorized for order ${order.orderId}`);
          // The hold is authorized — the order now counts as placed
          acceptOrder(order).catch(() => {});
        }
      })
      .catch((err) => console.error('Webhook update error:', err.message));
  }

  // Always 2xx quickly so Moyasar does not retry
  res.json({ received: true });
});

// ─── GET /api/orders/:id/payment-id ──────────────────────
// 3-D Secure return helper: the frontend needs the Moyasar payment id
// stored on its order (saved by the SDK's on_completed callback) so it can
// poll the authorization status after coming back from the bank.
app.get('/api/orders/:id/payment-id', requireAuth, async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id, userId: req.user._id });
    if (!order || !order.paymentId) return res.status(404).json({ error: 'Order not found' });

    res.json({ paymentId: order.paymentId, status: order.paymentStatus });
  } catch (err) {
    console.error('Payment id lookup error:', err.message);
    res.status(500).json({ error: 'Failed to look up payment' });
  }
});

// ─── GET /api/verify-payment-status/:paymentId ───────────────
// The frontend polls this every 2 seconds until the order's payment is
// authorized. Mock mode: instantly. Real mode: the webhook updates the
// order, and since webhooks can't reach a localhost server we ALSO sync
// from the Moyasar API directly when the DB still says pending.
app.get('/api/verify-payment-status/:paymentId', requireAuth, async (req, res) => {
  try {
    const order = await Order.findOne({ paymentId: req.params.paymentId, userId: req.user._id });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Webhook fallback: ask Moyasar directly while the order is still pending
    if (order.paymentStatus === 'pending_authorization' && !isMockMode() && order.paymentId && !order.paymentId.startsWith('mock_')) {
      const remote = await fetchPaymentStatus(order.paymentId);
      if (remote.ok && (remote.status === 'authorized' || remote.status === 'paid' || remote.status === 'captured')) {
        order.paymentStatus = 'authorized';
        await order.save();
        // Same as the webhook path: the order just became real
        acceptOrder(order).catch(() => {});
      }
    }

    res.json({
      status: order.paymentStatus,
      authorized: order.paymentStatus === 'authorized' || order.paymentStatus === 'paid',
      orderId: order.orderId
    });
  } catch (err) {
    console.error('Verify payment status error:', err.message);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// ─── 404 Handler ─────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).render('404');
});

// ─── Start server ────────────────────────────────────────────

// The catalog is swept on a timer as well as on reads, so a product whose
// hide / review cap / discount expires becomes visible again even while the
// store is idle. Cheap: it only touches documents that actually expired.
function startCatalogMaintenance() {
  const sweep = () => {
    pruneCatalog().catch((err) => console.error('Catalog prune error:', err.message));
  };
  sweep();
  const timer = setInterval(sweep, 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);

  try {
    startCatalogMaintenance();

    // A published store with no products is almost always a missed migration.
    if (await catalogCount() === 0) {
      console.warn(`\n⚠  ${CATALOG_SEED_NOTE}\n`);
    }

    // The assistant needs a key; log which models have one so a silent
    // misconfiguration is visible in the log (never prints the key itself).
    if (isChatConfigured()) {
      console.log(`Assistant enabled — models with a key: ${configuredModels().join(', ')}`);
    } else {
      console.warn('Assistant disabled — no NVIDIA_API_KEY found; the chatbot will return 503.');
    }
  } catch (err) {
    console.error('Startup catalog check failed:', err.message);
  }
});
