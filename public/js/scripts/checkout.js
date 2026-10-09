// Checkout page script
// Handles cart display, quantity controls, delivery form, and order submission.
// Authentication happens on the dedicated /login page — unauthenticated users
// are redirected there instead of showing a popup.

import {
  getCart,
  getCartWithProducts,
  calculateTotals,
  addToCart,
  removeFromCart,
  clearCart
} from '../data/cart.js';
import { calculatePrice, formatPrice, fetchProductsByIds, getCategoryIcon } from '../data/products.js';
import { createOrder, updateOrder } from '../data/orders.js';

const USER_DATA_KEY = 'alkhairat_user_data';
const PAYMENT_KEY = 'alkhairat_payment_method';
// Real-mode Moyasar return: while the user is away completing 3-D Secure we
// need to know which order to finish when they come back to this page.
const PENDING_PAYMENT_KEY = 'alkhairat_pending_payment';
// The «استلام الفواتير وتفاصيل الطلب عبر رقم الجوال» toggle from the settings
// page (same key settings.js writes; default ON). It decides ONLY whether the
// order-summary (bill) SMS is sent for this order — the site's other SMS are
// never suppressed by it.
const INVOICE_SMS_KEY = 'alkhairat_sms_notifications';

/**
 * Should this order send the customer a bill SMS?
 * Opt-out only: anything but an explicit 'false' means yes.
 */
function invoiceSmsEnabled() {
  try {
    return localStorage.getItem(INVOICE_SMS_KEY) !== 'false';
  } catch {
    return true;
  }
}

let currentUser = null;

// Did /api/me answer normally? When it fails (server down, database down) we
// must NOT treat a logged-in visitor as a guest and bounce them to /login —
// that is what made the checkout page look "broken".
let authCheckOk = true;

// Customer location captured from the browser (optional — only used to
// show a map on the owner's order page). { lat, lng } or null.
let customerLocation = null;

// The saved/default phone for this device or account. A number entered in
// the per-order edit popup is deliberately NOT written here.
let defaultPhone = '';

// Saved addresses loaded from the user's account (for the quick picker)
let savedAddresses = [];

// ─── Init ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Every setup step runs isolated: if ONE of them fails (a slow or failing
  // API, an unexpected storage state), the rest of the page must still work.
  // Without this a single throw here leaves the checkout page rendered but
  // completely dead — no cart, no buttons, nothing responds.
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      console.error('[checkout] setup step "' + name + '" failed:', err);
    }
  };

  await step('checkAuthStatus', checkAuthStatus);
  await step('setupCartListeners', setupCartListeners);
  await step('renderCart', renderCart);
  await step('setupCompleteOrderButton', setupCompleteOrderButton);
  await step('setupSubmitOrderButton', setupSubmitOrderButton);
  await step('setupConfirmOrderButton', setupConfirmOrderButton);
  await step('setupBackToFormButton', setupBackToFormButton);
  await step('setupPaymentOptions', setupPaymentOptions);
  await step('setupFormModal', setupFormModal);
  await step('setupCancelButton', setupCancelButton);
  await step('setupSavedAddressPicker', setupSavedAddressPicker);
  await step('fillSavedAddressSelect', fillSavedAddressSelect);
  await step('loadUserData', loadUserData);
  await step('applyAuthToDeliveryForm', applyAuthToDeliveryForm);
  await step('loadPaymentMethod', loadPaymentMethod);
  await step('setupSafwaBanner', setupSafwaBanner);
  await step('setupLocationCapture', setupLocationCapture);
  await step('setupPhoneEdit', setupPhoneEdit);
  await step('setupAddressTypeSelector', setupAddressTypeSelector);
  await step('setupPaymentClose', setupPaymentClose);
  await step('setupMockCardForm', setupMockCardForm);

  // Real-mode 3-D Secure return: if the URL carries ?order=..., the user is
  // coming back from the bank — resume the authorization polling.
  await step('resumePendingPayment', resumePendingPayment);
});

/**
 * The customer closed the payment gateway without paying. /api/create-payment
 * already saved the order (server-side pricing), but no money was ever held,
 * so the server drops it instead of showing it as a placed order.
 */
function abandonPendingPayment(orderId) {
  let id = null;

  try {
    id = orderId || readPendingPayment()?.orderId || null;
    localStorage.removeItem(PENDING_PAYMENT_KEY);
  } catch {
    // Storage unavailable — the marker is best-effort anyway.
  }
  if (!id) return;

  try {
    // Fire and forget: the UI must never wait on this, and the server also
    // removes abandoned attempts on its own.
    fetch('/api/cancel-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: id })
    }).catch(() => {});
    console.log('[PAYMENT] unpaid order dropped: ' + id);
  } catch {
    // Best effort — the server also removes abandoned attempts on its own.
  }
}

/**
 * Close the payment gateway modal and put the checkout page back into a
 * clean, usable state.
 *
 * Called by the X button (and Esc), so it must NEVER be able to fail: a
 * half-closed modal — overlay still open, page scroll still locked, the
 * انهاء الطلب button still disabled — makes the whole checkout page unusable.
 * Every step is isolated for exactly that reason.
 */
function closePaymentGateway(reason) {
  // Grab the id before clearing the module state
  const orderId = mockOrderId;
  mockOrderId = null;
  mockProcessing = false;

  try {
    console.log('[PAYMENT] gateway closed (' + reason + ')');
    const overlay = document.getElementById('pg-overlay');
    if (overlay) overlay.classList.remove('pg-open');
  } catch {
    // UI cleanup must never throw
  }

  try {
    resetMockCardForm();
    // Restores document scroll as well as hiding the overlay (idempotent)
    hidePaymentWaiting();
  } catch {
    // UI cleanup must never throw
  }

  try {
    // The user can retry with the انهاء الطلب button, which creates a fresh
    // order and a fresh payment attempt.
    const btnConfirm = document.getElementById('btn-confirm-order');
    if (btnConfirm) {
      btnConfirm.disabled = false;
      btnConfirm.textContent = 'انهاء الطلب';
    }
  } catch {
    // UI cleanup must never throw
  }

  // The order created for this payment attempt was never paid, so it must
  // never stay behind as a placed order — drop it on the server.
  abandonPendingPayment(orderId);
}

/**
 * The X button (and Esc) on the payment gateway modal closes it.
 * NEW UI: #pg-overlay / #pg-close (self-contained paygate modal).
 */
function setupPaymentClose() {
  const btn = document.getElementById('pg-close');
  const overlay = document.getElementById('pg-overlay');
  if (!btn || !overlay) {
    console.warn('[PAYMENT] setupPaymentClose: overlay/button not found in DOM');
    return;
  }

  btn.addEventListener('click', () => {
    // While the simulated gateway is processing, closing the modal would
    // desync the flow — same rule as the real gateway.
    if (mockProcessing) return;
    closePaymentGateway('X button');
  });

  // Esc closes the gateway too — the same escape hatch a real gateway has,
  // and a safety net if the X is ever covered by something.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (mockProcessing) return;
    if (!overlay.classList.contains('pg-open')) return;
    closePaymentGateway('Escape');
  });

  // Clicking the dark area around the card closes it as well, so the modal
  // can never trap the user on the checkout page.
  overlay.addEventListener('click', (e) => {
    if (e.target !== overlay) return;
    if (mockProcessing) return;
    closePaymentGateway('backdrop click');
  });
}

// ─── Location Capture (required before حفظ و متابعة) ──────────
// The user must press تفعيل الموقع at least once. If the browser prompt is
// refused (or geolocation is unavailable) the flow may continue WITHOUT the
// coordinates — the user just sees the "غير مفعل" note on the confirm step.
let locationAttempted = false;   // did the user press the button at least once?
let locationEnabled = false;     // did the browser actually give coordinates?

function setupLocationCapture() {
  const enableBtn = document.getElementById('btn-enable-location');
  const spinner = document.getElementById('loc-spinner');

  const setLoading = (on) => {
    if (enableBtn) enableBtn.style.display = on ? 'none' : '';
    if (spinner) spinner.style.display = on ? '' : 'none';
    // While the browser's own prompt is open the note must say we are waiting
    // for the user — it used to keep asking them to «تفعيل الموقع», which read
    // as if their press had been ignored.
    const noteText = document.querySelector('.location-note-text');
    if (noteText && on) noteText.textContent = 'في انتظار ردك على نافذة المتصفح...';
  };

  enableBtn.addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      // No geolocation support — count as "asked and refused"
      locationAttempted = true;
      locationEnabled = false;
      setLoading(false);
      showLocationRefused();
      return;
    }

    // Button disappears, spinner takes its place until the prompt is answered
    setLoading(true);

    const settle = (coords) => {
      locationAttempted = true;
      locationEnabled = !!coords;
      customerLocation = coords || null;
      setLoading(false);
      if (coords) showLocationEnabled();
      else showLocationRefused();
    };

    // NO `timeout` here on purpose. The browser's permission prompt may stay on
    // screen for as long as the user wants, but a timeout clock runs from the
    // moment the request is made — the old 15s cap fired while the prompt was
    // still unanswered, so a user who took their time was reported as a «no»
    // even though they had not said anything yet. Waiting now ends only when
    // the browser really answers: allow → coordinates, deny / position
    // unavailable → the continue-without-location note (still allowed).
    navigator.geolocation.getCurrentPosition(
      (position) => {
        settle({
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6))
        });
      },
      () => {
        // User refused the browser prompt (or it reported a real failure) —
        // continuing is allowed, just without coordinates
        settle(null);
      },
      { enableHighAccuracy: false, maximumAge: 60000 }
    );
  });
}

function showLocationEnabled() {
  document.getElementById('location-note-row').style.display = 'none';
  document.getElementById('location-refused-note').style.display = 'none';
  document.getElementById('location-success-note').style.display = 'flex';
}

function showLocationRefused() {
  // The note row with the enable button disappears once the refusal is shown
  document.getElementById('location-note-row').style.display = 'none';
  document.getElementById('location-success-note').style.display = 'none';
  document.getElementById('location-refused-note').style.display = 'flex';
}

// ─── Safwa Banner ────────────────────────────────────────────

function setupSafwaBanner() {
  // The "التوصيل حاليا فقط في مدينة صفوى" notice must stay visible for the
  // whole checkout session — it is a delivery-coverage warning, not a toast.
  // (It used to auto-hide after 6s.)
  return;
}

// ─── Auth Status ─────────────────────────────────────────────

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user || null;
      authCheckOk = true;
    } else {
      // 5xx (database unreachable) or 401 — we know nothing about the session
      currentUser = null;
      authCheckOk = false;
    }
  } catch {
    currentUser = null;
    authCheckOk = false;
  }
}

/**
 * Lock the phone field to the logged-in user's number.
 * They should never have to type their phone again after registering.
 */
function applyAuthToDeliveryForm() {
  const phoneInput = document.getElementById('input-phone');
  if (!phoneInput || !currentUser) return;

  phoneInput.value = currentUser.phone;
  phoneInput.readOnly = true;
  phoneInput.classList.add('phone-readonly');
  // The account phone is the default; the per-order popup can override the
  // value used for a single order without ever changing this.
  defaultPhone = currentUser.phone;

  const savedData = loadUserDataObject();
  if (!savedData.phone || savedData.phone !== currentUser.phone) {
    saveUserData();
  }

  updateSubmitButton();
}

// ─── Cart Listeners ──────────────────────────────────────────

function setupCartListeners() {
  const cartContainer = document.getElementById('cart-items');
  cartContainer.addEventListener('click', async (e) => {
    const minusBtn = e.target.closest('.qty-minus');
    const plusBtn = e.target.closest('.qty-plus');
    const removeBtn = e.target.closest('.cart-remove-btn');

    // Dedicated delete button — removes the item in one tap regardless of
    // its quantity, so nobody has to hammer the minus button.
    if (removeBtn) {
      await removeFromCart(removeBtn.dataset.productId);
      // Removing an item changes the cart, so the header badge must follow
      window.dispatchEvent(new Event('cart-updated'));
      await renderCart();
      return;
    }

    if (minusBtn) {
      const productId = minusBtn.dataset.productId;
      const cart = getCart();
      const item = cart.find((i) => i.productId === productId);
      if (item && item.quantity > 1) {
        item.quantity -= 1;
        localStorage.setItem('alkhairat_cart', JSON.stringify(cart));
        // Quantity dropped — the header badge count must be re-synced
        window.dispatchEvent(new Event('cart-updated'));
        await renderCart();
      } else {
        await removeFromCart(productId);
        // Item left the cart entirely — same badge re-sync
        window.dispatchEvent(new Event('cart-updated'));
        await renderCart();
      }
    }

    if (plusBtn) {
      const productId = plusBtn.dataset.productId;
      const limit = await getProductQuantityLimit(productId);

      // Block going past the owner-set stock limit
      const cart = getCart();
      const item = cart.find((i) => i.productId === productId);
      const currentQty = item ? item.quantity : 0;
      if (limit !== null && currentQty + 1 > limit) {
        showQuantityLimitPopup(limit);
        return;
      }

      await addToCart(productId);
      window.dispatchEvent(new Event('cart-updated'));
      await renderCart();
    }
  });
}

/**
 * Get the owner-set quantity limit for a product.
 * Returns the number, or null when the product has no limit (unlimited).
 */
async function getProductQuantityLimit(productId) {
  const products = await fetchProductsByIds([productId]);
  const product = (products || []).find((p) => p.id === productId);
  if (!product || product.unlimitedQuantity || product.stockQuantity == null) return null;
  return product.stockQuantity;
}

/**
 * Temporary popup in the middle of the page telling the customer the
 * maximum available quantity for this product.
 */
function showQuantityLimitPopup(limit) {
  // Remove any existing popup first
  const existing = document.getElementById('qty-limit-popup');
  if (existing) existing.remove();

  const popup = document.createElement('div');
  popup.id = 'qty-limit-popup';
  popup.className = 'qty-limit-popup';
  popup.textContent = `الحد المتوفر لهذا المنتج هو ${limit}`;
  document.body.appendChild(popup);

  setTimeout(() => popup.remove(), 2500);
}

// ─── Render Cart ─────────────────────────────────────────────

async function renderCart() {
  const cartContainer = document.getElementById('cart-items');
  const emptyCart = document.getElementById('empty-cart');
  const cartCountEl = document.getElementById('cart-count');
  const btnComplete = document.getElementById('btn-complete-order');

  const items = await getCartWithProducts();

  // The static skeleton rows inside #cart-items (checkout.ejs) have done
  // their job — the cart data is here now, whether it holds items or not.
  // Removal happens AFTER the await so the placeholders stay visible for
  // the whole loading period instead of the page going blank again.
  document.querySelectorAll('#cart-items .cart-skeleton').forEach((el) => el.remove());

  if (items.length === 0) {
    cartContainer.style.display = 'none';
    emptyCart.style.display = 'block';
    cartCountEl.textContent = '0';
    if (btnComplete) btnComplete.style.display = 'none';
    await updateSummary([]);
    return;
  }

  cartContainer.style.display = '';
  emptyCart.style.display = 'none';
  cartCountEl.textContent = items.reduce((sum, item) => sum + item.quantity, 0);

  cartContainer.innerHTML = '';

  items.forEach(({ product, quantity }) => {
    const price = calculatePrice(product);
    const li = document.createElement('li');

    const thumbContent = product.imageUrl
      ? `<img src="${product.imageUrl}" alt="${product.name}">`
      : `<span class="material-symbols-outlined">${getCategoryIcon(product.type)}</span>`;

    const discountTag = price.hasDiscount
      ? `<span class="cart-discount-tag">خصم ${price.discountPercent}%</span>`
      : '';

    const priceDisplay = price.hasDiscount
      ? `<div class="cart-price-line">
          <span class="cart-price-before">${price.original} ر.س</span>
          <span class="cart-price-after">${price.discounted} ر.س</span>
          ${discountTag}
        </div>`
      : `<div class="cart-price-line">
          <span class="cart-price-after">${price.original} ر.س</span>
        </div>`;

    const linePrice = price.hasDiscount
      ? (parseFloat(price.discounted) * quantity).toFixed(2)
      : (parseFloat(price.original) * quantity).toFixed(2);

    li.innerHTML = `
      <div class="cart-thumb">${thumbContent}</div>
      <div class="cart-info">
        <h4>${product.name}</h4>
        ${priceDisplay}
      </div>
      <div class="qty">
        <button class="qty-minus" data-product-id="${product.id}" aria-label="تقليل الكمية">
          <span class="material-symbols-outlined">remove</span>
        </button>
        <span>${quantity}</span>
        <button class="qty-plus" data-product-id="${product.id}" aria-label="زيادة الكمية">
          <span class="material-symbols-outlined">add</span>
        </button>
      </div>
      <div class="line-price">${linePrice} ر.س</div>
      <button class="cart-remove-btn" data-product-id="${product.id}" title="حذف المنتج من السلة" aria-label="حذف المنتج من السلة">
        <span class="material-symbols-outlined">delete</span>
      </button>
    `;

    cartContainer.appendChild(li);
  });

  await updateSummary(items);
}

// ─── Summary ─────────────────────────────────────────────────

async function updateSummary(items) {
  const totals = await calculateTotals();
  document.getElementById('sum-subtotal').textContent = totals.subtotal + ' ر.س';
  document.getElementById('sum-delivery').textContent = totals.delivery + ' ر.س';
  document.getElementById('sum-total').textContent = totals.total + ' ر.س';
}

// ─── Delivery Form Modal ─────────────────────────────────────

function setupFormModal() {
  const overlay = document.getElementById('form-modal-overlay');
  const closeBtn = document.getElementById('form-modal-close');

  closeBtn.addEventListener('click', closeModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (overlay.classList.contains('visible')) closeModal();
      const confirmOverlay = document.getElementById('confirm-overlay');
      if (confirmOverlay && confirmOverlay.classList.contains('visible')) closeConfirm();
    }
  });
}

/**
 * The إلغاء button at the bottom of the delivery form — closes the popup
 * exactly like the X in the corner. Values stay in the inputs (they're
 * never cleared), so reopening restores everything the user typed.
 */
function setupCancelButton() {
  const btnCancel = document.getElementById('btn-cancel-order');
  if (!btnCancel) return;
  btnCancel.addEventListener('click', closeModal);
}

function closeModal() {
  const overlay = document.getElementById('form-modal-overlay');
  const formSection = document.getElementById('delivery-form-section');
  const btnComplete = document.getElementById('btn-complete-order');

  overlay.classList.remove('visible');
  formSection.classList.remove('visible');
  if (btnComplete) btnComplete.style.display = '';
  document.body.style.overflow = '';
}

function closeConfirm() {
  const overlay = document.getElementById('confirm-overlay');
  const section = document.getElementById('confirm-section');
  overlay.classList.remove('visible');
  section.classList.remove('visible');
  document.body.style.overflow = '';
}

function openConfirm() {
  const overlay = document.getElementById('confirm-overlay');
  const section = document.getElementById('confirm-section');

  const name = document.getElementById('input-name').value.trim();
  const phone = document.getElementById('input-phone').value.trim();
  const address = document.getElementById('input-address').value.trim();

  document.getElementById('confirm-name').textContent = name || '-';
  document.getElementById('confirm-phone').textContent = phone || '-';
  document.getElementById('confirm-address').textContent = address || '-';

  // Reflect the location state in the confirmation step
  document.getElementById('confirm-location-row').style.display = customerLocation ? 'flex' : 'none';
  document.getElementById('confirm-location-off-row').style.display = customerLocation ? 'none' : 'flex';

  // When the user asked for location but the browser refused, the note about
  // it appears right next to the "غير مفعل" text (never when location worked
  // or when the user simply hasn't been asked yet).
  const confirmLocNote = document.getElementById('confirm-location-note');
  if (confirmLocNote) {
    confirmLocNote.style.display = (customerLocation || !locationAttempted) ? 'none' : 'block';
  }

  // Reflect the chosen address type (hidden when none was picked)
  const addressType = getAddressType();
  document.getElementById('confirm-address-type-row').style.display = addressType ? 'flex' : 'none';
  if (addressType) document.getElementById('confirm-address-type').textContent = addressType;

  // Payment method the user picked (card ↔ cash toggle is persisted in localStorage)
  const paymentMethod = localStorage.getItem(PAYMENT_KEY) || 'card';
  document.getElementById('confirm-payment').textContent =
    paymentMethod === 'cash' ? 'الدفع عند الاستلام' : 'بطاقة ائتمانية';

  // The items being ordered + totals (same source the cart list uses)
  renderConfirmItems();

  const formOverlay = document.getElementById('form-modal-overlay');
  const formSection = document.getElementById('delivery-form-section');
  formOverlay.classList.remove('visible');
  formSection.classList.remove('visible');

  overlay.classList.add('visible');
  section.classList.add('visible');
  document.body.style.overflow = 'hidden';
}

/**
 * Fills the confirmation popup with the cart items and the order totals.
 * Mirrors the cart list rendering (per-line price, discount tag) so the
 * user sees exactly what they are ordering before confirming.
 */
async function renderConfirmItems() {
  const listEl = document.getElementById('confirm-items');

  try {
    const items = await getCartWithProducts();
    listEl.innerHTML = '';

    if (items.length === 0) {
      listEl.innerHTML = '<li class="confirm-item-empty">السلة فارغة</li>';
    } else {
      items.forEach(({ product, quantity }) => {
        const price = calculatePrice(product);
        const hasDiscount = price.hasDiscount;
        const unit = hasDiscount ? parseFloat(price.discounted) : parseFloat(price.original);

        const priceLine = hasDiscount
          ? `<span class="confirm-item-price">
              <span class="confirm-item-before">${price.original} ر.س</span>
              ${price.discounted} ر.س
            </span>`
          : `<span class="confirm-item-price">${price.original} ر.س</span>`;

        const li = document.createElement('li');
        li.className = 'confirm-item';
        li.innerHTML = `
          <span class="confirm-item-name">${product.name}</span>
          <span class="confirm-item-qty">x${quantity}</span>
          ${priceLine}
          <span class="confirm-item-total">${(unit * quantity).toFixed(2)} ر.س</span>
        `;
        listEl.appendChild(li);
      });
    }

    const totals = await calculateTotals();
    document.getElementById('confirm-subtotal').textContent = totals.subtotal + ' ر.س';
    document.getElementById('confirm-delivery').textContent = totals.delivery + ' ر.س';
    document.getElementById('confirm-total').textContent = totals.total + ' ر.س';
  } catch (err) {
    console.error('Failed to render confirm items:', err);
    listEl.innerHTML = '<li class="confirm-item-empty">تعذر عرض المنتجات</li>';
  }
}

function openModal() {
  const overlay = document.getElementById('form-modal-overlay');
  const formSection = document.getElementById('delivery-form-section');

  overlay.classList.add('visible');
  formSection.classList.add('visible');
  document.body.style.overflow = 'hidden';

  ['input-name', 'input-address'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateSubmitButton);
    }
  });
  // The phone lives in the display field now — keep it in sync with the
  // hidden input every time the popup opens.
  syncPhoneDisplay();

  updateSubmitButton();
}

/**
 * Mirror the hidden phone input into the read-only display field.
 */
function syncPhoneDisplay() {
  const phoneInput = document.getElementById('input-phone');
  const display = document.getElementById('phone-display-value');
  if (!phoneInput || !display) return;
  const value = phoneInput.value.trim();
  display.textContent = value || 'أدخل رقم الجوال';
  display.classList.toggle('empty', !value);
}

// ─── Per-order Phone Edit Popup ─────────────────────────────

function setupPhoneEdit() {
  const overlay = document.getElementById('phone-edit-overlay');
  const section = document.getElementById('phone-edit-section');
  const openBtn = document.getElementById('btn-edit-phone');
  const closeBtn = document.getElementById('phone-edit-close');
  const cancelBtn = document.getElementById('btn-cancel-phone');
  const saveBtn = document.getElementById('btn-save-phone');
  const input = document.getElementById('input-order-phone');
  const errorEl = document.getElementById('phone-edit-error');
  if (!overlay || !section || !openBtn) return;

  const openPopup = () => {
    // Pre-fill with the number currently used for this order
    const phoneInput = document.getElementById('input-phone');
    input.value = phoneInput ? phoneInput.value.trim() : '';
    errorEl.style.display = 'none';
    errorEl.textContent = '';
    overlay.classList.add('visible');
    section.classList.add('visible');
    document.body.style.overflow = 'hidden';
    setTimeout(() => input.focus(), 50);
  };

  const closePopup = () => {
    overlay.classList.remove('visible');
    section.classList.remove('visible');
    // Restore scrolling unless one of the other popups is still open
    const anyOtherOpen =
      document.getElementById('form-modal-overlay').classList.contains('visible') ||
      document.getElementById('confirm-overlay').classList.contains('visible');
    if (!anyOtherOpen) document.body.style.overflow = '';
  };

  openBtn.addEventListener('click', openPopup);
  if (closeBtn) closeBtn.addEventListener('click', closePopup);
  if (cancelBtn) cancelBtn.addEventListener('click', closePopup);

  // Clicking the dark backdrop closes it
  overlay.addEventListener('click', (e) => {
    if (e.target !== overlay) return;
    closePopup();
  });

  // Esc closes it too
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!overlay.classList.contains('visible')) return;
    closePopup();
  });

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  };

  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      // Accept Arabic-Indic digits too, normalize before validating
      const phone = normalizePhoneDigits(input.value).replace(/[^0-9]/g, '').trim();
      input.value = phone;

      if (!/^05\d{8}$/.test(phone)) {
        showError('رقم الهاتف يجب أن يبدأ بـ 05 ويكون 10 أرقام');
        return;
      }

      // This number is for THIS order only: it goes into the hidden input
      // that the order submission reads. It never touches the account phone
      // (that stays read-only server-side) nor the guest's saved defaults.
      const phoneInput = document.getElementById('input-phone');
      if (phoneInput) phoneInput.value = phone;
      syncPhoneDisplay();
      saveUserData();
      updateSubmitButton();
      closePopup();
    });
  }

  // Enter in the input saves
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (saveBtn) saveBtn.click();
    }
  });
}

/**
 * Convert Arabic-Indic digits (٠-٩ ۰-۹) to Latin digits (0-9).
 */
function normalizePhoneDigits(value) {
  return String(value)
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

// ─── Complete Order Button ───────────────────────────────────

function setupCompleteOrderButton() {
  const btnComplete = document.getElementById('btn-complete-order');

  btnComplete.addEventListener('click', async () => {
    const cart = getCart();
    if (cart.length === 0) {
      alert('السلة فارغة. اضف منتجات اولاً.');
      return;
    }

    // Final safety net: block the order if any item exceeds the owner-set
    // quantity limit (e.g. the limit was lowered after the item was added)
    for (const item of cart) {
      const limit = await getProductQuantityLimit(item.productId);
      if (limit !== null && item.quantity > limit) {
        showQuantityLimitPopup(limit);
        return;
      }
    }

    // Store paused by the owner — ordering is disabled site-wide
    if (window.STORE_MAINTENANCE === true) {
      alert('المتجر مغلق مؤقتاً ولا يمكن إتمام الطلب حالياً');
      return;
    }

    // Check if user is authenticated
    await checkAuthStatus();

    if (!currentUser) {
      // The auth check itself failed (server/database unreachable). Sending
      // them to /login would only bounce them around — tell them instead.
      if (!authCheckOk) {
        alert('تعذر الاتصال بالخادم. تحقق من اتصالك بالانترنت وحاول مرة اخرى.');
        return;
      }

      // No popup — send them to the signup page, and come back to
      // checkout after they finish
      window.location.href = '/login?mode=register&redirect=checkout';
      return;
    }

    openModal();
  });
}

// ─── User Data ───────────────────────────────────────────────

function loadUserDataObject() {
  try {
    const raw = localStorage.getItem(USER_DATA_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveUserData() {
  const data = {
    name: document.getElementById('input-name').value.trim(),
    // The DEFAULT phone only — a number typed into the per-order edit popup
    // must never become the saved default (it applies to this order alone).
    phone: defaultPhone,
    address: document.getElementById('input-address').value.trim()
  };
  localStorage.setItem(USER_DATA_KEY, JSON.stringify(data));
}

function loadUserData() {
  const data = loadUserDataObject();
  if (data.name) document.getElementById('input-name').value = data.name;
  if (data.phone) document.getElementById('input-phone').value = data.phone;
  if (data.address) document.getElementById('input-address').value = data.address;
  // Whatever was loaded here IS the default phone for this device
  defaultPhone = document.getElementById('input-phone').value.trim();
}

// ─── Submit Button State ─────────────────────────────────────

function updateSubmitButton() {
  const btn = document.getElementById('btn-submit-order');
  if (!btn) return;

  const name = document.getElementById('input-name').value.trim();
  const phone = document.getElementById('input-phone').value.trim();
  const address = document.getElementById('input-address').value.trim();
  // For logged-in users the phone is pre-filled and read-only, so it always counts
  const allFieldsFilled = name.length > 0 && phone.length > 0 && address.length > 0;

  if (allFieldsFilled) {
    btn.classList.remove('disabled-btn');
  } else {
    btn.classList.add('disabled-btn');
  }
}

// ─── Submit Order Button (حفظ و متابعة) ──────────────────────

function setupSubmitOrderButton() {
  const btnSubmit = document.getElementById('btn-submit-order');

  btnSubmit.addEventListener('click', async () => {
    const name = document.getElementById('input-name').value.trim();
    const phone = document.getElementById('input-phone').value.trim();
    const address = document.getElementById('input-address').value.trim();

    if (!name || !phone || !address) {
      alert('يرجى ملء جميع حقول العنوان');
      return;
    }

    // تفعيل الموقع is required — but only a PRESS is required. If the user
    // pressed and the browser refused the permission, they may continue
    // without coordinates (the confirm step then shows the refusal note).
    if (!locationAttempted) {
      const noteRow = document.getElementById('location-note-row');
      const noteText = document.querySelector('.location-note-text');
      if (noteRow) {
        noteRow.style.display = 'flex';
        noteRow.classList.remove('shake');
        void noteRow.offsetWidth;
        noteRow.classList.add('shake');
      }
      if (noteText) noteText.textContent = 'الرجاء تفعيل الموقع الجغرافي لسهولة التعرف على مكانك';
      if (noteRow) noteRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    saveUserData();
    openConfirm();
  });
}

// ─── Saved Addresses Picker ──────────────────────────────────

/**
 * Show a "choose a saved location" select inside the delivery form when
 * the user has addresses on their account. Guests just never see it.
 */
async function fillSavedAddressSelect() {
  const wrap = document.getElementById('saved-address-picker');
  if (!wrap) return;

  try {
    const res = await fetch('/api/me/addresses');
    if (!res.ok) return; // guest — leave the picker hidden
    const data = await res.json();
    savedAddresses = data.addresses || [];
    if (savedAddresses.length === 0) return;

    const select = document.getElementById('saved-address-select');
    select.innerHTML = '<option value="">اختر عنواناً محفوظاً</option>' +
      savedAddresses.map((a) => '<option value="' + a.id + '">' + a.label + ' — ' + a.address + '</option>').join('');
    wrap.style.display = 'block';
  } catch {
    // Address picking is optional — ignore any failure
  }
}

function setupSavedAddressPicker() {
  const select = document.getElementById('saved-address-select');
  if (!select) return;

  select.addEventListener('change', () => {
    const addr = savedAddresses.find((a) => a.id === select.value);
    if (!addr) return;

    document.getElementById('input-address').value = addr.address;

    // Pre-select the address type when the saved label matches one,
    // otherwise fall back to the custom type with the label pre-filled
    const typeSelect = document.getElementById('input-address-type');
    const typeOption = Array.from(typeSelect.options).find((o) => o.value === addr.label);
    if (typeOption) {
      typeSelect.value = addr.label;
      document.getElementById('address-type-custom-wrap').style.display = 'none';
    } else {
      typeSelect.value = '__custom__';
      document.getElementById('input-address-type-custom').value = addr.label;
      document.getElementById('address-type-custom-wrap').style.display = 'flex';
    }

    saveUserData();
    updateSubmitButton();
  });
}

// ─── Address Type Selector ───────────────────────────────────

function getAddressType() {
  const select = document.getElementById('input-address-type');
  if (!select || !select.value) return null;
  if (select.value === '__custom__') {
    const custom = document.getElementById('input-address-type-custom').value.trim();
    return custom || null;
  }
  return select.value;
}

function setupAddressTypeSelector() {
  const select = document.getElementById('input-address-type');
  const customWrap = document.getElementById('address-type-custom-wrap');

  select.addEventListener('change', () => {
    customWrap.style.display = select.value === '__custom__' ? 'flex' : 'none';
  });
}

/**
 * Save the typed address to the account's saved-addresses list when the
 * user picked a type for it. Silent best-effort — a failure never blocks
 * the order.
 */
async function saveAddressToAccount(name, address) {
  const label = getAddressType();
  if (!label) return;

  try {
    const res = await fetch('/api/me/addresses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, address, isDefault: false })
    });
    if (res.status === 409) {
      // The same label+address is already saved — nothing to do
    }
  } catch {
    // Address saving is optional; ignore any network failure
  }
}

// ─── Confirm Order Button (انهاء الطلب) ──────────────────────

function setupConfirmOrderButton() {
  const btnConfirm = document.getElementById('btn-confirm-order');

  btnConfirm.addEventListener('click', async () => {
    const name = document.getElementById('input-name').value.trim();
    const phone = document.getElementById('input-phone').value.trim();
    const address = document.getElementById('input-address').value.trim();

    const cart = getCart();
    if (cart.length === 0) return;

    btnConfirm.disabled = true;
    btnConfirm.textContent = 'جاري المعالجة...';

    const paymentMethod = localStorage.getItem(PAYMENT_KEY) || 'card';

    try {
      // ─── Cash orders skip Moyasar entirely ───
      if (paymentMethod === 'cash') {
        await placeCashOrder({ cart, name, phone, address });
        return;
      }

      // ─── Card orders: create the payment (order is priced & saved server-side) ───
      const res = await fetch('/api/create-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart,
          paymentMethod,
          customerName: name,
          customerPhone: phone,
          customerAddress: address,
          customerLocation,
          invoiceSms: invoiceSmsEnabled()
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Payment failed');
      }

      const data = await res.json();

      // Nothing is mirrored to localStorage here on purpose: until the
      // payment is authorized this is only a payment ATTEMPT, and a local
      // order copy would make it look like the order was placed (the orders
      // page falls back to that copy). finishOrder() writes the mirror once
      // the payment is actually done.

      // Remember where the user was in the payment flow (survives the
      // 3-D Secure redirect in real mode)
      localStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify({
        orderId: data.orderId,
        paymentMethod,
        customerName: name,
        customerPhone: phone,
        customerAddress: address
      }));

      if (data.mock) {
        // ─── Step 2 (mock): simulated gateway — same UX as the real one ───
        closeConfirm();
        openMockCardForm(data);
        return;
      }

      // ─── Step 2 (real): open the Moyasar form and wait for authorization ───
      closeConfirm();
      initMoyasarForm(data);

      // The redirect back to /checkout?id=<paymentId> continues the flow
      // in resumePendingPayment() below.
    } catch (err) {
      btnConfirm.disabled = false;
      btnConfirm.textContent = 'انهاء الطلب';
      alert(err.message || 'حدث خطأ. حاول مرة اخرى.');
    }
  });
}

/**
 * Cash-on-delivery checkout: no Moyasar involvement. The order is saved via
 * /api/place-order (payment status 'cash') and the user goes straight to the
 * confirmation page.
 */
async function placeCashOrder({ cart, name, phone, address }) {
  const btnConfirm = document.getElementById('btn-confirm-order');

  try {
    const totals = await calculateTotals();
    const res = await fetch('/api/place-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart,
        total: totals.total,
        subtotal: totals.subtotal,
        delivery: totals.delivery,
        paymentMethod: 'cash',
        customerName: name,
        customerPhone: phone,
        customerAddress: address,
        customerLocation,
        invoiceSms: invoiceSmsEnabled()
      })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'فشل إنشاء الطلب');
    }

    const data = await res.json();
    const serverId = data.order?.orderId || data.order?.id;

    // The cash order is complete the moment it is saved — finishOrder()
    // writes the local mirror of it
    finishOrder(serverId, name, address);
  } catch (err) {
    btnConfirm.disabled = false;
    btnConfirm.textContent = 'انهاء الطلب';
    alert(err.message || 'حدث خطأ. حاول مرة اخرى.');
  }
}

// ─── Payment Authorization Polling ───────────────────────────
// Polls /api/verify-payment-status every 2 seconds until the payment is
// authorized (mock mode authorizes instantly; real mode after the webhook).
function pollPaymentAuthorized(paymentId, timeoutMs = 120000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch('/api/verify-payment-status/' + encodeURIComponent(paymentId));
        if (res.ok) {
          const data = await res.json();
          if (data.authorized) return resolve(data);
        }
      } catch {
        // network hiccup — keep polling
      }

      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error('انتهت مهلة التحقق من الدفع'));
      }
      setTimeout(tick, 2000);
    };
    tick();
  });
}

/**
 * Reads the pending-payment marker written when an order is created.
 * @returns {object|null}
 */
function readPendingPayment() {
  try {
    const raw = localStorage.getItem(PENDING_PAYMENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Shows a non-interactive "processing your payment" state so the user knows
 * the authorization is in progress and shouldn't close or refresh the page.
 */
function showPaymentWaiting() {
  const overlay = document.getElementById('pg-overlay');
  const note = document.getElementById('pg-hold-note');
  if (note) note.textContent = 'جاري تأكيد الدفع مع البنك، الرجاء عدم اغلاق الصفحة...';
  if (overlay) overlay.classList.add('pg-open');
  document.body.style.overflow = 'hidden';
}

/**
 * Hides the payment waiting state and restores page scrolling.
 */
function hidePaymentWaiting() {
  const overlay = document.getElementById('pg-overlay');
  if (overlay) overlay.classList.remove('pg-open');
  document.body.style.overflow = '';
}

// ─── Mock Gateway Card Form (mock mode only) ─────────────────
// Mirrors the real Moyasar form so switching to live keys is seamless for
// the user: same fields, same validation feel, same "hold now, capture on
// owner confirmation" behavior. Card data goes to /api/mock/authorize and
// is never stored — the server only logs a PCI-style mask.
let mockProcessing = false;
let mockOrderId = null;

function openMockCardForm({ orderId, amount }) {
  console.log('[PAYMENT] openMockCardForm called, orderId=' + orderId + ', amount=' + amount);

  mockOrderId = orderId;
  mockProcessing = false;

  const overlay = document.getElementById('pg-overlay');
  const note = document.getElementById('pg-hold-note');
  const btnConfirm = document.getElementById('btn-confirm-order');

  if (!overlay) {
    console.error('[PAYMENT] #pg-overlay NOT FOUND in DOM!');
    return;
  }

  // Mock form visible, real Moyasar container hidden
  const mockForm = document.getElementById('pg-mock-form');
  const moyasarMount = document.getElementById('pg-moyasar-mount');
  if (mockForm) mockForm.style.display = '';
  if (moyasarMount) moyasarMount.style.display = 'none';

  if (note) {
    note.textContent =
      'سيتم حجز مبلغ الطلب (' + formatSar(amount) + ') على بطاقتك الآن، ولن يتم سحبه إلا بعد موافقة المتجر على طلبك.';
  }

  resetMockCardForm();

  overlay.classList.add('pg-open');
  document.body.style.overflow = 'hidden';
  console.log('[PAYMENT] gateway modal opened (pg-open class added)');

  // Keep the confirm button disabled while the gateway modal is open — a
  // second click must never create a duplicate order / duplicate hold.
  if (btnConfirm) {
    btnConfirm.disabled = true;
    btnConfirm.textContent = 'بانتظار اكتمال الدفع...';
  }
}

function resetMockCardForm() {
  const form = document.getElementById('pg-mock-form');
  if (!form) return;
  form.reset();
  const err = document.getElementById('pg-error');
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  const payBtn = document.getElementById('pg-pay');
  if (payBtn) { payBtn.disabled = false; payBtn.textContent = 'ادفع الآن'; }
}

function setupMockCardForm() {
  const numberInput = document.getElementById('pg-number');
  const holderInput = document.getElementById('pg-holder');
  const monthInput = document.getElementById('pg-month');
  const yearInput = document.getElementById('pg-year');
  const cvvInput = document.getElementById('pg-cvv');
  const form = document.getElementById('pg-mock-form');

  if (!numberInput || !form) {
    console.warn('[PAYMENT] setupMockCardForm: form fields not found in DOM');
    return;
  }
  console.log('[PAYMENT] mock gateway form wired up');

  // Live formatting as the user types: card grouping (4-4-4-4), exactly like
  // a real gateway form. Arabic-Indic digits (٠-٩ ۰-۹) are normalized to
  // Latin digits on the fly so an Arabic keyboard works naturally.
  numberInput.addEventListener('input', () => {
    const digits = normalizeArabicDigits(numberInput.value).replace(/\D/g, '').slice(0, 19);
    numberInput.value = digits.replace(/(.{4})/g, '$1 ').trim();
  });

  if (holderInput) {
    // Nothing to reformat — the holder name is free text — but the caret
    // must stay in the field (some RTL/LTR mixing pushes focus out).
  }

  if (monthInput) {
    // Accept BOTH 1-digit and 2-digit months: "3" and "03" are both March.
    // The value is normalised to MM only when the card is submitted.
    monthInput.addEventListener('input', () => {
      let v = normalizeArabicDigits(monthInput.value).replace(/\D/g, '').slice(0, 2);
      // Auto-advance to the year once the month is unambiguous:
      // a 2-digit value (03) or a single digit 2-9 (which can only be that month).
      if (yearInput && (v.length === 2 || (v.length === 1 && v >= '2'))) {
        const mm = parseInt(v, 10);
        if (mm >= 1 && mm <= 12) yearInput.focus();
      }
      monthInput.value = v;
    });
    // Backspace on an empty month goes back to the card number
    monthInput.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !monthInput.value && numberInput) {
        numberInput.focus();
      }
    });
  }

  if (yearInput) {
    // Accept BOTH 2-digit and 4-digit years: "28" and "2028" are the same.
    yearInput.addEventListener('input', () => {
      let v = normalizeArabicDigits(yearInput.value).replace(/\D/g, '').slice(0, 4);
      // Only jump to the CVV once a full 4-digit year is typed — jumping at
      // 2 digits would make it impossible to type 2028.
      if (v.length === 4 && cvvInput) cvvInput.focus();
      yearInput.value = v;
    });
    yearInput.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !yearInput.value && monthInput) {
        monthInput.focus();
      }
    });
  }

  if (cvvInput) {
    cvvInput.addEventListener('input', () => {
      cvvInput.value = normalizeArabicDigits(cvvInput.value).replace(/\D/g, '').slice(0, 4);
    });
  }

  form.addEventListener('submit', onMockCardSubmit);
}

/**
 * Convert Arabic-Indic digits (٠-٩ ۰-۹) to Latin digits (0-9) so users with
 * an Arabic keyboard can type their card details naturally.
 */
function normalizeArabicDigits(value) {
  return String(value)
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

async function onMockCardSubmit(e) {
  e.preventDefault();
  if (mockProcessing || !mockOrderId) return;
  console.log('[PAYMENT] mock card submitted for order ' + mockOrderId);

  const errBox = document.getElementById('pg-error');
  const payBtn = document.getElementById('pg-pay');
  const showError = (msg) => {
    errBox.textContent = msg;
    errBox.style.display = 'block';
    payBtn.disabled = false;
    payBtn.textContent = 'ادفع الآن';
  };

  const cardNumber = normalizeArabicDigits(document.getElementById('pg-number').value).replace(/\s/g, '');
  const cardHolder = document.getElementById('pg-holder').value.trim();
  const monthValue = normalizeArabicDigits((document.getElementById('pg-month') || {}).value || '').replace(/\D/g, '');
  const yearValue = normalizeArabicDigits((document.getElementById('pg-year') || {}).value || '').replace(/\D/g, '');
  const cvv = normalizeArabicDigits(document.getElementById('pg-cvv').value).replace(/\D/g, '');

  errBox.style.display = 'none';

  // Client-side validation mirroring the server checks
  if (cardNumber.length < 12 || !/^\d+$/.test(cardNumber))
    return showError('الرجاء إدخال رقم بطاقة صحيح.');
  if (cardHolder.length < 2)
    return showError('الرجاء إدخال اسم حامل البطاقة.');
  // Month: 1 or 2 digits accepted ("3" → 03)
  const monthNum = parseInt(monthValue, 10);
  if (!(monthNum >= 1 && monthNum <= 12))
    return showError('شهر الانتهاء يجب أن يكون بين 1 و 12.');
  // Year: 2 digits (28) or 4 digits (2028) accepted; always sent as YY
  // because the server validates an MM/YY expiry.
  if (!/^(\d{2}|\d{4})$/.test(yearValue))
    return showError('سنة الانتهاء يجب أن تكون رقمين أو أربعة أرقام.');
  if (!/^\d{3,4}$/.test(cvv))
    return showError('الرجاء إدخال رمز CVV الصحيح.');

  const year2 = yearValue.length === 4 ? yearValue.slice(2) : yearValue;
  const expiry = String(monthNum).padStart(2, '0') + '/' + year2;

  mockProcessing = true;
  payBtn.disabled = true;
  payBtn.textContent = 'جاري التحقق من البطاقة...';

  try {
    const res = await fetch('/api/mock/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: mockOrderId, cardNumber, cardHolder, expiry, cvv })
    });
    const data = await res.json();

    if (!res.ok) {
      mockProcessing = false;
      return showError(data.error || 'تم رفض البطاقة. حاول مرة اخرى.');
    }

    console.log('[PAYMENT] hold authorized, paymentId=' + data.paymentId);
    payBtn.textContent = 'تم حجز المبلغ بنجاح';

    // Same finish path as the real gateway: poll (instant here) → confirm
    const pending = readPendingPayment();
    await pollPaymentAuthorized(data.paymentId);
    const name = pending?.customerName || '';
    const address = pending?.customerAddress || '';
    finishOrder(mockOrderId, name, address);
  } catch {
    mockProcessing = false;
    showError('حدث خطأ أثناء الاتصال بالبوابة. حاول مرة اخرى.');
  }
}

function formatSar(value) {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toFixed(2) + ' ر.س';
}

// ─── Moyasar Web SDK (real mode) ─────────────────────────────
// Opens the card modal. manual: true means Moyasar only AUTHORIZES (holds)
// the money — capture happens when the owner accepts the order.
function initMoyasarForm({ publishableKey, amountHalalas, description, orderId, paymentId }) {
  console.log('[PAYMENT] initMoyasarForm (real mode) called, orderId=' + orderId);
  const overlay = document.getElementById('pg-overlay');
  const btnConfirm = document.getElementById('btn-confirm-order');

  // Keep the confirm button disabled while the card modal is open — a second
  // click must never create a duplicate order / duplicate payment hold.
  btnConfirm.disabled = true;
  btnConfirm.textContent = 'بانتظار اكتمال الدفع...';

  if (typeof Moyasar === 'undefined' || !publishableKey) {
    alert('تعذر تحميل بوابة الدفع. حاول مرة اخرى.');
    return;
  }

  overlay.classList.add('pg-open');
  document.body.style.overflow = 'hidden';
  console.log('[PAYMENT] gateway modal opened (real mode)');

  // Hide the mock form so only the official Moyasar form shows
  const mockForm = document.getElementById('pg-mock-form');
  if (mockForm) mockForm.style.display = 'none';

  Moyasar.init({
    element: '#pg-moyasar-mount',
    amount: amountHalalas,
    currency: 'SAR',
    description,
    publishable_api_key: publishableKey,
    language: 'ar',
    // The user is redirected back to checkout with ?payment_id=... —
    // resumePendingPayment() then polls until the webhook marks it authorized
    callback_url: window.location.origin + '/checkout?order=' + encodeURIComponent(orderId),
    supported_networks: ['mada', 'visa', 'mastercard'],
    methods: ['creditcard'],
    credit_card: {
      manual: true // AUTHORIZATION ONLY — owner captures on acceptance
    },
    metadata: { orderId },
    on_completed: async (payment) => {
      // Save the payment id on our order immediately (before 3-D Secure)
      try {
        await fetch('/api/attach-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId, paymentId: payment.id })
        });
      } catch {
        // The callback_url return flow also links the payment — non-fatal
      }

      // Non-3DS cards complete inline (no page redirect) — start polling
      // here so the checkout finishes right away. 3DS cards are redirected
      // to the bank instead, and resumePendingPayment() covers those.
      const pending = readPendingPayment();
      if (pending && pending.orderId === orderId) {
        showPaymentWaiting();
        try {
          await pollPaymentAuthorized(payment.id);
          finishOrder(orderId, pending.customerName, pending.customerAddress);
        } catch {
          // Authorization failed or timed out — let the user retry from the form
          hidePaymentWaiting();
          alert('لم يتم تأكيد الدفع. حاول مرة اخرى أو اختر طريقة دفع اخرى.');
        }
      }
    }
  });
}

/**
 * Real mode 3-D Secure return: /checkout?order=... after the user completes
 * the bank authentication. Wait for the webhook to mark the payment
 * authorized, then finish the order exactly like mock mode does.
 */
async function resumePendingPayment() {
  const raw = localStorage.getItem(PENDING_PAYMENT_KEY);
  if (!raw) return false;

  let pending;
  try {
    pending = JSON.parse(raw);
  } catch {
    // Corrupted marker — drop it instead of throwing on page load
    localStorage.removeItem(PENDING_PAYMENT_KEY);
    return false;
  }
  if (!pending || typeof pending !== 'object') {
    localStorage.removeItem(PENDING_PAYMENT_KEY);
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('order');
  if (!orderId || orderId !== pending.orderId) return false;

  // Clean the URL so refresh doesn't re-trigger the flow
  window.history.replaceState({}, '', '/checkout');

  try {
    // We don't know the payment id client-side — poll the order status via
    // the payment id stored on the order (attach-payment saved it earlier)
    // Fallback: poll by orderId through the same endpoint using the id the
    // on_completed callback saved. If neither exists yet, wait for webhook.
    const attached = await waitForPaymentId(orderId);
    if (!attached) throw new Error('لم يتم العثور على عملية الدفع');

    await pollPaymentAuthorized(attached);
    finishOrder(orderId, pending.customerName, pending.customerAddress);
    return true;
  } catch {
    localStorage.removeItem(PENDING_PAYMENT_KEY);
    return false;
  }
}

/**
 * The payment id lives server-side on the order. Probe verify-payment-status
 * with the id returned by Moyasar's redirect (?payment_id=...) first, then
 * fall back to asking the backend for the order's payment id.
 */
async function waitForPaymentId(orderId) {
  const params = new URLSearchParams(window.location.search);
  const fromRedirect = params.get('payment_id');
  if (fromRedirect) return fromRedirect;

  // Ask the backend: the order's paymentId was saved by on_completed
  try {
    const res = await fetch('/api/orders/' + encodeURIComponent(orderId) + '/payment-id');
    if (res.ok) {
      const data = await res.json();
      if (data.paymentId) return data.paymentId;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Shared finish (payment authorized / cash saved): mirror the order locally,
 * save the address, clear the cart + pending marker, and go to the
 * confirmation page.
 */
async function finishOrder(orderId, name, address) {
  const id = await mirrorOrderLocally(orderId, name, address);
  saveAddressToAccount(name, address);
  clearCart();
  localStorage.removeItem(PENDING_PAYMENT_KEY);
  window.location.href = '/confirmed?id=' + id;
}

/**
 * Write the localStorage mirror of a COMPLETED order (the orders page reads
 * the server first and only falls back to this copy). It must never run for
 * an order that was not paid yet — that is what makes an abandoned card form
 * look like a placed order.
 * @returns {Promise<string|undefined>} the order id to redirect with
 */
async function mirrorOrderLocally(orderId, name, address) {
  try {
    const cart = getCart();
    if (!cart.length) return orderId;

    const pending = readPendingPayment();
    const totals = await calculateTotals();
    const local = createOrder({
      items: cart,
      total: parseFloat(totals.total),
      subtotal: parseFloat(totals.subtotal),
      delivery: parseFloat(totals.delivery),
      paymentMethod: pending?.paymentMethod || localStorage.getItem(PAYMENT_KEY) || 'card',
      customerName: name || pending?.customerName || '',
      customerPhone: pending?.customerPhone || '',
      customerAddress: address || pending?.customerAddress || ''
    });

    // Re-key the local order to the server-assigned orderId
    const id = orderId || local.id;
    updateOrder(local.id, { id, serverId: id });
    return id;
  } catch {
    // The mirror is a convenience only — never block the confirmation page
    return orderId;
  }
}

// ─── Back to Form Button ─────────────────────────────────────

function setupBackToFormButton() {
  const btnBack = document.getElementById('btn-back-to-form');

  btnBack.addEventListener('click', () => {
    closeConfirm();
    openModal();
  });
}

// ─── Payment Options ─────────────────────────────────────────

function loadPaymentMethod() {
  try {
    const saved = localStorage.getItem(PAYMENT_KEY);
    if (saved === 'cash') {
      const payCards = document.querySelectorAll('.pay-card');
      payCards.forEach((c) => {
        c.classList.remove('active');
        const check = c.querySelector('.check');
        if (check) check.remove();
      });
      const cashCard = payCards[1];
      if (cashCard) {
        cashCard.classList.add('active');
        const checkIcon = document.createElement('span');
        checkIcon.className = 'material-symbols-outlined check';
        checkIcon.textContent = 'check_circle';
        cashCard.appendChild(checkIcon);
      }
    }
  } catch {
    // ignore
  }
}

function setupPaymentOptions() {
  const payCards = document.querySelectorAll('.pay-card');
  payCards.forEach((card, index) => {
    card.addEventListener('click', () => {
      payCards.forEach((c) => {
        c.classList.remove('active');
        const check = c.querySelector('.check');
        if (check) check.remove();
      });
      card.classList.add('active');
      const checkIcon = document.createElement('span');
      checkIcon.className = 'material-symbols-outlined check';
      checkIcon.textContent = 'check_circle';
      card.appendChild(checkIcon);

      localStorage.setItem(PAYMENT_KEY, index === 0 ? 'card' : 'cash');
    });
  });
}
