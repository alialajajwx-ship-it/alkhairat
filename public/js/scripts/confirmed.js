// Confirmed page script
// Displays order confirmation with summary.
// The order is read from localStorage first (same session as the checkout)
// with a server fallback so the total still shows after a refresh or when
// the local copy is missing.

import { fetchOrder } from '../data/orders.js';

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('id');

  if (!orderId) {
    document.getElementById('c-order-id').textContent = '-';
    document.getElementById('c-total').textContent = '0 ر.س';
    return;
  }

  let order = fetchOrder(orderId);

  // localStorage miss — try the server (works when logged in)
  if (!order) {
    order = await fetchOrderFromServer(orderId);
  }

  if (!order) {
    document.getElementById('c-order-id').textContent = '#' + orderId;
    return;
  }

  document.getElementById('c-order-id').textContent = '#' + (order.orderId || order.id);
  document.getElementById('c-total').textContent = Number(order.total || 0).toFixed(2) + ' ر.س';

  showCardHoldNotice(order);
});

/**
 * Card orders only: tell the customer the amount is HELD on their card and
 * is only withdrawn after the store approves the order.
 */
function showCardHoldNotice(order) {
  // The hold only exists until the store captures it (paid) or releases it
  // (voided on a cancelled order) — after that the notice would be a lie, so
  // the /confirmed page stays correct even when revisited later.
  if (!order || order.paymentMethod === 'cash'
      || order.paymentStatus === 'paid' || order.paymentStatus === 'voided') return;

  const notice = document.getElementById('card-hold-notice');
  const amountEl = document.getElementById('card-hold-amount');
  if (!notice || !amountEl) return;

  amountEl.textContent = Number(order.total || 0).toFixed(2) + ' ر.س';
  notice.style.display = 'flex';
}

/**
 * Load an order from the server by id (only the user's own orders).
 * Returns null for guests or when the order doesn't exist.
 */
async function fetchOrderFromServer(orderId) {
  try {
    const res = await fetch('/api/my-orders/' + encodeURIComponent(orderId));
    if (!res.ok) return null;
    const data = await res.json();
    return data.order || null;
  } catch {
    return null;
  }
}
