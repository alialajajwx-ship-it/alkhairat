// Cart data module
// Manages cart state in localStorage

const CART_KEY = 'alkhairat_cart';

// Maintenance mode flag — set by the header script when the owner paused
// the store. While active, nothing can be added to the cart.
function isStorePaused() {
  return window.STORE_MAINTENANCE === true;
}

/**
 * Get cart items from localStorage
 * Returns array of { productId, quantity }
 */
export function getCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Save cart to localStorage and sync it to the user's account (server).
 * For guests only localStorage is used — the sync request is a no-op.
 */
function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  syncCartToServer();
}

/**
 * Add item to cart (increments quantity if already exists)
 */
export function addToCart(productId) {
  if (isStorePaused()) return getCart();
  const cart = getCart();
  const existing = cart.find((item) => item.productId === productId);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({ productId, quantity: 1 });
  }
  saveCart(cart);
  return cart;
}

/**
 * Add item to cart only if not already present
 * Returns true if added, false if already in cart
 */
export function addToCartOnce(productId) {
  if (isStorePaused()) return false;
  const cart = getCart();
  const existing = cart.find((item) => item.productId === productId);
  if (existing) {
    return false;
  }
  cart.push({ productId, quantity: 1 });
  saveCart(cart);
  return true;
}

/**
 * Remove item from cart
 */
export function removeFromCart(productId) {
  if (isStorePaused()) return getCart();
  let cart = getCart();
  cart = cart.filter((item) => item.productId !== productId);
  saveCart(cart);
  return cart;
}

/**
 * Check if item is in cart
 */
export function isInCart(productId) {
  return getCart().some((item) => item.productId === productId);
}

/**
 * Get cart item count
 */
export function getCartCount() {
  return getCart().length;
}

/**
 * Clear entire cart (localStorage + user account on the server)
 */
export function clearCart() {
  localStorage.removeItem(CART_KEY);
  fetch('/api/cart', { method: 'DELETE' }).catch(() => {});
}

// ─── Server Sync ─────────────────────────────────────────────
// Logged-in users get their cart saved to their account so it follows
// them across devices and sessions. Guests keep using localStorage only.

/**
 * Push the current localStorage cart to the user's account (fire-and-forget)
 */
export function syncCartToServer() {
  fetch('/api/cart', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: getCart() })
  }).catch(() => {});
}

/**
 * Load the cart saved on the user's account and merge it with the local one.
 * - Product in both: keeps the higher quantity (no doubling on refresh)
 * - Product in only one: it is kept
 * Dispatches 'cart-updated' when the local cart changed so the UI re-renders.
 */
export async function mergeServerCart() {
  try {
    const res = await fetch('/api/cart');
    if (!res.ok) return;

    const data = await res.json();

    // Guest (not logged in) — nothing to merge, keep the local cart
    if (data.authenticated === false) return;

    const serverItems = (data.items || []).map((i) => ({
      productId: i.productId,
      quantity: i.quantity
    }));

    // Server cart empty — push the local cart up so it gets saved
    if (serverItems.length === 0) {
      if (getCart().length > 0) syncCartToServer();
      return;
    }

    const local = getCart();

    // Local cart empty — take the account cart as-is
    if (local.length === 0) {
      saveCart(serverItems);
      window.dispatchEvent(new Event('cart-updated'));
      return;
    }

    // Merge both carts
    const merged = local.map((item) => ({ ...item }));
    let changed = false;

    serverItems.forEach((serverItem) => {
      const existing = merged.find((i) => i.productId === serverItem.productId);
      if (existing) {
        if (serverItem.quantity > existing.quantity) {
          existing.quantity = serverItem.quantity;
          changed = true;
        }
      } else {
        merged.push(serverItem);
        changed = true;
      }
    });

    if (changed) {
      saveCart(merged);
      window.dispatchEvent(new Event('cart-updated'));
    }
  } catch {
    // Network error — keep the local cart
  }
}

/**
 * Get cart items with full product data
 * Returns array of { product, quantity }
 */
export async function getCartWithProducts() {
  const cart = getCart();
  if (cart.length === 0) return [];

  // Only the products actually in the cart — never the whole catalog.
  const { fetchProductsByIds } = await import('./products.js');
  const products = await fetchProductsByIds(cart.map((item) => item.productId));
  const byId = new Map((products || []).map((product) => [product.id, product]));

  return cart
    .map((item) => {
      const product = byId.get(item.productId);
      if (!product) return null;
      return { product, quantity: item.quantity };
    })
    .filter(Boolean);
}

/**
 * Calculate cart subtotal in cents
 */
export async function calculateSubtotal() {
  const items = await getCartWithProducts();
  return items.reduce((sum, item) => {
    let priceCents = item.product.priceCents;
    if (item.product.discountPercent) {
      priceCents = priceCents * (1 - item.product.discountPercent / 100);
    }
    return sum + priceCents * item.quantity;
  }, 0);
}

// Fallback delivery fee while the server price has not loaded yet
const DEFAULT_DELIVERY_FEE = 7.0;

// The delivery fee set by the owner (delivery-price page), cached per session
let deliveryFee = null;

async function getDeliveryFee() {
  if (deliveryFee != null) return deliveryFee;
  try {
    const res = await fetch('/api/settings');
    if (res.ok) {
      const data = await res.json();
      if (Number.isFinite(data.deliveryFee)) {
        deliveryFee = data.deliveryFee;
        return deliveryFee;
      }
    }
  } catch {
    // fall back to the default below
  }
  return DEFAULT_DELIVERY_FEE;
}

/**
 * Calculate total with the owner-configured delivery fee
 * Returns { subtotal, delivery, total } in SAR
 */
export async function calculateTotals() {
  const subtotalCents = await calculateSubtotal();
  const subtotal = subtotalCents / 100;
  const delivery = await getDeliveryFee();
  const total = subtotal + delivery;

  return {
    subtotal: subtotal.toFixed(2),
    delivery: delivery.toFixed(2),
    total: total.toFixed(2)
  };
}

/**
 * Add all items from an order back to cart (for reorder)
 */
export async function addOrderToCart(orderItems) {
  if (isStorePaused()) return;
  const { fetchProductsByIds } = await import('./products.js');
  const products = await fetchProductsByIds((orderItems || []).map((item) => item && item.productId));
  const available = new Set((products || []).map((product) => product.id));

  orderItems.forEach((item) => {
    if (available.has(item.productId)) {
      addToCart(item.productId);
    }
  });
}
