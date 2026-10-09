// Tracking page script
// Displays order tracking with 3 stages (owner-driven) and order details
// The order is loaded from the server so the owner's stage updates show up
// (localStorage is only a fallback for legacy orders)
// Stages stay hidden until the store owner confirms the order

import { fetchOrder } from '../data/orders.js';
import { fetchProductsByIds, resolveOrderItem } from '../data/products.js';

const STATUS_POLL_MS = 15000;
let statusTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('id');

  if (!orderId) {
    document.getElementById('tracking-order-id').textContent = '';
    return;
  }

  // Skeletons are static HTML in the page — they stay until the order
  // data arrives and renderOrder() replaces them synchronously
  const order = await loadOrder(orderId);
  if (!order) {
    document.getElementById('tracking-order-id').textContent = '#' + orderId;
    return;
  }

  renderOrder(order);

  // Keep the status/stages fresh — the owner changes them on the server
  statusTimer = setInterval(async () => {
    const fresh = await loadOrder(orderId, { silent: true });
    if (fresh) {
      // paymentStatus is part of the comparison too: when the owner captures
      // the hold the «المبلغ محجوز على البطاقة» notice must disappear without
      // waiting for a delivery-stage change.
      const statusChanged =
        fresh.status !== order.status ||
        fresh.confirmed !== order.confirmed ||
        fresh.paymentStatus !== order.paymentStatus;
      // Refresh the order in place so the closure stays in sync
      Object.assign(order, fresh);
      if (statusChanged) {
        renderOrder(order);
      }
    }
  }, STATUS_POLL_MS);
});

/**
 * Load the order — server first (so owner updates are visible),
 * localStorage fallback for legacy orders never saved to the database.
 * @param {string} orderId
 * @param {Object} [opts]
 * @param {boolean} [opts.silent] - true during polling: keep any UI already
 *   rendered if the fetch fails (e.g. brief network hiccup)
 */
async function loadOrder(orderId, { silent = false } = {}) {
  try {
    const res = await fetch('/api/my-orders/' + encodeURIComponent(orderId));
    if (res.ok) {
      const data = await res.json();
      if (data.order) return data.order;
    }
    if (res.status === 401) return null; // guests have no server orders
  } catch {
    // network error — fall through
  }

  if (silent) return null; // don't overwrite a rendered page during polling

  const local = fetchOrder(orderId);
  if (local) return local;

  return null;
}

/**
 * Render (or re-render) the full order view
 */
function renderOrder(order) {
  document.getElementById('tracking-order-id').textContent = '#' + (order.orderId || order.id);

  // Confirmation status tag + timeline visibility + review note
  const tagEl = document.getElementById('order-confirm-tag');
  const timelinePanel = document.querySelector('.timeline-panel');
  const reviewNotice = document.getElementById('review-notice');
  const cancelNotice = document.getElementById('cancel-notice');

  // Every branch below starts from the same clean tag: a class left behind by
  // an earlier render (e.g. 'delivered') would fight the new one.
  tagEl.classList.remove('confirmed', 'review', 'cancelled', 'on-way', 'delivered');

  // Cancelled after the replacement review — red tag, no timeline, and a
  // dedicated notice explaining what happened (items are back in the cart)
  if (order.cancelled) {
    tagEl.textContent = 'حالة الطلب: ملغي';
    tagEl.classList.add('cancelled');
    timelinePanel.style.display = 'none';
    if (reviewNotice) reviewNotice.style.display = 'none';
    if (cancelNotice) cancelNotice.style.display = 'flex';
  } else if (order.confirmed) {
    // The tag follows the owner's delivery stage instead of staying on
    // «مؤكد» forever — a delivered order must say it is delivered.
    if (order.status === 'delivered') {
      tagEl.textContent = 'حالة الطلب: تم التوصيل';
      tagEl.classList.add('delivered');
    } else if (order.status === 'on_the_way') {
      tagEl.textContent = 'حالة الطلب: قيد التوصيل';
      tagEl.classList.add('on-way');
    } else {
      tagEl.textContent = 'حالة الطلب: مؤكد';
      tagEl.classList.add('confirmed');
    }
    timelinePanel.style.display = '';
    if (reviewNotice) reviewNotice.style.display = 'none';
    if (cancelNotice) cancelNotice.style.display = 'none';
    updateTimeline(order.status || 'preparing');
  } else {
    tagEl.textContent = 'حالة الطلب: يتم المراجعة';
    tagEl.classList.add('review');
    timelinePanel.style.display = 'none';
    if (reviewNotice) reviewNotice.style.display = 'flex';
    if (cancelNotice) cancelNotice.style.display = 'none';
  }

  renderItems(order);
  renderSummary(order);
  showCardHoldNotice(order);
}

/**
 * Card orders only: remind the customer the amount is HELD on their card
 * and is only withdrawn once the store approves the order. Hidden again on
 * re-renders of cash orders (the notice follows the latest order state).
 */
function showCardHoldNotice(order) {
  const notice = document.getElementById('card-hold-notice');
  const amountEl = document.getElementById('card-hold-amount');
  if (!notice || !amountEl) return;

  // The notice is about money that is only RESERVED. Once the store captured
  // it (paid) or released it (voided — cancelled orders), the hold is over and
  // the notice must go: a delivered order kept claiming the amount was still
  // merely held on the card.
  if (!order || order.paymentMethod === 'cash'
      || order.paymentStatus === 'paid' || order.paymentStatus === 'voided') {
    notice.style.display = 'none';
    return;
  }

  amountEl.textContent = Number(order.total || 0).toFixed(2) + ' ر.س';
  notice.style.display = 'flex';
}

/**
 * Render the order items list
 */
async function renderItems(order) {
  // Only the products this order references — never the whole catalog
  const products = await fetchProductsByIds((order.items || []).map((item) => item && item.productId));
  const productById = new Map((products || []).map((p) => [p.id, p]));
  const itemsContainer = document.getElementById('tracking-items');
  itemsContainer.innerHTML = '';

  (order.items || []).forEach((item) => {
    // The product may have left the customer catalog since the order was
    // placed (sold out → hidden for 24 hours, deleted, …). resolveOrderItem
    // falls back to the name/price stored on the order itself, so the item
    // never vanishes from the tracking page.
    const display = resolveOrderItem(item, productById.get(item.productId));
    const price = display.price;
    const li = document.createElement('li');

    let priceHtml = '';
    if (price.hasDiscount) {
      priceHtml = `
        <div class="tracking-item-prices">
          <span class="tracking-item-price-before">${price.original} ر.س</span>
          <span class="tracking-item-price-after">${price.discounted} ر.س</span>
          <span class="tracking-discount-tag">خصم ${price.discountPercent}%</span>
        </div>`;
    } else {
      priceHtml = `<span class="tracking-item-price-after">${price.original} ر.س</span>`;
    }

    li.innerHTML = `
      <div class="tracking-item-img">
        ${display.imageUrl
          ? `<img src="${display.imageUrl}" alt="${display.name}" loading="lazy">`
          : `<span class="material-symbols-outlined">inventory_2</span>`}
      </div>
      <div class="tracking-item-info">
        <h4>${display.name}</h4>
        <span>الكمية: ${item.quantity}</span>
      </div>
      ${priceHtml}
    `;

    itemsContainer.appendChild(li);
  });
}

/**
 * Render the financial summary rows
 */
function renderSummary(order) {
  // Payment method
  const paymentLabels = { card: 'بطاقة ائتمانية', cash: 'الدفع عند الاستلام' };
  document.getElementById('tracking-payment').textContent =
    paymentLabels[order.paymentMethod] || 'بطاقة ائتمانية';

  // Payment state — the customer should always know where their money is.
  // For cash orders this shows that payment happens at the door.
  const PAYMENT_STATE = {
    pending_authorization: 'بانتظار إكمال الدفع',
    authorized: 'محجوز على البطاقة — يُسحب بعد تأكيد المتجر',
    paid: order.paymentMethod === 'cash' ? 'الدفع عند الاستلام' : 'مدفوع',
    voided: 'تم إرجاع المبلغ للبطاقة',
    cash: 'الدفع عند الاستلام'
  };
  const payStateEl = document.getElementById('tracking-payment-status');
  if (payStateEl) {
    payStateEl.textContent = order.paymentMethod === 'cash'
      ? 'الدفع عند الاستلام'
      : (PAYMENT_STATE[order.paymentStatus] || '—');
  }

  // Delivery fee
  const deliveryFee = order.delivery != null ? Number(order.delivery).toFixed(2) : '7.00';
  const deliveryRow = document.getElementById('tracking-delivery');
  if (deliveryRow) deliveryRow.textContent = deliveryFee + ' ر.س';

  // Subtotal
  const subtotalRow = document.getElementById('tracking-subtotal');
  if (subtotalRow && order.subtotal != null) {
    subtotalRow.textContent = Number(order.subtotal).toFixed(2) + ' ر.س';
  }

  // Total
  document.getElementById('tracking-total').textContent =
    Number(order.total || 0).toFixed(2) + ' ر.س';
}

/**
 * Highlight timeline stages up to the current stage
 * @param {string} currentStage - preparing | on_the_way | delivered
 */
function updateTimeline(currentStage) {
  const stages = ['preparing', 'on_the_way', 'delivered'];
  const currentIndex = stages.indexOf(currentStage);

  stages.forEach((stageName, index) => {
    const el = document.getElementById('stage-' + stageName);
    if (!el) return;

    el.classList.remove('done', 'active', 'delivered-green');

    if (index < currentIndex) {
      el.classList.add('done');
    } else if (index === currentIndex) {
      el.classList.add('active');
    }
  });

  // If delivered, make the last stage green
  if (currentStage === 'delivered') {
    const deliveredEl = document.getElementById('stage-delivered');
    if (deliveredEl) {
      deliveredEl.classList.remove('active');
      deliveredEl.classList.add('done', 'delivered-green');
    }
  }
}
