// Store chatbot widget (المساعد الآلي)
//
// A floating launcher on every page (bottom-right) that shakes once for 1.1s
// on load and shows «تحدث مع المساعد الآلي» for 3s. Opening it shows a chat
// panel in the middle of the page.
//
// The widget is only usable while logged in — window.IS_AUTHENTICATED is
// published by partials/header.ejs. Guests see a sign-in prompt instead.

import { addToCart, removeFromCart } from '../data/cart.js';

const AUTHENTICATED = window.IS_AUTHENTICATED === true;

// Auth pages (/login) must not show the launcher: the assistant needs a signed
// in session and its bubble would sit on top of the login form.
const AUTH_PATHS = ['/login'];
const pathname = ((window.location && window.location.pathname) || '/').replace(/\/+$/, '') || '/';
const IS_AUTH_PAGE = AUTH_PATHS.includes(pathname);

// Conversation kept for the request context (last few turns). The server also
// trims it, but keeping it small here saves tokens on every round trip.
const MAX_HISTORY = 8;

// The server answers within its own budget (~30s); this is the outer safety net
// so the UI can never wait forever on a stalled connection.
const REQUEST_TIMEOUT_MS = 45000;
// If the answer takes longer than this, tell the customer we're still working.
const SLOW_HINT_MS = 6000;

let history = [];
let open = false;
let sending = false;
let usage = null;

// ─── DOM ─────────────────────────────────────────────────────
const el = {};

function build() {
  const wrap = document.createElement('div');
  wrap.id = 'chatbot-root';

  wrap.innerHTML = `
    <button class="chat-launcher" id="chat-launcher" aria-label="المساعد الآلي" title="المساعد الآلي">
      <span class="material-symbols-outlined">smart_toy</span>
    </button>
    <div class="chat-tooltip" id="chat-tooltip" role="status">تحدث مع المساعد الآلي</div>

    <div class="chat-overlay" id="chat-overlay"></div>
    <div class="chat-panel" id="chat-panel" role="dialog" aria-modal="true" aria-label="المساعد الآلي">
      <div class="chat-header">
        <div class="chat-header-icon"><span class="material-symbols-outlined">smart_toy</span></div>
        <div class="chat-header-text">
          <strong>المساعد الآلي</strong>
          <span>مساعد بقالة الخيرات</span>
        </div>
        <button class="chat-close" id="chat-close" aria-label="إغلاق">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="chat-messages" id="chat-messages"></div>

      <div class="chat-suggestions" id="chat-suggestions"></div>

      <div class="chat-usage" id="chat-usage"></div>

      <div class="chat-input-row">
        <textarea class="chat-input" id="chat-input" rows="1" maxlength="1000"
                  placeholder="اكتب سؤالك هنا..."></textarea>
        <button class="chat-send" id="chat-send" aria-label="إرسال">
          <span class="material-symbols-outlined">send</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(wrap);

  el.launcher = document.getElementById('chat-launcher');
  el.tooltip = document.getElementById('chat-tooltip');
  el.overlay = document.getElementById('chat-overlay');
  el.panel = document.getElementById('chat-panel');
  el.close = document.getElementById('chat-close');
  el.messages = document.getElementById('chat-messages');
  el.suggestions = document.getElementById('chat-suggestions');
  el.usage = document.getElementById('chat-usage');
  el.input = document.getElementById('chat-input');
  el.send = document.getElementById('chat-send');
}

// ─── Rendering helpers ───────────────────────────────────────

function scrollDown() {
  if (el.messages) el.messages.scrollTop = el.messages.scrollHeight;
}

function addMessage(text, who = 'bot') {
  const div = document.createElement('div');
  div.className = `chat-msg ${who}`;
  div.textContent = text;
  el.messages.appendChild(div);
  scrollDown();
  return div;
}

function addNote(text) {
  const div = document.createElement('div');
  div.className = 'chat-note';
  div.textContent = text;
  el.messages.appendChild(div);
  scrollDown();
}

function showTyping() {
  const div = document.createElement('div');
  div.className = 'chat-typing';
  div.id = 'chat-typing';
  div.innerHTML = '<i></i><i></i><i></i>';
  el.messages.appendChild(div);
  scrollDown();
}

function hideTyping() {
  const t = document.getElementById('chat-typing');
  if (t) t.remove();
  const hint = document.getElementById('chat-slow-hint');
  if (hint) hint.remove();
}

function showSlowHint() {
  if (!el.messages || document.getElementById('chat-slow-hint')) return;
  const div = document.createElement('div');
  div.className = 'chat-note';
  div.id = 'chat-slow-hint';
  div.textContent = 'ما زال المساعد يكتب الرد... شكراً لصبرك.';
  el.messages.appendChild(div);
  scrollDown();
}

/**
 * Render a product the assistant looked up / wants to act on.
 * `mode` is 'info' (just show it) or 'add' (show a confirm button).
 */
function addProductCard(product, mode = 'info') {
  const card = document.createElement('div');
  card.className = 'chat-product';

  const img = document.createElement('img');
  img.src = product.imageUrl || '';
  img.alt = product.name;
  img.loading = 'lazy';
  img.onerror = () => { img.style.visibility = 'hidden'; };

  const info = document.createElement('div');
  info.className = 'cp-info';

  const name = document.createElement('div');
  name.className = 'cp-name';
  // Mixed Arabic + Latin names (e.g. «صانسيلك شامبو 400ml») must keep the
  // Latin run at the end; without this the bidi algorithm can flip it.
  name.setAttribute('dir', 'auto');
  name.textContent = product.name;

  const price = document.createElement('div');
  price.className = 'cp-price';
  if (product.discountPercent) {
    price.innerHTML = `${product.finalPriceLabel}<s>${product.priceLabel}</s>`;
  } else {
    price.textContent = product.priceLabel;
  }

  const stock = document.createElement('div');
  stock.className = 'cp-stock';
  stock.textContent = product.inStock
    ? (product.unlimited ? 'متوفر' : `متوفر — ${product.availableQuantity} متاح`)
    : 'غير متوفر حالياً';

  info.append(name, price, stock);
  card.append(img, info);

  const wrapper = document.createElement('div');
  wrapper.appendChild(card);

  if (mode === 'add' && product.inStock) {
    const actions = document.createElement('div');
    actions.className = 'chat-product-actions';

    const yes = document.createElement('button');
    yes.className = 'chat-mini-btn';
    yes.innerHTML = '<span class="material-symbols-outlined">add_shopping_cart</span> نعم، أضفه إلى السلة';

    const no = document.createElement('button');
    no.className = 'chat-mini-btn ghost';
    no.textContent = 'لا، شكراً';

    yes.addEventListener('click', () => {
      const added = addToCart(product.id);
      const qty = (added.find((i) => i.productId === product.id) || {}).quantity || 1;
      yes.disabled = true;
      no.disabled = true;
      actions.remove();
      addNote(`تمت إضافة «${product.name}» إلى السلة (الكمية: ${qty}).`);
      if (typeof window.updateCartBadge === 'function') window.updateCartBadge();
    });

    no.addEventListener('click', () => {
      yes.disabled = true;
      no.disabled = true;
      actions.remove();
      addNote('تمام، لم أضف شيئاً.');
    });

    actions.append(yes, no);
    wrapper.appendChild(actions);
  }

  el.messages.appendChild(wrapper);
  scrollDown();
  return wrapper;
}

function addRemoveCard(product) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-product-actions';

  const btn = document.createElement('button');
  btn.className = 'chat-mini-btn';
  btn.innerHTML = '<span class="material-symbols-outlined">remove_shopping_cart</span> احذفه من السلة';
  btn.addEventListener('click', () => {
    removeFromCart(product.id);
    btn.disabled = true;
    addNote(`تم حذف «${product.name}» من السلة.`);
    if (typeof window.updateCartBadge === 'function') window.updateCartBadge();
  });

  wrapper.appendChild(btn);
  el.messages.appendChild(wrapper);
  scrollDown();
}

// ─── Usage / limit UI ────────────────────────────────────────

function renderUsage() {
  if (!el.usage) return;
  if (!AUTHENTICATED) { el.usage.textContent = ''; return; }
  if (!usage) { el.usage.textContent = ''; return; }
  el.usage.textContent = usage.remaining > 0
    ? `متبقٍ لك ${usage.remaining} من ${usage.limit} رسالة خلال 24 ساعة`
    : 'وصلت الحد الأقصى للمساعد الآلي (40 رسالة كل 24 ساعة).';
}

function lockInput() {
  if (el.input) el.input.disabled = true;
  if (el.send) el.send.disabled = true;
}

// ─── The guest state ─────────────────────────────────────────

const SUGGESTIONS = [
  'كيف أضيف منتجاً إلى السلة؟',
  'كيف أحذف منتجاً من سلتي؟',
  'كيف أتابع حالة طلبي؟',
  'هل هذا المنتج متوفر؟'
];

function renderSuggestions() {
  if (!el.suggestions) return;
  el.suggestions.innerHTML = '';
  if (!AUTHENTICATED || (usage && usage.remaining <= 0)) return;
  SUGGESTIONS.forEach((text) => {
    const chip = document.createElement('button');
    chip.className = 'chat-chip';
    chip.textContent = text;
    chip.addEventListener('click', () => {
      el.input.value = text;
      send();
    });
    el.suggestions.appendChild(chip);
  });
}

function renderGuest() {
  el.messages.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'chat-locked';
  box.innerHTML = `
    <span class="material-symbols-outlined">lock</span>
    المساعد الآلي متاح للعملاء المسجّلين فقط.
    سجّل الدخول لتتمكن من السؤال عن المنتجات وإدارة سلتك.
  `;
  const link = document.createElement('a');
  link.className = 'btn btn-primary';
  link.href = '/login';
  link.textContent = 'تسجيل الدخول';
  box.appendChild(link);
  el.messages.appendChild(box);

  el.input.placeholder = 'سجّل الدخول لاستخدام المساعد';
  lockInput();
  renderSuggestions();
}

// ─── Sending a message ───────────────────────────────────────

async function send() {
  if (sending || !AUTHENTICATED) return;
  const text = String(el.input.value || '').trim();
  if (!text) return;

  sending = true;
  el.input.value = '';
  el.input.style.height = 'auto';
  el.send.disabled = true;

  addMessage(text, 'user');
  history.push({ role: 'user', content: text });
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);

  showTyping();
  const slowTimer = setTimeout(showSlowHint, SLOW_HINT_MS);
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        page: window.location.pathname,
        history: history.slice(0, -1)
      }),
      signal: controller.signal
    });

    const data = await res.json().catch(() => ({}));
    clearTimeout(slowTimer);
    clearTimeout(timeoutTimer);
    hideTyping();

    if (!res.ok) {
      addMessage(data.error || 'تعذّر الوصول للمساعد الآلي الآن. جرّب مرة أخرى.', 'bot');
      if (res.status === 429) {
        usage = { limit: data.limit || 40, used: data.used || 40, remaining: 0 };
        renderUsage();
        renderSuggestions();
        lockInput();
      }
      sending = false;
      el.send.disabled = false;
      return;
    }

    addMessage(data.reply, 'bot');
    history.push({ role: 'assistant', content: data.reply });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);

    // Products the assistant looked up: shown as image cards (URLs from the
    // database only — the model never sees the images themselves)
    (data.products || []).forEach((product) => addProductCard(product, 'info'));

    // Cart actions the assistant proposed
    (data.actions || []).forEach((action) => {
      const product = (data.products || []).find((p) => p.id === action.productId);
      if (!product) return;
      if (action.type === 'add') addProductCard(product, 'add');
      if (action.type === 'remove') addRemoveCard(product);
    });

    if (data.usage) {
      usage = data.usage;
      renderUsage();
      renderSuggestions();
      if (usage.remaining <= 0) lockInput();
    }
  } catch (err) {
    clearTimeout(slowTimer);
    clearTimeout(timeoutTimer);
    hideTyping();
    addMessage(
      err && err.name === 'AbortError'
        ? 'تأخر رد المساعد أكثر من المتوقع. أعد إرسال رسالتك أو جرّب سؤالاً أقصر.'
        : 'تعذّر الاتصال بالخادم. تأكد من اتصالك بالإنترنت وحاول مرة أخرى.',
      'bot'
    );
  }

  sending = false;
  if (!el.input.disabled) el.send.disabled = false;
}

// ─── Open / close ────────────────────────────────────────────

function openPanel() {
  open = true;
  el.overlay.classList.add('open');
  el.panel.classList.add('open');
  document.body.style.overflow = 'hidden';
  el.tooltip.classList.remove('show');
  setTimeout(() => { if (el.input && !el.input.disabled) el.input.focus(); }, 220);
}

function closePanel() {
  open = false;
  el.overlay.classList.remove('open');
  el.panel.classList.remove('open');
  document.body.style.overflow = '';
}

// ─── Boot ────────────────────────────────────────────────────

async function fetchUsage() {
  if (!AUTHENTICATED) return;
  try {
    const res = await fetch('/api/chat/usage');
    if (!res.ok) return;
    const data = await res.json();
    usage = data;
    renderUsage();
    renderSuggestions();
    if (usage.remaining <= 0) lockInput();
  } catch {
    // usage is best-effort; the server enforces the limit regardless
  }
}

function init() {
  if (IS_AUTH_PAGE) return;

  build();

  el.launcher.addEventListener('click', openPanel);
  el.close.addEventListener('click', closePanel);
  el.overlay.addEventListener('click', closePanel);

  el.send.addEventListener('click', send);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  el.input.addEventListener('input', () => {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 110) + 'px';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) closePanel();
  });

  // One-time attention shake + tooltip
  el.launcher.classList.add('shake');
  el.launcher.addEventListener('animationend', () => el.launcher.classList.remove('shake'), { once: true });
  setTimeout(() => el.tooltip.classList.add('show'), 120);
  setTimeout(() => el.tooltip.classList.remove('show'), 3120);

  if (!AUTHENTICATED) {
    renderGuest();
    return;
  }

  // A short, page-aware welcome so the assistant feels present from the start
  const path = window.location.pathname;
  const welcome = path === '/orders'
    ? 'أهلاً! أنا مساعد الخيرات. تريد متابعة أحد طلباتك؟ اضغط «التفاصيل والتتبع» بجانب الطلب في هذه الصفحة، أو اسألني عن أي شيء.'
    : path === '/browse'
      ? 'أهلاً! أنا مساعد الخيرات. اسألني عن أي منتج أو عن طريقة الطلب، أو اطلب مني إضافة منتج إلى سلتك.'
      : path === '/checkout'
        ? 'أهلاً! أنا مساعد الخيرات. تحتاج مساعدة في إتمام الطلب أو في طريقة الدفع؟'
        : 'أهلاً! أنا مساعد الخيرات. اسألني عن المنتجات، أو طريقة الطلب والدفع، أو أي شيء في الموقع.';

  addMessage(welcome, 'bot');
  renderSuggestions();
  fetchUsage();

  // Keep the cart badge in sync if the assistant changes the cart
  window.addEventListener('cart-updated', () => {
    if (typeof window.updateCartBadge === 'function') window.updateCartBadge();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Exported for the headless UI test (harmless in the browser)
export { build, addMessage, addProductCard, renderSuggestions, SUGGESTIONS };
