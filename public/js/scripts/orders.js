// Orders page script
// Displays order history with track and reorder buttons
// Orders load from the server (so owner actions like confirming show up),
// with localStorage as fallback for legacy orders

import { fetchOrders as fetchLocalOrders } from '../data/orders.js';
import { fetchProductsByIds, resolveOrderItem } from '../data/products.js';
import { addOrderToCart } from '../data/cart.js';

// Orders currently on screen — the reorder handler looks them up here
let currentOrders = [];

/**
 * Is a customer signed in? The header publishes the flag on every page.
 * When it is missing we assume NOT signed in, so a guest always keeps the
 * localStorage fallback.
 */
function isAuthenticated() {
  return window.IS_AUTHENTICATED === true;
}

function showEmptyOrdersState() {
  const ordersList = document.getElementById('orders-list');
  const noOrders = document.getElementById('no-orders');
  if (ordersList) {
    ordersList.innerHTML = '';
    ordersList.style.display = 'none';
  }
  if (noOrders) noOrders.style.display = 'block';
}

document.addEventListener('DOMContentLoaded', async () => {
  const ordersList = document.getElementById('orders-list');
  const noOrders = document.getElementById('no-orders');

  // The reorder handler is attached once, before any card is rendered
  setupReorderHandler();

  // 1. Guests only: paint the orders mirrored in localStorage right away, so
  //    the page is never stuck on its loading skeletons while a server that
  //    has no account to look in answers.
  //    A SIGNED-IN customer's orders come from the server alone. The mirror
  //    is what made a phantom order appear here — an order that was deleted
  //    on the server (or belongs to another account used on this browser)
  //    stayed in localStorage and the dashboard knew nothing about it.
  if (!isAuthenticated()) {
    const localOrders = fetchLocalOrders();
    if (localOrders.length) {
      try {
        await renderOrders(localOrders.slice(), ordersList, noOrders);
      } catch (err) {
        console.error('Failed to render the local orders:', err);
      }
    }
  }

  // 2. Then load the authoritative list from the server (with a timeout and
  //    a local fallback) and replace what is on screen.
  let orders = [];
  try {
    orders = await loadOrders();
  } catch (err) {
    console.error('Failed to load orders:', err);
  }

  ordersList.innerHTML = '';

  if (orders.length === 0) {
    showEmptyOrdersState();
    return;
  }

  try {
    await renderOrders(orders, ordersList, noOrders);
  } catch (err) {
    // A single malformed order must never blank the whole page
    console.error('Failed to render orders:', err);
    showEmptyOrdersState();
  }
});

/**
 * Build the order cards. Kept separate so the caller can guarantee that the
 * page always ends up showing something, whatever happens in here.
 * It does NOT attach any listeners — it can run twice (local paint, then the
 * server list) and listeners must never be duplicated.
 */
async function renderOrders(orders, ordersList, noOrders) {
  // Only the products these orders reference — the catalog may hold thousands
  const ids = [];
  (orders || []).forEach((order) => {
    (Array.isArray(order.items) ? order.items : []).forEach((item) => {
      if (item && item.productId) ids.push(item.productId);
    });
  });
  const products = await fetchProductsByIds(ids);
  const productById = new Map((products || []).map((p) => [p.id, p]));

  currentOrders = orders;

  noOrders.style.display = 'none';
  ordersList.style.display = '';

  // Sort orders by time, newest first
  orders.sort((a, b) => new Date(b.orderTime) - new Date(a.orderTime));

  orders.forEach((order) => {
    // Defensive: an order saved by an older version of the app (or a partial
    // write) must not break the page for every other order.
    const items = Array.isArray(order.items) ? order.items : [];
    const total = Number(order.total) || 0;
    // Confirmation status tag (owner must confirm the order first).
    // A cancelled order comes FIRST: it stays "unconfirmed" in the database,
    // and calling it «يتم المراجعة» would promise the customer an order the
    // store already dropped (the tracking page shows it as ملغي).
    const cancelled = order.cancelled === true || order.status === 'cancelled';
    // A confirmed order the owner has moved forward shows its real delivery
    // stage: reading «مؤكد» while the order is out for delivery (or already
    // delivered) told the customer nothing about where it actually is.
    const stageLabel = !cancelled && order.confirmed
      ? (order.status === 'delivered' ? 'تم التوصيل'
        : order.status === 'on_the_way' ? 'قيد التوصيل'
        : null)
      : null;
    const confirmLabel = cancelled ? 'ملغي'
      : stageLabel || (order.confirmed ? 'مؤكد' : 'يتم المراجعة');
    const confirmClass = cancelled ? 'status-cancelled'
      : order.status === 'delivered' && order.confirmed ? 'status-delivered'
      : order.status === 'on_the_way' && order.confirmed ? 'status-on_the_way'
      : order.confirmed ? 'status-confirmed' : 'status-review';

    const card = document.createElement('li');
    card.className = 'order-card';

    // Get product images for the preview (show max 6)
    const MAX_PREVIEW = 6;
    const visibleItems = items.slice(0, MAX_PREVIEW);
    const overflowCount = items.length - MAX_PREVIEW;

    // Every previewed item keeps its tile, even when its product is no longer
    // in the customer catalog (sold out → hidden for 24 hours, deleted, …):
    // resolveOrderItem falls back to the name stored on the order itself.
    const productImages = visibleItems
      .map((item) => {
        const display = resolveOrderItem(item, productById.get(item.productId));
        const image = display.imageUrl
          ? `<img src="${display.imageUrl}" alt="${display.name}" loading="lazy">`
          : `<span class="material-symbols-outlined">inventory_2</span>`;
        return `<div class="order-item-img" title="${display.name}">${image}</div>`;
      })
      .join('');

    const overflowBadge = overflowCount > 0
      ? `<span class="items-count">+${overflowCount}</span>`
      : '';

    const itemCount = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

    const orderDate = new Date(order.orderTime).toLocaleDateString('ar-SA', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    card.innerHTML = `
      <div class="order-top">
        <div class="order-id">
          <span class="material-symbols-outlined">receipt_long</span>
          طلب #${order.orderId || order.id}
        </div>
        <span class="status ${confirmClass}">حالة الطلب: ${confirmLabel}</span>
      </div>
      <div class="order-body">
        <div class="order-items-preview">
          ${productImages}
          ${overflowBadge}
          <span class="items-count">${itemCount} منتجات</span>
        </div>
        <div class="order-info">
          <span><span class="material-symbols-outlined">calendar_today</span> ${orderDate}</span>
          <span><span class="material-symbols-outlined">payments</span> ${total.toFixed(2)} ر.س</span>
        </div>
      </div>
      <div class="order-actions">
        <a href="/tracking?id=${order.orderId || order.id}" class="btn btn-primary btn-sm">التفاصيل والتتبع</a>
        <button class="btn btn-outline btn-sm reorder-btn" data-order-id="${order.orderId || order.id}">اعادة الطلب</button>
      </div>
    `;

    ordersList.appendChild(card);
  });

}

/**
 * Reorder buttons: delegated on the list, attached exactly once.
 */
function setupReorderHandler() {
  const ordersList = document.getElementById('orders-list');
  if (!ordersList) return;

  ordersList.addEventListener('click', async (e) => {
    const reorderBtn = e.target.closest('.reorder-btn');
    if (!reorderBtn) return;

    const orderId = reorderBtn.dataset.orderId;
    const order = currentOrders.find((o) => (o.orderId || o.id) === orderId);
    if (!order) return;

    await addOrderToCart(Array.isArray(order.items) ? order.items : []);

    // Update header cart badge
    window.dispatchEvent(new Event('cart-updated'));

    // Show brief feedback
    reorderBtn.textContent = 'تمت الاضافة';
    reorderBtn.style.background = 'var(--green)';
    reorderBtn.style.color = '#fff';
    reorderBtn.style.borderColor = 'var(--green)';

    setTimeout(() => {
      reorderBtn.textContent = 'اعادة الطلب';
      reorderBtn.style.background = '';
      reorderBtn.style.color = '';
      reorderBtn.style.borderColor = '';
    }, 2000);
  });
}

/**
 * Load the user's orders — server first (so owner actions like confirming
 * show up), localStorage fallback for guests/legacy orders.
 */
async function loadOrders() {
  // A slow or unreachable server must not leave the page stuck on its
  // loading skeletons forever — give up after a few seconds and fall back to
  // the orders mirrored in localStorage.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch('/api/my-orders', { signal: controller.signal });
    if (res.ok) {
      const data = await res.json();
      // The server is authoritative for a signed-in customer: an EMPTY list is
      // a real answer ("this account has no orders"), never a reason to fall
      // back to the local mirror and resurrect a phantom order
      return Array.isArray(data.orders) ? data.orders : [];
    }
    // 401 (guest) or a server error: the local mirror is all we have
    console.warn('Orders: server answered HTTP ' + res.status + ', using the local copy');
  } catch (err) {
    console.warn('Could not load orders from the server, using the local copy:', err.message);
  } finally {
    clearTimeout(timer);
  }

  return fetchLocalOrders();
}
