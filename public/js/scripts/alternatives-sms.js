// Alternatives SMS page script (owner only)
// The owner reviewed the order's availability on the alternatives page and
// pressed التالي to land here. The page shows the pre-built message to the
// customer with the suggested browsing link and a per-item availability
// summary. Sending it:
//   - everything available  → the order is confirmed normally
//   - any low/unavailable   → the order is cancelled + items return to cart

// The customer-facing message is three blocks separated by one BLANK line,
// so a long link never runs into the sentence the customer is reading:
//   greeting
//   <blank>
//   one line per low/unavailable item
//   <blank>
//   the suggested-items link
const DEFAULT_GREETING =
  'مرحباً بك، بعض المنتجات التي طلبتها غير متوفرة حالياً، يرجى مراجعة الرابط لاختيار بدائل مناسبة لك.';
const BLOCK_SEPARATOR = '\n\n';

// Used when every one of the customer's own items turned out available: the
// server CONFIRMS such an order, so the message must not talk about missing
// products.
const CONFIRM_MESSAGE_TEMPLATE = (orderId) =>
  `مرحباً بك، تم تأكيد طلبك ${orderId} وسيتم تجهيزه الآن وسيصلك في أقرب وقت ممكن.`;

const STATE_AVAILABLE = 'available';
const STATE_LOW = 'low';
const STATE_UNAVAILABLE = 'unavailable';

import { normalizeProductName } from '../data/products.js';

// Page state
let order = null;
let review = null; // { orderId, replacements: [...], markedAt }
// Product names marked متوفر by the owner — carried to /browse as ?item= so
// the customer sees them first. These are normally the ALTERNATIVE products
// the owner picked for the items that turned out unavailable, so they are
// not part of the order itself.
let suggestedNames = [];
let currentMessage = '';
let isEdited = false;
let confirmAction = null; // the pending action while the popup is open

const nameEl = document.getElementById('alt-order-id');
const previewEl = document.getElementById('alt-message-preview');
const editEl = document.getElementById('alt-message-edit');
const doneBtn = document.getElementById('alt-done-btn');
const editBtn = document.getElementById('alt-edit-btn');
const resetBtn = document.getElementById('alt-reset-btn');
const sendBtn = document.getElementById('alt-send-btn');
const cancelBtn = document.getElementById('alt-cancel-btn');
const cancelHint = document.getElementById('alt-cancel-hint');
const backLink = document.getElementById('alt-back-link');
const overlay = document.getElementById('alt-confirm-overlay');
const confirmTitle = document.getElementById('alt-confirm-title');
const confirmPreview = document.getElementById('alt-confirm-preview');
const confirmYes = document.getElementById('alt-confirm-yes');
const confirmNo = document.getElementById('alt-confirm-no');

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('order');

  if (!orderId) {
    nameEl.textContent = 'غير معروف';
    sendBtn.disabled = true;
    return;
  }

  backLink.href = '/alternatives?replacement=1&order=' + encodeURIComponent(orderId);

  // Load the order and the parked replacement review in parallel
  try {
    const [orderRes, reviewRes] = await Promise.all([
      fetch('/api/admin/orders/' + encodeURIComponent(orderId)),
      fetch('/api/admin/replacements/' + encodeURIComponent(orderId))
    ]);

    if (orderRes.ok) {
      const data = await orderRes.json();
      order = data.order || null;
    }
    if (reviewRes.ok) {
      const data = await reviewRes.json();
      review = data.replacements || null;
    }
  } catch {
    // treated as missing below
  }

  if (!order) {
    nameEl.textContent = '#' + orderId;
    sendBtn.disabled = true;
    alert('لم يتم العثور على الطلب.');
    return;
  }

  if (order.cancelled) {
    nameEl.textContent = order.orderId || order.id;
    sendBtn.disabled = true;
    sendBtn.textContent = 'تم إلغاء هذا الطلب مسبقاً';
    cancelHint.style.display = 'none';
    return;
  }

  nameEl.textContent = order.orderId || order.id;

  // The order is the source of truth for names and quantities (the owner
  // may have marked items that are no longer part of the order, and the
  // order keeps the exact "طلبك كان X" numbers)
  const orderItems = new Map(
    (order.items || []).map((item) => [item.productId, item])
  );
  const allMarks = (review && review.replacements || []).map((r) => {
    const item = orderItems.get(r.productId);
    return item
      ? { ...r, name: normalizeProductName(item.name || r.name), ordered: item.quantity }
      : { ...r, name: normalizeProductName(r.name) };
  });

  // The SMS summary only talks about the customer's own items...
  const replacements = allMarks.filter((r) => orderItems.has(r.productId));

  // ...while every product marked متوفر (usually an alternative the owner
  // picked) is offered to the customer on top of the browse page
  suggestedNames = dedupeNames(
    allMarks.filter((r) => r.state === STATE_AVAILABLE).map((r) => r.name)
  );

  review = { orderId: order.orderId, replacements, markedAt: new Date().toISOString() };

  const hasProblem = replacements.some(
    (r) => r.state === STATE_LOW || r.state === STATE_UNAVAILABLE
  );

  if (hasProblem) {
    cancelBtn.style.display = '';
    cancelHint.style.display = 'block';
  }

  currentMessage = buildDefaultMessage(order, replacements);
  renderPreview();
  setupEditing();
  setupActions();
}

/**
 * Build the default SMS, one block per line group:
 *   greeting
 *   blank line
 *   "منتج: متوفر 3 فقط (طلبك كان 6)" / "منتج: غير متوفر" (one per line)
 *   blank line
 *   the browse link
 */
function buildDefaultMessage(order, replacements) {
  // Nothing is missing → sending from this page confirms the order
  const hasProblemItem = replacements.some(
    (r) => r.state === STATE_LOW || r.state === STATE_UNAVAILABLE
  );
  if (!hasProblemItem) return CONFIRM_MESSAGE_TEMPLATE(order.orderId);

  const link =
    window.location.origin +
    '/browse?completedOrder=false&order=' + encodeURIComponent(order.orderId) +
    (suggestedNames.length
      ? '&' + suggestedNames.map((name) => 'item=' + encodeURIComponent(name)).join('&')
      : '');

  const summary = replacements
    .filter((r) => r.state !== STATE_AVAILABLE)
    .map((r) => r.state === STATE_LOW
      ? `${r.name}: متوفر ${r.available} فقط (طلبك كان ${r.ordered})`
      : `${r.name}: غير متوفر`)
    .join('\n');

  return [DEFAULT_GREETING, summary, link]
    .filter((block) => block)
    .join(BLOCK_SEPARATOR);
}

/** Unique, non-empty names, keeping the owner's marking order */
function dedupeNames(names) {
  const seen = new Set();
  return (names || []).filter((name) => {
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/**
 * Render a message body, turning any http(s) link inside it into a real,
 * tappable anchor. The message carries the customer's suggested-items link,
 * and the owner must be able to open it straight from the preview. The
 * confirm popup shows the very same body, so both go through here.
 *
 * The text is escaped BEFORE the links are added: the body can be edited by
 * the owner, and innerHTML must never let markup through.
 * @param {HTMLElement} el
 * @param {string} message
 */
function renderMessageBody(el, message) {
  const escaped = String(message == null ? '' : message)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  el.innerHTML = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

function renderPreview() {
  renderMessageBody(previewEl, currentMessage);
  previewEl.style.display = '';
  editEl.style.display = 'none';
  doneBtn.style.display = 'none';
  editBtn.style.display = '';
  resetBtn.style.display = isEdited ? '' : 'none';
}

function startEditing() {
  previewEl.style.display = 'none';
  editEl.value = currentMessage;
  editEl.style.display = '';
  doneBtn.style.display = '';
  editBtn.style.display = 'none';
  resetBtn.style.display = 'none';
  editEl.focus();
}

function finishEditing() {
  const newValue = editEl.value.trim();
  if (!newValue) return;
  currentMessage = newValue;
  isEdited = newValue !== buildDefaultMessage(order, review.replacements);
  renderPreview();
}

function setupEditing() {
  editBtn.addEventListener('click', startEditing);
  doneBtn.addEventListener('click', finishEditing);

  resetBtn.addEventListener('click', () => {
    openConfirm(
      'هل انت متأكد انك تريد إرجاع هذه الرسالة؟',
      buildDefaultMessage(order, review.replacements),
      () => {
        currentMessage = buildDefaultMessage(order, review.replacements);
        isEdited = false;
        renderPreview();
      }
    );
  });
}

function setupActions() {
  sendBtn.addEventListener('click', () => {
    openConfirm('هل تريد إرسال هذه الرسالة؟', currentMessage, sendAlternativesSms);
  });

  cancelBtn.addEventListener('click', () => {
    openConfirm(
      'هل تريد إلغاء الطلب وإرجاع المنتجات المتوفرة إلى سلة العميل؟',
      currentMessage,
      cancelOrder
    );
  });

  confirmYes.addEventListener('click', () => {
    if (typeof confirmAction === 'function') confirmAction();
  });
  confirmNo.addEventListener('click', closeConfirm);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeConfirm();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeConfirm();
  });
}

function openConfirm(title, message, action) {
  confirmTitle.textContent = title;
  // Same body as the preview — the link stays tappable here too
  renderMessageBody(confirmPreview, message);
  confirmAction = action;
  overlay.classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closeConfirm() {
  confirmAction = null;
  overlay.classList.remove('visible');
  document.body.style.overflow = '';
}

async function sendAlternativesSms() {
  await submitDecision(
    '/api/admin/orders/' + encodeURIComponent(order.orderId) + '/alternatives-sms',
    { message: currentMessage }
  );
}

async function cancelOrder() {
  await submitDecision(
    '/api/admin/orders/' + encodeURIComponent(order.orderId) + '/cancel',
    {}
  );
}

/**
 * POST a decision to the server, report the outcome, and navigate back to
 * the order page. The server returns { cancelled } so the owner knows which
 * path was taken.
 */
async function submitDecision(url, body) {
  confirmYes.disabled = true;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      alert(data.error || 'حدث خطأ. حاول مرة أخرى.');
      return;
    }

    closeConfirm();
    if (data.cancelled) {
      alert('تم إلغاء الطلب وإرسال الرسالة للعميل، وأُرجعت المنتجات المتوفرة إلى سلة العميل.');
    } else {
      alert('تم إرسال الرسالة وتأكيد الطلب بنجاح.');
    }
    window.location.href = '/customer-order?id=' + encodeURIComponent(order.orderId);
  } catch {
    alert('خطأ في الاتصال بالخادم. حاول مرة أخرى.');
  } finally {
    confirmYes.disabled = false;
  }
}
