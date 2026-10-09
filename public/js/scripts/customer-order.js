// Customer order details page (owner only)
// Loads the order from the server (MongoDB), lets the owner update the
// delivery stage and confirm the order by sending an SMS to the customer

import { fetchProductsByIds, resolveOrderItem } from '../data/products.js';
import { fetchOwnerProducts } from '../data/owner-products.js';

const paymentLabels = { card: 'بطاقة ائتمانية', cash: 'الدفع عند الاستلام' };

// Payment state shown on the owner's order page
const PAYMENT_STATE_LABELS = {
  pending_authorization: 'بانتظار إكمال الدفع',
  authorized: 'محجوز على البطاقة',
  paid: 'مدفوع',
  voided: 'تم إرجاع المبلغ للبطاقة',
  cash: 'دفع عند الاستلام'
};

const STAGE_LABELS = {
  preparing: 'يتم التجهيز',
  on_the_way: 'قيد التوصيل',
  delivered: 'تم التوصيل'
};

let currentOrder = null;

// SMS message state
let currentMessage = '';
let isEdited = false;

function getDefaultMessage(name) {
  return `مرحباً ${name}، تم تأكيد طلبك وسيتم تجهيزه الآن وسيصلك في أقرب وقت ممكن، تأكد من إبقاء جوالك بالقرب منك لأن سيصلك اتصال عند اقتراب وصول طلبك`;
}

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('id');

  if (!orderId) {
    document.getElementById('order-id').textContent = 'غير معروف';
    showContent();
    return;
  }

  const order = await loadOrder(orderId);
  if (!order) {
    document.getElementById('order-id').textContent = '#' + orderId;
    showContent();
    return;
  }

  currentOrder = order;

  const products = await loadOrderProducts(order);

  // Order ID
  document.getElementById('order-id').textContent = order.orderId || order.id;

  // Order date
  const orderDate = new Date(order.orderTime);
  document.getElementById('order-date').textContent = orderDate.toLocaleDateString('ar-SA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Order total
  document.getElementById('order-total').textContent = (order.total || 0).toFixed(2) + ' ر.س';

  // Status pill + stage buttons
  renderStatus();
  renderStageButtons();
  setupStageButtons();
  updateStageLock();

  // Customer info
  document.getElementById('customer-name').textContent = order.customerName || '-';
  document.getElementById('customer-phone').textContent = order.customerPhone || '-';
  document.getElementById('customer-address').textContent = order.customerAddress || '-';

  // Customer location map (only when the customer shared their location)
  renderCustomerLocation(order.customerLocation);

  // Financial summary
  document.getElementById('sum-subtotal').textContent = order.subtotal != null ? Number(order.subtotal).toFixed(2) + ' ر.س' : '- ر.س';
  document.getElementById('sum-delivery').textContent = (order.delivery != null ? order.delivery.toFixed(2) : '7.00') + ' ر.س';
  document.getElementById('sum-payment').textContent = paymentLabels[order.paymentMethod] || 'بطاقة ائتمانية';

  const payStateEl = document.getElementById('sum-payment-status');
  if (payStateEl) {
    payStateEl.textContent = PAYMENT_STATE_LABELS[order.paymentStatus] || '—';
  }
  document.getElementById('sum-total').textContent = (order.total || 0).toFixed(2) + ' ر.س';

  // Owner confirm panel
  setupConfirmPanel();

  // Replacement review link → owner browsing page pre-flagged with this
  // order (hidden once the order is confirmed or cancelled)
  const reviewLink = document.getElementById('btn-review-replacements');
  if (reviewLink) {
    const orderKey = order.orderId || order.id;
    if (order.confirmed || order.cancelled) {
      reviewLink.closest('.panel').style.display = 'none';
    } else {
      // Carry the order's item names so the alternatives page can offer the
      // «المنتجات المقترحة» view (the products the customer actually ordered)
      const itemParams = (order.items || [])
        .filter((item) => item && item.name)
        .map((item) => '&item=' + encodeURIComponent(item.name))
        .join('');
      reviewLink.href =
        '/alternatives?replacement=1&order=' + encodeURIComponent(orderKey) + itemParams;
    }
  }

  // Render order items
  await renderItems(order, products);

  // Everything is on the page — drop the loading skeleton
  showContent();
});

/**
 * The catalog used to resolve the order's items.
 *
 * The OWNER catalog is preferred: unlike /api/products it still contains the
 * hidden and deleted products, which is exactly what this page is about —
 * the owner reviews items that may have just left the customer catalog (a
 * «غير متوفر» mark hides a product, a sold-out product hides itself for 24h).
 * The customer catalog is only the fallback when that request fails.
 */
async function loadOrderProducts(order) {
  const ids = (order.items || []).map((item) => item && item.productId);
  const ownerProducts = await fetchOwnerProducts(true, ids);
  if (ownerProducts.length) return ownerProducts;
  return fetchProductsByIds(ids);
}

/**
 * Swap the loading skeleton for the real content. Called on every terminal
 * path (order loaded, order missing, no id in the URL) so the skeleton never
 * stays on screen covering an empty page.
 */
function showContent() {
  const skeleton = document.getElementById('od-skeleton');
  const grid = document.getElementById('od-grid');
  if (skeleton) skeleton.style.display = 'none';
  if (grid) grid.style.display = '';
}

/**
 * Show the embedded Google Map of the customer's shared location.
 * Hides the whole panel when the customer did not share a location.
 * @param {{ lat: number, lng: number }|null} location
 */
function renderCustomerLocation(location) {
  const panel = document.getElementById('location-panel');
  if (!panel) return;

  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
    panel.style.display = 'none';
    return;
  }

  const { lat, lng } = location;
  const mapEl = document.getElementById('customer-map');
  // No API key needed: the free embed endpoint centers on the coordinates
  // with a pin exactly at the customer's location
  mapEl.innerHTML =
    '<iframe title="موقع العميل" ' +
    'src="https://maps.google.com/maps?q=' + lat + ',' + lng + '&z=16&output=embed" ' +
    'loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>';

  document.getElementById('map-open-link').href =
    'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng;

  panel.style.display = 'block';
}

/**
 * Load the order from the server API (all orders live in MongoDB).
 * Falls back to localStorage only for legacy orders that were never saved
 * to the database (placed before accounts existed).
 */
async function loadOrder(orderId) {
  try {
    const res = await fetch('/api/admin/orders/' + encodeURIComponent(orderId));
    if (res.ok) {
      const data = await res.json();
      if (data.order) return data.order;
    }
  } catch {
    // fall through to localStorage
  }

  // Legacy fallback: order only exists in this browser's localStorage
  const { fetchOrder } = await import('../data/orders.js');
  return fetchOrder(orderId);
}

// ─── Status & Stages ─────────────────────────────────────────

function renderStatus() {
  const statusPill = document.getElementById('order-status');
  const statusText = document.getElementById('order-status-text');

  // Cancelled after the replacement review — show it in red everywhere
  if (currentOrder.cancelled) {
    statusText.textContent = 'ملغي';
    statusPill.style.background = 'rgba(178, 58, 46, 0.12)';
    statusPill.style.color = 'var(--brick)';
    const icon = statusPill.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = 'cancel';
    return;
  }

  if (!currentOrder.confirmed) {
    statusText.textContent = 'يتم المراجعة';
    statusPill.style.background = 'rgba(192, 138, 46, 0.15)';
    statusPill.style.color = 'var(--amber)';
    return;
  }

  statusText.textContent = STAGE_LABELS[currentOrder.status] || currentOrder.status;

  if (currentOrder.status === 'delivered') {
    statusPill.style.background = 'rgba(60, 122, 84, 0.14)';
    statusPill.style.color = 'var(--green)';
  } else if (currentOrder.status === 'on_the_way') {
    statusPill.style.background = '#E3F2FD';
    statusPill.style.color = '#1565C0';
  } else {
    statusPill.style.background = 'rgba(192, 138, 46, 0.15)';
    statusPill.style.color = 'var(--amber)';
  }
}

function renderStageButtons() {
  document.querySelectorAll('.stage-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.stage === currentOrder.status);
  });
}

/**
 * The owner can only move the delivery stage after the confirmation SMS was
 * sent — before that the buttons are disabled and a hint explains why.
 * Cancelled orders are locked out entirely.
 */
function updateStageLock() {
  const locked = !currentOrder.confirmed || currentOrder.cancelled;
  document.querySelectorAll('.stage-btn').forEach((btn) => {
    btn.disabled = locked;
  });
  const hint = document.getElementById('stage-lock-hint');
  if (hint) {
    hint.style.display = locked ? 'flex' : 'none';
    if (currentOrder.cancelled) {
      hint.textContent = 'هذا الطلب ملغي — لا يمكن تحديث مراحله.';
    }
  }
}

let pendingStage = null;

function setupStageButtons() {
  const overlay = document.getElementById('stage-confirm-overlay');
  const title = document.getElementById('stage-confirm-title');
  const yesBtn = document.getElementById('btn-stage-yes');

  document.getElementById('stage-buttons').addEventListener('click', (e) => {
    const btn = e.target.closest('.stage-btn');
    if (!btn || !currentOrder) return;
    if (btn.dataset.stage === currentOrder.status) return; // already active

    // Ask before changing anything
    pendingStage = btn.dataset.stage;
    title.textContent = 'هل تريد تحديث حالة الطلب إلى "' + STAGE_LABELS[pendingStage] + '"؟';
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
  });

  document.getElementById('btn-stage-cancel').addEventListener('click', closeStagePopup);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeStagePopup();
  });

  yesBtn.addEventListener('click', async () => {
    if (!pendingStage) return;
    yesBtn.disabled = true;
    try {
      const res = await fetch(
        '/api/admin/orders/' + encodeURIComponent(currentOrder.orderId || currentOrder.id) + '/stage',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: pendingStage })
        }
      );

      if (res.ok) {
        const data = await res.json();
        currentOrder = data.order;
        renderStatus();
        renderStageButtons();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'حدث خطأ أثناء تحديث الحالة. حاول مرة أخرى.');
      }
    } catch {
      // network error — leave the state as it was
      alert('خطأ في الاتصال بالخادم. حاول مرة أخرى.');
    } finally {
      yesBtn.disabled = false;
      closeStagePopup();
    }
  });

  // Escape closes the stage popup too
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeStagePopup();
  });
}

function closeStagePopup() {
  pendingStage = null;
  document.getElementById('stage-confirm-overlay').classList.remove('visible');
  document.body.style.overflow = '';
}

// ─── Order Items ─────────────────────────────────────────────

async function renderItems(order, products) {
  const itemsList = document.getElementById('items-list');
  const productById = new Map((products || []).map((p) => [p.id, p]));

  for (const item of order.items || []) {
    // An item whose product is no longer in the customer catalog (sold out →
    // hidden for 24 hours, deleted, …) must still be listed here: this is the
    // page the owner reviews availability from, so a missing row would hide
    // exactly the items that need reviewing. resolveOrderItem falls back to
    // the name/price stored on the order itself.
    const display = resolveOrderItem(item, productById.get(item.productId));
    const product = { name: display.name, imageUrl: display.imageUrl };
    const price = display.price;
    const quantity = item.quantity || 1;

    // Unit price display
    let priceHtml = '';
    if (price.hasDiscount) {
      priceHtml = `
        <span class="item-price-before">${price.original} ر.س</span>
        <span class="item-price">${price.discounted} ر.س</span>
      `;
    } else {
      priceHtml = `<span class="item-price">${price.original} ر.س</span>`;
    }

    // Line total
    const lineTotal = price.hasDiscount
      ? (parseFloat(price.discounted) * quantity).toFixed(2)
      : (parseFloat(price.original) * quantity).toFixed(2);

    // Discount tag
    const discountTag = price.hasDiscount
      ? `<span class="item-discount-tag">خصم ${price.discountPercent}%</span>`
      : '';

    const li = document.createElement('li');
    li.innerHTML = `
      <div class="item-thumb">
        ${product.imageUrl
          ? `<img src="${product.imageUrl}" alt="${product.name}" loading="lazy">`
          : `<span class="material-symbols-outlined">inventory_2</span>`}
      </div>
      <div class="item-info">
        <h4>${product.name}</h4>
        ${discountTag}
        <span class="item-qty">الكمية: ${quantity}</span>
        <div class="item-price-row">
          ${priceHtml}
        </div>
      </div>
      <div class="item-total">
        <span class="s-label">المجموع</span>
        <span class="s-value">${lineTotal} ر.س</span>
      </div>
    `;

    itemsList.appendChild(li);
  }
}

// ─── Confirm Order + SMS Popup Flow ──────────────────────────

function setupConfirmPanel() {
  const btnConfirm = document.getElementById('btn-confirm-order');
  const confirmOverlay = document.getElementById('sms-confirm-overlay');
  const resetOverlay = document.getElementById('sms-reset-overlay');

  // Already confirmed — show the done state
  if (currentOrder.confirmed) {
    btnConfirm.style.display = 'none';
    document.getElementById('owner-confirm-done').style.display = 'flex';
  }

  // Cancelled — the confirm/review flow is finished, say so instead
  if (currentOrder.cancelled) {
    btnConfirm.style.display = 'none';
    document.getElementById('owner-confirm-done').style.display = 'flex';
    document.getElementById('owner-confirm-done').innerHTML =
      '<span class="material-symbols-outlined">cancel</span> تم إلغاء هذا الطلب وإرسال رسالة البدائل للعميل';
  }

  btnConfirm.addEventListener('click', () => {
    currentMessage = getDefaultMessage(currentOrder.customerName || '');
    isEdited = false;
    openConfirmPopup();
  });

  // ── Confirm popup buttons ──
  document.getElementById('btn-sms-cancel').addEventListener('click', closeConfirmPopup);
  confirmOverlay.addEventListener('click', (e) => {
    if (e.target === confirmOverlay) closeConfirmPopup();
  });

  document.getElementById('btn-sms-yes').addEventListener('click', handleConfirmSend);

  // ── Edit message ──
  document.getElementById('btn-edit-msg').addEventListener('click', startEditing);
  document.getElementById('btn-done-edit').addEventListener('click', finishEditing);

  // ── Reset to default message ──
  document.getElementById('btn-reset-msg').addEventListener('click', openResetPopup);
  document.getElementById('btn-reset-cancel').addEventListener('click', () => {
    resetOverlay.classList.remove('visible');
  });
  resetOverlay.addEventListener('click', (e) => {
    if (e.target === resetOverlay) resetOverlay.classList.remove('visible');
  });
  document.getElementById('btn-reset-yes').addEventListener('click', () => {
    currentMessage = getDefaultMessage(currentOrder.customerName || '');
    isEdited = false;
    resetOverlay.classList.remove('visible');
    renderConfirmPopup();
  });

  // Close popups with Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeConfirmPopup();
      resetOverlay.classList.remove('visible');
    }
  });
}

function openConfirmPopup() {
  renderConfirmPopup();
  document.getElementById('sms-confirm-overlay').classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closeConfirmPopup() {
  document.getElementById('sms-confirm-overlay').classList.remove('visible');
  document.body.style.overflow = '';
}

/**
 * Render the confirm popup in view mode (not editing)
 */
function renderConfirmPopup() {
  const overlay = document.getElementById('sms-confirm-overlay');

  overlay.classList.remove('editing');
  document.getElementById('sms-message-preview').textContent = currentMessage;
  document.getElementById('sms-message-preview').style.display = '';
  document.getElementById('sms-message-edit').style.display = 'none';
  document.getElementById('btn-done-edit').style.display = 'none';
  document.getElementById('btn-edit-msg').style.display = '';
  document.getElementById('btn-reset-msg').style.display = isEdited ? '' : 'none';
  document.getElementById('btn-sms-yes').disabled = false;
  document.getElementById('btn-sms-yes').textContent = 'نعم';
}

function startEditing() {
  const overlay = document.getElementById('sms-confirm-overlay');

  overlay.classList.add('editing');
  document.getElementById('sms-message-preview').style.display = 'none';
  const textarea = document.getElementById('sms-message-edit');
  textarea.value = currentMessage;
  textarea.style.display = '';
  document.getElementById('btn-done-edit').style.display = '';
  document.getElementById('btn-edit-msg').style.display = 'none';
  document.getElementById('btn-reset-msg').style.display = 'none';
  textarea.focus();
}

function finishEditing() {
  const textarea = document.getElementById('sms-message-edit');
  const newValue = textarea.value.trim();

  if (!newValue) return;

  currentMessage = newValue;
  isEdited = newValue !== getDefaultMessage(currentOrder.customerName || '');
  renderConfirmPopup();
}

function openResetPopup() {
  document.getElementById('default-message-preview').textContent =
    getDefaultMessage(currentOrder.customerName || '');
  document.getElementById('sms-reset-overlay').classList.add('visible');
}

async function handleConfirmSend() {
  const yesBtn = document.getElementById('btn-sms-yes');

  yesBtn.disabled = true;
  yesBtn.textContent = 'جاري الارسال...';

  try {
    const res = await fetch('/api/confirm-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: currentOrder.customerPhone,
        message: currentMessage,
        orderId: currentOrder.orderId || currentOrder.id
      })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'حدث خطأ أثناء إرسال الرسالة. حاول مرة أخرى.');
      yesBtn.disabled = false;
      yesBtn.textContent = 'نعم';
      return;
    }

    // The server marked the order confirmed in MongoDB; mirror it locally
    // so the UI reflects the new state immediately
    currentOrder.confirmed = true;

    closeConfirmPopup();

    // Update UI — confirming also unlocks the stage buttons
    renderStatus();
    renderStageButtons();
    updateStageLock();
    document.getElementById('btn-confirm-order').style.display = 'none';
    document.getElementById('owner-confirm-done').style.display = 'flex';
  } catch {
    alert('خطأ في الاتصال بالخادم. حاول مرة أخرى.');
    yesBtn.disabled = false;
    yesBtn.textContent = 'نعم';
  }
}
