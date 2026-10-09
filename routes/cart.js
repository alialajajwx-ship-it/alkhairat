import { Router } from 'express';
import Cart from '../models/Cart.js';
import { requireAuth } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = Router();

// Maintenance mode flag — data/settings.json (written by the owner toggle).
// While active, cart saving is blocked so ordering is fully paused.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

function isMaintenanceMode() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')).maintenanceMode === true;
  } catch {
    return false;
  }
}

// All cart routes require a logged-in user
router.use(requireAuth);

// ─── GET /api/cart ───────────────────────────────────────────
// Get the current user's saved cart (decrypted)
router.get('/', async (req, res) => {
  try {
    const cart = await Cart.findOne({ userId: req.user._id });
    res.json({ items: cart ? cart.getItems() : [] });
  } catch (err) {
    console.error('Get cart error:', err.message);
    res.status(500).json({ error: 'Failed to load cart' });
  }
});

// ─── PUT /api/cart ───────────────────────────────────────────
// Replace the user's saved cart with the given items.
// Blocked while the store is in maintenance mode.
router.put('/', (req, res, next) => {
  if (isMaintenanceMode()) {
    return res.status(503).json({ error: 'المتجر مغلق مؤقتاً' });
  }
  next();
}, async (req, res) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items must be an array' });
    }

    // Keep only valid entries — productId string + positive quantity
    const cleanItems = items
      .filter((i) => i && typeof i.productId === 'string' && Number.isFinite(Number(i.quantity)))
      .map((i) => ({
        productId: i.productId.slice(0, 64),
        quantity: Math.min(Math.max(parseInt(i.quantity, 10) || 1, 1), 99)
      }));

    const cart = await Cart.findOneAndUpdate(
      { userId: req.user._id },
      { userId: req.user._id },
      { upsert: true, returnDocument: 'after' }
    );
    cart.setItems(cleanItems);
    await cart.save();

    res.json({ success: true, items: cleanItems });
  } catch (err) {
    console.error('Save cart error:', err.message);
    res.status(500).json({ error: 'Failed to save cart' });
  }
});

// ─── DELETE /api/cart ────────────────────────────────────────
// Empty the user's saved cart
router.delete('/', async (req, res) => {
  try {
    await Cart.findOneAndDelete({ userId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    console.error('Clear cart error:', err.message);
    res.status(500).json({ error: 'Failed to clear cart' });
  }
});

export default router;
