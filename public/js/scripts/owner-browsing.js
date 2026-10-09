// Alternatives page script (owner product management)
// Loads the catalog from the API, renders cards with a single edit button,
// search + filters (same pattern as the customer browse page), and the
// edit modal for quantity / visibility / delete.

import {
  fetchOwnerProducts,
  updateProductQuantity,
  updateProductDiscount,
  updateProductPrice,
  hideProduct,
  unhideProduct,
  deleteProduct,
  updateProductReplacement
} from '../data/owner-products.js';
import { CATEGORY_TYPES, normalizeProductName } from '../data/products.js';
import { renderPager } from './pager.js';

// How many owner cards are put in the DOM at a time. The catalog can hold
// thousands of products now, and rendering all of them at once is what makes
// the page freeze — the filters still operate on the whole catalog.
const OWNER_PAGE_SIZE = 24;

let allProducts = [];
let filteredProducts = [];
let currentPage = 1;
let currentType = 'all';
let currentStock = 'active'; // default view: everything in the catalog
let currentDiscount = 'any'; // 'any' | 'on'
let currentPriceRange = null; // null | 'under10' | '10to30' | 'over30'
let currentSearch = '';
let editingId = null;
// Visibility the edit modal was PREFILLED with, so saving an untouched form
// never hides the product again (see saveEdit)
let originalVisibility = null;
// Debounce handle shared by the product search and the category search
let searchTimeout = null;
// The catalog is shuffled once, on first load, so the owner opens on a random
// selection instead of the same order every time (see reload).
let catalogShuffled = false;

/**
 * The category the filter actually uses.
 *
 * Search and the category list override each other — the LAST filtering action
 * wins. While the search box has text the selected category is ignored; once
 * the box is emptied the category applies again.
 */
function effectiveType() {
  return currentSearch ? 'all' : currentType;
}

/** Fisher–Yates shuffle (returns a new array; the input is not mutated) */
function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Fold Arabic text so the category search is forgiving: lowercase, drop the
 * diacritics/tatweel, and unify the alef / ya / ta-marbuta variants.
 */
function normalizeArabic(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .trim();
}

/** Highlight the category row the query actually uses (none while searching) */
function reflectCategorySelection() {
  const list = document.getElementById('category-filters');
  if (!list) return;
  const searching = !!currentSearch;
  list.querySelectorAll('li').forEach((li) => {
    li.classList.toggle('active', !searching && li.dataset.type === currentType);
  });
}

/** Filter the category list itself as the owner types */
function setupCategorySearch() {
  const input = document.getElementById('category-search');
  const list = document.getElementById('category-filters');
  if (!input || !list) return;

  input.addEventListener('input', () => {
    const term = normalizeArabic(input.value);
    list.querySelectorAll('li').forEach((li) => {
      if (li.dataset.type === 'all') return; // «جميع المنتجات» always stays
      const label = normalizeArabic(li.dataset.type || li.textContent);
      li.style.display = !term || label.includes(term) ? '' : 'none';
    });
  });
}

// ─── Replacement review mode ─────────────────────────────────
// Active when the owner arrives from a customer's order page via the
// مراجعة توفر المنتجات button. Instead of تعديل each card shows three
// state buttons, and a التالي bar leads to the alternatives-SMS page.
const reviewParams = new URLSearchParams(window.location.search);
const reviewOrderId = reviewParams.get('order');
const REVIEW_MODE = reviewParams.get('replacement') === '1' && !!reviewOrderId;
// productId → { state, ordered, available }
const reviewMarks = new Map();
// The reviewed order's items: productId → { name, quantity } (from the API)
const orderItemsById = new Map();
// 'suggested' shows only the order's items; 'all' shows the whole catalog.
// Defaults to 'all' (owner request): the owner lands on the full catalog.
let reviewView = 'all';
// Product names from the URL ?item= params (fallback suggestion list)
const replacementItems = reviewParams.getAll('item');

document.addEventListener('DOMContentLoaded', init);

// The keyword-row helpers are also exercised by the headless UI test, which
// drives them without a full page (see scripts/test-add-product-ui.mjs).
export { resetKeywordRows, addKeywordRow, removeKeywordRow, collectKeywords };

async function init() {
  if (REVIEW_MODE) setupReplacementMode();

  await reload();

  setupSearch();
  setupCategorySearch();
  setupFilters();
  setupGridActions();
  setupEditModal();
  setupDeleteModal();
  setupAddModal();
  if (REVIEW_MODE) setupReviewModals();
}

// ─── Replacement mode setup ──────────────────────────────────

function setupReplacementMode() {
  // Banner + back arrow + التالي bar; hide owner-catalog tools that make
  // no sense while reviewing an order
  document.getElementById('replacement-banner').style.display = 'flex';
  document.getElementById('replacement-order-id').textContent = reviewOrderId;
  document.getElementById('replacement-back').style.display = 'flex';
  document.getElementById('replacement-back').href =
    '/customer-order?id=' + encodeURIComponent(reviewOrderId);
  document.getElementById('replacement-next-bar').style.display = 'block';
  document.getElementById('replacement-tools').style.display = 'flex';
  // Reserve space for the fixed التالي bar (see syncNextBarSpacing)
  syncNextBarSpacing();
  window.addEventListener('resize', syncNextBarSpacing);
  document.getElementById('add-product-btn').style.display = 'none';
  document.getElementById('deleted-link-btn').style.display = 'none';

  // Load the parked review (the owner may have marked things earlier and
  // pressed عودة to come back for more) and the order itself (exact item
  // quantities for the "طلبت X" hints and the SMS summary)
  Promise.all([
    fetch('/api/admin/replacements/' + encodeURIComponent(reviewOrderId))
      .then((r) => (r.ok ? r.json() : { replacements: null })),
    fetch('/api/admin/orders/' + encodeURIComponent(reviewOrderId))
      .then((r) => (r.ok ? r.json() : { order: null }))
  ])
    .then(([reviewData, orderData]) => {
      const items = (orderData.order && orderData.order.items) || [];
      items.forEach((item) => {
        orderItemsById.set(item.productId, {
          name: normalizeProductName(item.name),
          quantity: item.quantity
        });
      });

      (reviewData.replacements && reviewData.replacements.replacements || []).forEach((r) => {
        const ordered = orderItemsById.get(r.productId);
        reviewMarks.set(r.productId, {
          state: r.state,
          ordered: ordered ? ordered.quantity : r.ordered,
          available: r.available
        });
      });
      applyFilters();
    })
    .catch(() => applyFilters());

  // عرض الكل / المنتجات المقترحة toggle (starts on عرض الكل)
  document.getElementById('show-all-btn').classList.add('active');
  document.getElementById('suggested-btn').classList.remove('active');
  document.getElementById('show-all-btn').addEventListener('click', () => {
    reviewView = 'all';
    document.getElementById('show-all-btn').classList.add('active');
    document.getElementById('suggested-btn').classList.remove('active');
    applyFilters();
  });
  document.getElementById('suggested-btn').addEventListener('click', () => {
    reviewView = 'suggested';
    document.getElementById('suggested-btn').classList.add('active');
    document.getElementById('show-all-btn').classList.remove('active');
    applyFilters();
  });

  document.getElementById('replacement-back').addEventListener('click', (e) => {
    e.preventDefault();
    goBackToOrder();
  });

  document.getElementById('replacement-next-btn').addEventListener('click', goNext);
}

/**
 * The التالي bar is fixed to the bottom of the viewport, so without this it
 * would cover the last filter options and the bottom of the footer. Its
 * measured height is published as --replacement-bar-h, which the CSS uses to
 * pad the page body and the filters column out of its way.
 */
function syncNextBarSpacing() {
  const bar = document.getElementById('replacement-next-bar');
  if (!bar || bar.style.display === 'none') return;
  const height = Math.ceil(bar.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--replacement-bar-h', height + 'px');
  document.body.classList.add('review-mode');
}

/**
 * Leave the review and return to the order page, making sure the latest
 * marks are persisted first (the owner may not have pressed التالي).
 */
async function goBackToOrder() {
  await persistReview();
  window.location.href = '/customer-order?id=' + encodeURIComponent(reviewOrderId);
}

/** Map the current marks to the replacement API payload shape */
function buildReplacementsPayload() {
  return [...reviewMarks.entries()].map(([productId, mark]) => {
    const product = allProducts.find((p) => p.id === productId);
    const orderItem = orderItemsById.get(productId);
    return {
      productId,
      name: orderItem ? orderItem.name : (product ? product.name : productId),
      state: mark.state,
      ordered: mark.ordered != null ? mark.ordered : (orderItem ? orderItem.quantity : null),
      available: mark.available
    };
  });
}

/**
 * Persist the current marks immediately, so the owner's progress survives
 * leaving the page (even via the back arrow). The review is stored per
 * order (orderId), so another order's marks never leak into this page.
 * Fire-and-forget: the UI stays responsive; the next change or التالي
 * retries if a request fails.
 */
function persistReview() {
  if (!REVIEW_MODE || !reviewOrderId) return Promise.resolve();
  return updateProductReplacement(reviewOrderId, buildReplacementsPayload());
}

async function goNext() {
  const replacements = buildReplacementsPayload();

  if (replacements.length === 0) {
    showReviewConfirm('تنبيه', 'حدد حالة منتج واحد على الأقل قبل المتابعة.', null, 'alert');
    return;
  }

  const saved = await updateProductReplacement(reviewOrderId, replacements);
  if (!saved.ok) {
    showReviewConfirm('خطأ', 'حدث خطأ أثناء حفظ المراجعة. حاول مرة أخرى.', null, 'alert');
    return;
  }

  window.location.href =
    '/alternatives-sms?order=' + encodeURIComponent(reviewOrderId);
}

async function reload() {
  allProducts = await fetchOwnerProducts(false);
  // The first load opens on a random selection; later reloads (after an edit
  // or delete) keep that same order so the owner does not lose their place.
  if (!catalogShuffled) {
    allProducts = shuffle(allProducts);
    catalogShuffled = true;
  }
  updateCounts();
  // Saving an edit keeps the owner on the page they were working on
  applyFilters({ keepPage: true });
}

// ─── Rendering ───────────────────────────────────────────────

/**
 * Is the product hidden from customers RIGHT NOW? A hide whose deadline has
 * passed is over: the product is visible again, so no «انتهت مدة الإخفاء»
 * tag and no hidden pre-selection in the edit modal.
 */
function isHideActive(product) {
  if (!product || !product.hidden) return false;
  if (!product.hideUntil) return true; // hidden until the owner unhides it
  return new Date(product.hideUntil).getTime() > Date.now();
}

/**
 * Stock status of a product for the owner.
 * - unlimited: no quantity cap (customer can order freely) — this is the default
 * - limited: stockQuantity set (blocks checkout past it)
 * - hidden: hidden from customers (until hideUntil or manual unhide)
 */
function getStockState(product) {
  if (isHideActive(product)) return 'hidden';
  if (product.unlimitedQuantity || product.stockQuantity == null) return 'unlimited';
  return 'limited';
}

/** Whole hours left in a running hide (1 is the smallest positive value) */
function hoursLeft(until) {
  return Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / (60 * 60 * 1000)));
}

/**
 * «N في المخزون» — the owner's own count. It is the number they entered and
 * it is NOT reduced when a customer orders: until the order is delivered the
 * goods are still on the shelf. Only «المتاح للعملاء» below shrinks.
 */
function inStockBadge(product) {
  const inStock = product.ownerStock != null
    ? product.ownerStock
    : (product.stockQuantity ?? 0);
  return `<span class="stock-badge limited">${inStock} في المخزون</span>`;
}

/** «M متاح للعملاء» — what a customer may still put in their cart */
function availableBadge(product) {
  return `<span class="stock-badge available">${product.stockQuantity ?? 0} متاح للعملاء</span>`;
}

/** «مخفي للعملاء لمدة 24 ساعة» — the store is not offering it right now */
function hiddenLabel(product) {
  if (!product.hideUntil) return 'مخفي للعملاء';
  const hours = hoursLeft(product.hideUntil);
  return hours <= 24
    ? `مخفي للعملاء لمدة ${hours} ساعة`
    : `مخفي للعملاء لمدة ${Math.round(hours / 24)} يوم`;
}

/**
 * The owner's two numbers for a capped product: what is in stock and either
 * what customers may still order, or — when the last units were ordered —
 * how long the product stays hidden for customers.
 */
function stockBadge(product) {
  const state = getStockState(product);

  if (state === 'unlimited') {
    return `<span class="stock-badge unlimited">كمية غير محددة</span>`;
  }

  // A product hidden while it still has a quantity (sold out, or marked
  // غير متوفر) keeps its stock count and replaces the availability with the
  // hide window. A hidden product without a quantity has no count to show.
  const hasQuantity = product.stockQuantity != null;

  if (state === 'hidden') {
    return (hasQuantity ? inStockBadge(product) : '') +
      `<span class="stock-badge hidden">${hiddenLabel(product)}</span>`;
  }

  return inStockBadge(product) + availableBadge(product);
}

function goToOwnerPage(page) {
  currentPage = page;
  renderProducts(filteredProducts);
}

function renderProducts(products) {
  const container = document.getElementById('products-grid');
  const noResults = document.getElementById('no-results');
  const resultsCount = document.getElementById('results-count');

  // Only ONE page goes into the DOM at a time: the catalog can hold thousands
  // of products, and rendering them all is what froze the page.
  const total = products.length;
  const pages = Math.max(1, Math.ceil(total / OWNER_PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), pages);
  const start = (currentPage - 1) * OWNER_PAGE_SIZE;
  const pageItems = products.slice(start, start + OWNER_PAGE_SIZE);

  container.innerHTML = '';
  // The skeleton placeholders shipped in the page HTML are replaced by the
  // first real render; drop the flag so the grid stops reserving the
  // skeleton layout.
  container.classList.remove('is-loading');

  if (total === 0) {
    noResults.style.display = 'block';
    resultsCount.textContent = 'عرض 0 منتج';
    renderPager('owner-pager', { page: currentPage, pages, onSelect: goToOwnerPage });
    return;
  }

  noResults.style.display = 'none';
  resultsCount.textContent = pages > 1
    ? `عرض ${pageItems.length} من ${total} منتج`
    : `عرض ${total} منتج`;

  pageItems.forEach((product) => {
    const card = document.createElement('article');
    card.className = 'product-card';
    card.dataset.productId = product.id;

    const thumb = product.imageUrl
      ? `<img src="${product.imageUrl}" alt="${product.name}" loading="lazy">`
      : `<span class="placeholder-icon material-symbols-outlined">inventory_2</span>`;

    // Price display with the discount applied (same calculation as the customer card)
    const basePrice = product.priceCents / 100;
    const priceRow = product.discountPercent
      ? `<div class="owner-price-row">
          <span class="owner-price-before">${basePrice.toFixed(2)} ر.س</span>
          <span class="owner-price">${(basePrice * (1 - product.discountPercent / 100)).toFixed(2)} ر.س</span>
        </div>`
      : `<div class="owner-price-row"><span class="owner-price">${basePrice.toFixed(2)} ر.س</span></div>`;

    // Replacement mode: three availability buttons instead of تعديل
    const actionArea = REVIEW_MODE
      ? replacementButtonsHtml(product)
      : `
        <button class="edit-btn" data-product-id="${product.id}">
          <span class="material-symbols-outlined">edit</span> تعديل
        </button>`;

    card.innerHTML = `
      <div class="product-thumb">
        ${product.discountPercent ? `<span class="badge">خصم ${product.discountPercent}%</span>` : ''}
        ${thumb}
      </div>
      <div class="product-info">
        <h3>${product.name}</h3>
        ${priceRow}
        <div class="stock-row">${stockBadge(product)}</div>
        ${actionArea}
      </div>
    `;
    container.appendChild(card);
  });

  renderPager('owner-pager', { page: currentPage, pages, onSelect: goToOwnerPage });
}

/**
 * The three availability buttons shown on each card in replacement mode.
 * The active one reflects the currently marked state.
 */
function replacementButtonsHtml(product) {
  const mark = reviewMarks.get(product.id);
  const state = mark ? mark.state : null;
  const ordered = mark && mark.ordered != null ? `طلبت ${mark.ordered}` : '';
  const avail = mark && mark.state === 'low' && mark.available != null
    ? `متوفر ${mark.available}`
    : '';
  const qtyLine = ordered || avail
    ? `<div class="replacement-marked-info">${[ordered, avail].filter(Boolean).join(' · ')}</div>`
    : '';

  // «المنتجات المقترحة» is the view the owner uses to change their mind about
  // the order's own items, so every card that carries a mark gets a one-click
  // way to undo it (exactly the same as clicking the active state again).
  const clearBtn = reviewView === 'suggested' && mark
    ? `<button type="button" class="repl-clear-btn" data-clear="1" title="إلغاء تحديد هذا المنتج">
        <span class="material-symbols-outlined">close</span> إلغاء
      </button>`
    : '';

  return `
    <div class="replacement-btns" data-product-id="${product.id}">
      <button class="repl-btn available ${state === 'available' ? 'active' : ''}" data-state="available">متوفر</button>
      <button class="repl-btn low ${state === 'low' ? 'active' : ''}" data-state="low">الكمية ناقصة</button>
      <button class="repl-btn unavailable ${state === 'unavailable' ? 'active' : ''}" data-state="unavailable">غير متوفر</button>
      ${clearBtn}
    </div>
    ${qtyLine}
  `;
}

// ─── Search & filters ────────────────────────────────────────

// Price buckets, mirroring PRICE_RANGES in utils/catalog.js (values are cents)
const PRICE_RANGES = {
  under10: (cents) => cents < 1000,
  '10to30': (cents) => cents >= 1000 && cents < 3000,
  over30: (cents) => cents >= 3000
};

function updateCounts() {
  const byType = {};
  const byStock = { unlimited: 0, limited: 0, hidden: 0 };
  const byPrice = { under10: 0, '10to30': 0, over30: 0 };
  let discounted = 0;

  allProducts.forEach((p) => {
    byType[p.type] = (byType[p.type] || 0) + 1;
    byStock[getStockState(p)] += 1;
    if (p.discountPercent) discounted += 1;
    Object.keys(PRICE_RANGES).forEach((key) => {
      if (PRICE_RANGES[key](p.priceCents)) byPrice[key] += 1;
    });
  });

  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  set('count-all', allProducts.length);
  // The category rows are rendered in CATEGORY_TYPES order, so the nth row's
  // count element is `count-cat-<n>`.
  CATEGORY_TYPES.forEach((type, i) => set('count-cat-' + i, byType[type] || 0));

  set('count-active', allProducts.length);
  set('count-unlimited', byStock.unlimited);
  set('count-limited', byStock.limited);
  set('count-hidden', byStock.hidden);

  set('count-discount-any', allProducts.length);
  set('count-discount-on', discounted);

  set('count-price-under10', byPrice.under10);
  set('count-price-10to30', byPrice['10to30']);
  set('count-price-over30', byPrice.over30);
}

function applyFilters({ keepPage = false } = {}) {
  let filtered = [...allProducts];

  // Replacement review default view: only the customer's ordered items
  // (عرض الكل switches to the full catalog)
  if (REVIEW_MODE && reviewView === 'suggested') {
    const wanted = new Set();
    reviewMarks.forEach((mark, productId) => wanted.add(productId));
    // The URL carries the order's product names as the initial suggestion
    // list; anything already marked stays visible too
    (replacementItems || []).forEach((name) => {
      const p = allProducts.find(
        (x) => x.name === name || (x.keyWords || []).some((k) => k === name)
      );
      if (p) wanted.add(p.id);
    });
    filtered = filtered.filter((p) => wanted.has(p.id));
  }

  const type = effectiveType();
  if (type !== 'all') {
    filtered = filtered.filter((p) => p.type === type);
  }

  if (currentStock === 'hidden') {
    filtered = filtered.filter((p) => isHideActive(p));
  } else if (currentStock === 'unlimited') {
    filtered = filtered.filter((p) => !isHideActive(p) && (p.unlimitedQuantity || p.stockQuantity == null));
  } else if (currentStock === 'limited') {
    filtered = filtered.filter((p) => !isHideActive(p) && !p.unlimitedQuantity && p.stockQuantity != null);
  }
  // 'active' shows everything in the catalog (deleted items excluded)

  if (currentDiscount === 'on') {
    filtered = filtered.filter((p) => !!p.discountPercent);
  }

  if (currentPriceRange && PRICE_RANGES[currentPriceRange]) {
    filtered = filtered.filter((p) => PRICE_RANGES[currentPriceRange](p.priceCents));
  }

  if (currentSearch) {
    // Fold Arabic the same way the category search does, so «شاى» finds
    // «شاي» and «أرز» finds «ارز». A product matches when the term is inside
    // its name OR inside any one of its search keywords.
    const term = normalizeArabic(currentSearch);
    filtered = filtered.filter((p) => {
      const nameMatch = normalizeArabic(p.name).includes(term);
      const keywordMatch = (p.keyWords || []).some((k) => normalizeArabic(k).includes(term));
      return nameMatch || keywordMatch;
    });
  }

  filteredProducts = filtered;
  // Any filter / search change starts from the first page
  if (!keepPage) currentPage = 1;
  renderProducts(filteredProducts);
}

function setupSearch() {
  const searchInput = document.getElementById('search-input');
  if (!searchInput) return;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    // Typing is the last filtering action: the selected category is ignored
    // while the box has text.
    searchTimeout = setTimeout(() => {
      currentSearch = e.target.value.trim();
      reflectCategorySelection();
      applyFilters();
    }, 300);
  });
}

function setupFilters() {
  const categoryFilters = document.getElementById('category-filters');
  const searchInput = document.getElementById('search-input');
  categoryFilters.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    // Clicking a category is the last filtering action: it takes over from
    // the search box, which is cleared.
    clearTimeout(searchTimeout);
    if (searchInput) searchInput.value = '';
    currentSearch = '';
    currentType = li.dataset.type;
    reflectCategorySelection();
    applyFilters();
  });

  const stockFilters = document.getElementById('stock-filters');
  stockFilters.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    stockFilters.querySelectorAll('li').forEach((i) => i.classList.remove('active'));
    li.classList.add('active');
    currentStock = li.dataset.stock;
    applyFilters();
  });

  const discountFilters = document.getElementById('discount-filters');
  discountFilters.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    discountFilters.querySelectorAll('li').forEach((i) => i.classList.remove('active'));
    li.classList.add('active');
    currentDiscount = li.dataset.discount;
    applyFilters();
  });

  // Price filter (same toggleable single-select as the browse page)
  const priceFilters = document.getElementById('price-filters');
  if (priceFilters) {
    priceFilters.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      if (li.classList.contains('active')) {
        li.classList.remove('active');
        currentPriceRange = null;
      } else {
        priceFilters.querySelectorAll('li').forEach((i) => i.classList.remove('active'));
        li.classList.add('active');
        currentPriceRange = li.dataset.price;
      }
      applyFilters();
    });
  }

  // Mobile filter drawer (same behavior as the customer browse page)
  const filterToggle = document.getElementById('filter-toggle');
  const filtersPanel = document.getElementById('filters-panel');
  const filterOverlay = document.getElementById('filter-overlay');
  const filterClose = document.getElementById('filter-close');

  filterToggle.addEventListener('click', () => {
    filtersPanel.classList.add('open');
    filterOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  });

  const closeFilters = () => {
    filtersPanel.classList.remove('open');
    filterOverlay.classList.remove('open');
    document.body.style.overflow = '';
  };

  filterOverlay.addEventListener('click', closeFilters);
  filterClose.addEventListener('click', closeFilters);
}

// ─── Grid actions ────────────────────────────────────────────

function setupGridActions() {
  document.getElementById('products-grid').addEventListener('click', (e) => {
    const editBtn = e.target.closest('.edit-btn');
    if (editBtn) {
      openEditModal(editBtn.dataset.productId);
      return;
    }

    // Replacement mode: undo every mark on one card (المنتجات المقترحة view)
    const clearBtn = e.target.closest('.repl-clear-btn');
    if (clearBtn && REVIEW_MODE) {
      const wrap = clearBtn.closest('.replacement-btns');
      if (wrap) clearReplacementMark(wrap.dataset.productId);
      return;
    }

    // Replacement mode: mark a product's availability
    const replBtn = e.target.closest('.repl-btn');
    if (replBtn && REVIEW_MODE) {
      const productId = replBtn.closest('.replacement-btns').dataset.productId;
      handleReplacementMark(productId, replBtn.dataset.state);
    }
  });
}

/**
 * Undo everything marked on one card: drop the product's mark and re-render,
 * persisting the review on the way (the same path used when the owner clicks
 * the active state again).
 */
function clearReplacementMark(productId) {
  if (!productId || !reviewMarks.has(productId)) return;
  reviewMarks.delete(productId);
  applyFilters();
  persistReview();
}

/**
 * Mark (or unmark) a product's availability for the reviewed order.
 * 'low' opens the custom quantity modal; 'unavailable' asks nothing.
 * Clicking the active state again un-marks the product.
 */
function handleReplacementMark(productId, state) {
  const product = allProducts.find((p) => p.id === productId);
  if (!product) return;

  const existing = reviewMarks.get(productId);
  const orderItem = orderItemsById.get(productId);
  const ordered = existing && existing.ordered != null
    ? existing.ordered
    : (orderItem ? orderItem.quantity : null);

  if (existing && existing.state === state) {
    reviewMarks.delete(productId);
    applyFilters();
    persistReview();
    return;
  }

  if (state !== 'low') {
    reviewMarks.set(productId, { state, ordered, available: null });
    applyFilters();
    persistReview();
    return;
  }

  // 'low': open the custom in-page modal for the available quantity
  openLowQtyModal(product, ordered, existing);
}

// ─── Review-mode custom popups ───────────────────────────────

let lowQtyProduct = null;

function openLowQtyModal(product, ordered, existing) {
  lowQtyProduct = product.id;
  document.getElementById('low-qty-product-name').textContent = product.name;
  document.getElementById('low-qty-ordered').textContent =
    ordered != null ? ordered : '?';

  const input = document.getElementById('low-qty-input');
  input.value = existing && existing.available != null ? existing.available : '';

  document.getElementById('low-qty-modal').classList.add('active');
}

function closeLowQtyModal() {
  document.getElementById('low-qty-modal').classList.remove('active');
  lowQtyProduct = null;
}

function setupReviewModals() {
  document.getElementById('low-qty-save').addEventListener('click', () => {
    const available = parseInt(document.getElementById('low-qty-input').value, 10);
    if (isNaN(available) || available < 0) {
      showReviewConfirm('تنبيه', 'يرجى إدخال كمية صحيحة.', null, 'alert');
      return;
    }
    // The available quantity caps ordering for the next 24 hours
    // (the server applies it when the SMS is sent)
    reviewMarks.set(lowQtyProduct, {
      state: 'low',
      ordered: (reviewMarks.get(lowQtyProduct) || {}).ordered ??
        (orderItemsById.get(lowQtyProduct) || {}).quantity ?? null,
      available
    });
    closeLowQtyModal();
    applyFilters();
    persistReview();
  });

  document.getElementById('low-qty-cancel').addEventListener('click', closeLowQtyModal);
  document.getElementById('low-qty-modal').addEventListener('click', (e) => {
    if (e.target.id === 'low-qty-modal') closeLowQtyModal();
  });

  document.getElementById('review-confirm-no').addEventListener('click', closeReviewConfirm);
  document.getElementById('review-confirm-yes').addEventListener('click', () => {
    const action = reviewConfirmAction;
    closeReviewConfirm();
    if (typeof action === 'function') action();
  });
  document.getElementById('review-confirm-modal').addEventListener('click', (e) => {
    if (e.target.id === 'review-confirm-modal') closeReviewConfirm();
  });
}

let reviewConfirmAction = null;

/** Custom confirm/alert popup shown centered on the page (never window.alert) */
function showReviewConfirm(title, text, onYes, mode = 'confirm') {
  document.getElementById('review-confirm-title').textContent = title;
  document.getElementById('review-confirm-text').textContent = text;
  reviewConfirmAction = mode === 'alert' ? null : onYes;

  const yesBtn = document.getElementById('review-confirm-yes');
  const noBtn = document.getElementById('review-confirm-no');
  yesBtn.style.display = mode === 'alert' ? 'none' : '';
  noBtn.textContent = mode === 'alert' ? 'حسناً' : 'إلغاء';

  document.getElementById('review-confirm-modal').classList.add('active');
}

function closeReviewConfirm() {
  document.getElementById('review-confirm-modal').classList.remove('active');
  reviewConfirmAction = null;
}

// ─── Edit modal ──────────────────────────────────────────────

function openEditModal(productId) {
  const product = allProducts.find((p) => p.id === productId);
  if (!product) return;
  editingId = productId;

  document.getElementById('edit-product-name').textContent = product.name;

  // Prefill price
  document.getElementById('edit-price-input').value = (product.priceCents / 100).toFixed(2);

  // Prefill quantity (products without settings are unlimited by default).
  // Two numbers: the owner's own stock, and what customers may still order.
  const qtyLimited = document.querySelector('input[name="qty-mode"][value="limited"]');
  const qtyUnlimited = document.querySelector('input[name="qty-mode"][value="unlimited"]');
  const qtyInput = document.getElementById('quantity-input');
  const availInput = document.getElementById('available-input');

  if (product.unlimitedQuantity || product.stockQuantity == null) {
    qtyUnlimited.checked = true;
    qtyLimited.checked = false;
    qtyInput.value = '';
    availInput.value = '';
  } else {
    qtyLimited.checked = true;
    qtyUnlimited.checked = false;
    qtyInput.value = product.ownerStock != null ? product.ownerStock : (product.stockQuantity ?? '');
    availInput.value = product.stockQuantity ?? '';
  }

  // Prefill visibility
  const visVisible = document.querySelector('input[name="visibility-mode"][value="visible"]');
  const visHidden = document.querySelector('input[name="visibility-mode"][value="hidden"]');
  const hiddenUntilHint = document.getElementById('hidden-until-hint');

  // A hide whose deadline has passed is over — the form must open on «ظاهر»,
  // otherwise the owner would have to "unhide" a product that is already back
  const hideActive = isHideActive(product);
  originalVisibility = hideActive ? 'hidden' : 'visible';
  visVisible.checked = !hideActive;
  visHidden.checked = hideActive;

  if (hideActive && product.hideUntil) {
    const until = new Date(product.hideUntil);
    hiddenUntilHint.textContent = 'المنتج مخفي حالياً حتى: ' + until.toLocaleString('ar-SA');
    hiddenUntilHint.style.display = 'block';
  } else {
    hiddenUntilHint.style.display = 'none';
  }

  // Prefill discount (no discount = the 'none' option)
  const discNone = document.querySelector('input[name="discount-mode"][value="none"]');
  const discActive = document.querySelector('input[name="discount-mode"][value="active"]');
  const discPercentInput = document.getElementById('discount-percent-input');
  const discUntilHint = document.getElementById('discount-until-hint');

  if (product.discountPercent) {
    discActive.checked = true;
    discPercentInput.value = product.discountPercent;
    if (product.discountUntil) {
      const until = new Date(product.discountUntil);
      discUntilHint.textContent = 'الخصم الحالي ينتهي في: ' + until.toLocaleString('ar-SA');
      discUntilHint.style.display = 'block';
    } else {
      discUntilHint.style.display = 'none';
    }
  } else {
    discNone.checked = true;
    discPercentInput.value = '';
    discUntilHint.style.display = 'none';
  }
  // Always reset the duration picker to "until removed"
  document.querySelector('input[name="discount-duration"][value="none"]').checked = true;
  document.getElementById('discount-hours-input').value = '';

  syncEditModalUI();
  document.getElementById('edit-modal').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.remove('active');
  document.body.style.overflow = '';
  editingId = null;
  originalVisibility = null;
}

/**
 * Enable/disable the duration rows and the quantity input according to
 * the currently selected radio buttons.
 */
function syncEditModalUI() {
  const qtyMode = document.querySelector('input[name="qty-mode"]:checked').value;
  const qtyInput = document.getElementById('quantity-input');
  const availInput = document.getElementById('available-input');
  const unlimitedQty = qtyMode === 'unlimited';
  qtyInput.disabled = unlimitedQty;
  availInput.disabled = unlimitedQty;
  if (unlimitedQty) {
    qtyInput.value = '';
    availInput.value = '';
  }

  const visMode = document.querySelector('input[name="visibility-mode"]:checked').value;
  document.getElementById('hide-duration-row').style.display =
    visMode === 'hidden' ? 'block' : 'none';

  const duration = document.querySelector('input[name="hide-duration"]:checked');
  const customRow = document.getElementById('custom-duration-row');
  customRow.style.display = (visMode === 'hidden' && duration && duration.value === 'custom')
    ? 'block'
    : 'none';

  // Discount fields only show when a discount is active
  const discMode = document.querySelector('input[name="discount-mode"]:checked').value;
  document.getElementById('discount-fields').style.display =
    discMode === 'active' ? 'block' : 'none';
  const discDuration = document.querySelector('input[name="discount-duration"]:checked');
  document.getElementById('discount-duration-row').style.display =
    (discMode === 'active' && discDuration && discDuration.value === 'custom')
      ? 'block'
      : 'none';
}

function setupEditModal() {
  const modal = document.getElementById('edit-modal');

  modal.addEventListener('change', (e) => {
    if (['qty-mode', 'visibility-mode', 'hide-duration', 'discount-mode', 'discount-duration'].includes(e.target.name)) {
      syncEditModalUI();
    }
  });

  // Quick duration buttons (hide: 3 days / week / month — discount: day / week / month)
  modal.addEventListener('click', (e) => {
    const quickBtn = e.target.closest('.quick-duration-btn');
    if (!quickBtn) return;
    if (quickBtn.dataset.discountHours) {
      document.getElementById('discount-hours-input').value = quickBtn.dataset.discountHours;
    } else {
      document.getElementById('hide-hours-input').value = quickBtn.dataset.hours;
    }
  });

  document.getElementById('edit-modal-close').addEventListener('click', closeEditModal);
  document.getElementById('edit-cancel-btn').addEventListener('click', closeEditModal);

  document.getElementById('edit-save-btn').addEventListener('click', saveEdit);

  // Delete — opens the confirm popup instead of deleting immediately
  document.getElementById('edit-delete-btn').addEventListener('click', () => {
    if (!editingId) return;
    const product = allProducts.find((p) => p.id === editingId);
    if (!product) return;

    closeEditModal();

    const deleteModal = document.getElementById('delete-modal');
    deleteModal.dataset.productId = product.id;
    document.getElementById('delete-product-name').textContent =
      'هل تريد حذف "' + product.name + '"؟';
    deleteModal.classList.add('active');
    document.body.style.overflow = 'hidden';
  });
}

async function saveEdit() {
  if (!editingId) return;

  const qtyMode = document.querySelector('input[name="qty-mode"]:checked').value;
  const visMode = document.querySelector('input[name="visibility-mode"]:checked').value;
  const qtyInput = document.getElementById('quantity-input');
  const availInput = document.getElementById('available-input');
  const hideHoursInput = document.getElementById('hide-hours-input');
  const priceInput = document.getElementById('edit-price-input');

  // Price payload
  const priceValue = parseFloat(priceInput.value);
  if (priceInput.value === '' || isNaN(priceValue) || priceValue <= 0) {
    alert('يرجى إدخال سعر صحيح.');
    return;
  }

  // Quantity payload: the owner's stock AND what customers may still order
  const quantity = qtyMode === 'unlimited'
    ? { mode: 'unlimited' }
    : {
        mode: 'limited',
        inStock: parseInt(qtyInput.value, 10),
        value: parseInt(availInput.value, 10)
      };

  if (qtyMode === 'limited' && (
    qtyInput.value === '' || isNaN(quantity.inStock) || quantity.inStock < 0 ||
    availInput.value === '' || isNaN(quantity.value) || quantity.value < 0
  )) {
    alert('يرجى إدخال كمية صحيحة في المخزون والمتاح للعملاء أو اختيار غير محددة.');
    return;
  }

  // The shelf must hold at least as much as customers are allowed to order,
  // otherwise the store would be promising goods it does not have.
  if (qtyMode === 'limited' && quantity.inStock < quantity.value) {
    alert('يجب أن تكون «الكمية في المخزون» أكبر من أو تساوي «المتاح للعملاء».');
    return;
  }

  // Visibility payload — only built when the owner really changed the choice.
  // Saving an untouched form must never restart the hide window (opening
  // تعديل on a 24h-hidden product and pressing حفظ used to hide it for
  // another 24 hours).
  let hide = { hidden: false };
  if (visMode === 'hidden' && visMode !== originalVisibility) {
    const duration = document.querySelector('input[name="hide-duration"]:checked').value;
    if (duration === 'custom') {
      const hours = parseInt(hideHoursInput.value, 10);
      if (!hours || hours <= 0) {
        alert('يرجى إدخال مدة إخفاء صحيحة بالساعات.');
        return;
      }
      hide = { hidden: true, hours };
    } else {
      hide = { hidden: true, hours: 24 };
    }
  }

  // Discount payload: remove it, or save the percent (+ optional duration)
  const discMode = document.querySelector('input[name="discount-mode"]:checked').value;
  let discount = null;
  if (discMode === 'active') {
    const percentInput = document.getElementById('discount-percent-input');
    const percent = parseInt(percentInput.value, 10);
    if (!percent || percent < 1 || percent > 99) {
      alert('يرجى إدخال نسبة خصم صحيحة بين 1 و 99.');
      return;
    }
    discount = { percent };
    const discDuration = document.querySelector('input[name="discount-duration"]:checked').value;
    if (discDuration === 'custom') {
      const hours = parseInt(document.getElementById('discount-hours-input').value, 10);
      if (!hours || hours <= 0) {
        alert('يرجى إدخال مدة الخصم بالساعات.');
        return;
      }
      discount.hours = hours;
    }
  }

  const saveBtn = document.getElementById('edit-save-btn');
  saveBtn.disabled = true;

  // Apply the price first
  const priceResult = await updateProductPrice(editingId, priceValue);
  if (!priceResult.ok) {
    alert('حدث خطأ أثناء حفظ السعر. حاول مرة أخرى.');
    saveBtn.disabled = false;
    return;
  }

  // Apply quantity, then visibility
  const qtyResult = await updateProductQuantity(editingId, quantity);
  if (!qtyResult.ok) {
    alert('حدث خطأ أثناء حفظ الكمية. حاول مرة أخرى.');
    saveBtn.disabled = false;
    return;
  }

  // Unchanged visibility → no API call at all (the product keeps whatever
  // hide state it already has, expired or not)
  let visResult = { ok: true };
  if (visMode !== originalVisibility) {
    if (visMode === 'hidden') {
      visResult = await hideProduct(editingId, hide.hours);
    } else {
      visResult = await unhideProduct(editingId);
    }
  }

  if (!visResult.ok) {
    saveBtn.disabled = false;
    alert('حدث خطأ أثناء تحديث ظهور المنتج. حاول مرة أخرى.');
    return;
  }

  const discResult = await updateProductDiscount(editingId, discount);
  saveBtn.disabled = false;

  if (!discResult.ok) {
    alert('حدث خطأ أثناء حفظ الخصم. حاول مرة أخرى.');
    return;
  }

  closeEditModal();
  await reload();
}

// ─── Delete modal ────────────────────────────────────────────

function setupDeleteModal() {
  const modal = document.getElementById('delete-modal');

  function closeModal() {
    modal.classList.remove('active');
    document.body.style.overflow = '';
  }

  document.getElementById('delete-cancel-btn').addEventListener('click', closeModal);

  document.getElementById('delete-confirm-btn').addEventListener('click', async () => {
    const productId = modal.dataset.productId;
    if (!productId) return;

    const result = await deleteProduct(productId);
    closeModal();

    if (!result.ok) {
      alert('حدث خطأ أثناء الحذف. حاول مرة أخرى.');
      return;
    }
    await reload();
  });
}

// Escape closes whichever modal is open
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const editModal = document.getElementById('edit-modal');
  const deleteModal = document.getElementById('delete-modal');
  const addModal = document.getElementById('add-modal');
  if (editModal.classList.contains('active')) closeEditModal();
  if (deleteModal.classList.contains('active')) {
    deleteModal.classList.remove('active');
    document.body.style.overflow = '';
  }
  if (addModal.classList.contains('active')) closeAddModal();
});

// ─── Add product modal ───────────────────────────────────────

let selectedImageFile = null;

function openAddModal() {
  // Reset the form every time it opens
  document.getElementById('add-name-input').value = '';
  document.getElementById('add-price-input').value = '';
  document.getElementById('add-type-select').value = CATEGORY_TYPES[0];
  resetKeywordRows();
  document.getElementById('add-discount-input').value = '';
  document.getElementById('add-discount-hours-input').value = '';
  document.getElementById('add-discount-duration-row').style.display = 'none';
  document.getElementById('add-quantity-input').value = '';
  document.getElementById('add-quantity-input').disabled = true;
  document.querySelector('input[name="add-qty-mode"][value="unlimited"]').checked = true;
  clearSelectedImage();

  document.getElementById('add-modal').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeAddModal() {
  document.getElementById('add-modal').classList.remove('active');
  document.body.style.overflow = '';
  selectedImageFile = null;
}

// ─── Keyword rows (one keyword per input, + to add, X to remove) ───
// The owner types one keyword at a time; empty fields are ignored and at
// least one row always stays on screen.

function keywordRows() {
  const list = document.getElementById('add-keywords-list');
  return list ? [...list.querySelectorAll('.add-keyword-input')] : [];
}

function updateKeywordRemoveButtons() {
  const list = document.getElementById('add-keywords-list');
  if (!list) return;
  const only = keywordRows().length <= 1;
  list.querySelectorAll('.add-keyword-remove').forEach((btn) => {
    // The last remaining row cannot be deleted, so its X is disabled.
    btn.disabled = only;
  });
}

function addKeywordRow(value = '') {
  const list = document.getElementById('add-keywords-list');
  if (!list) return;

  const row = document.createElement('div');
  row.className = 'add-keyword-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'add-text-input add-keyword-input';
  input.maxLength = 50;
  input.placeholder = 'مثال: حليب';
  input.value = value;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'add-keyword-remove';
  remove.title = 'حذف الكلمة';
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.textContent = 'close';
  remove.appendChild(icon);
  remove.addEventListener('click', () => removeKeywordRow(row));

  row.appendChild(input);
  row.appendChild(remove);
  list.appendChild(row);
  updateKeywordRemoveButtons();
}

function removeKeywordRow(row) {
  // Never delete the last field — at least one input always remains.
  if (keywordRows().length <= 1) return;
  row.remove();
  updateKeywordRemoveButtons();
}

/** Reset the keyword list to a single empty row (called when the modal opens) */
function resetKeywordRows() {
  const list = document.getElementById('add-keywords-list');
  if (!list) return;
  list.innerHTML = '';
  addKeywordRow();
}

/** Every non-empty keyword, trimmed and de-duplicated */
function collectKeywords() {
  const seen = new Set();
  const result = [];
  keywordRows().forEach((input) => {
    const value = input.value.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    result.push(value);
  });
  return result;
}

function clearSelectedImage() {
  selectedImageFile = null;
  document.getElementById('add-image-input').value = '';
  document.getElementById('image-preview').style.display = 'none';
  document.getElementById('image-drop').style.display = 'flex';
  document.getElementById('image-drop-text').textContent = 'اختر صورة';
}

function setupAddModal() {
  document.getElementById('add-product-btn').addEventListener('click', openAddModal);
  document.getElementById('add-modal-close').addEventListener('click', closeAddModal);
  document.getElementById('add-cancel-btn').addEventListener('click', closeAddModal);

  // Quantity mode radios enable/disable the number input
  document.getElementById('add-modal').addEventListener('change', (e) => {
    if (e.target.name !== 'add-qty-mode') return;
    const qtyInput = document.getElementById('add-quantity-input');
    qtyInput.disabled = e.target.value === 'unlimited';
    if (qtyInput.disabled) qtyInput.value = '';
  });

  // The discount duration field appears once a percentage is entered
  document.getElementById('add-discount-input').addEventListener('input', (e) => {
    const row = document.getElementById('add-discount-duration-row');
    row.style.display = e.target.value !== '' ? 'block' : 'none';
  });

  // Quick discount duration buttons (day / week / month)
  document.getElementById('add-modal').addEventListener('click', (e) => {
    const quickBtn = e.target.closest('.quick-duration-btn');
    if (!quickBtn || !quickBtn.dataset.addDiscountHours) return;
    document.getElementById('add-discount-hours-input').value = quickBtn.dataset.addDiscountHours;
  });

  // Image selection — images only (accept attr + a hard JS check)
  const imageInput = document.getElementById('add-image-input');
  imageInput.addEventListener('change', () => {
    const file = imageInput.files && imageInput.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('يرجى اختيار ملف صورة فقط (PNG, JPG, WEBP).');
      imageInput.value = '';
      return;
    }

    selectedImageFile = file;
    document.getElementById('image-drop-text').textContent = file.name;

    // Show a preview
    const reader = new FileReader();
    reader.onload = (ev) => {
      document.getElementById('preview-img').src = ev.target.result;
      document.getElementById('image-drop').style.display = 'none';
      document.getElementById('image-preview').style.display = 'flex';
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('image-remove-btn').addEventListener('click', clearSelectedImage);

  // Keyword rows — the + button appends a new field
  document.getElementById('add-keyword-btn').addEventListener('click', () => {
    addKeywordRow();
    const inputs = keywordRows();
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  });

  document.getElementById('add-save-btn').addEventListener('click', saveNewProduct);
}

async function saveNewProduct() {
  const name = document.getElementById('add-name-input').value.trim();
  const price = document.getElementById('add-price-input').value;
  const type = document.getElementById('add-type-select').value;
  // One keyword per field; empty fields are not keywords. The server splits
  // the value on commas, so joining with ', ' sends them as separate words.
  const keyWords = collectKeywords().join(', ');
  const discountPercent = document.getElementById('add-discount-input').value;
  const qtyMode = document.querySelector('input[name="add-qty-mode"]:checked').value;
  const quantityValue = document.getElementById('add-quantity-input').value;

  // Client-side validation with clear Arabic messages
  if (!name) {
    alert('يرجى إدخال اسم المنتج.');
    return;
  }
  if (price === '' || isNaN(Number(price)) || Number(price) <= 0) {
    alert('يرجى إدخال سعر صحيح.');
    return;
  }
  if (!selectedImageFile) {
    alert('يرجى اختيار صورة للمنتج.');
    return;
  }
  if (!selectedImageFile.type.startsWith('image/')) {
    alert('يرجى اختيار ملف صورة فقط (PNG, JPG, WEBP).');
    return;
  }
  if (qtyMode === 'limited' && (quantityValue === '' || isNaN(Number(quantityValue)) || Number(quantityValue) < 0)) {
    alert('يرجى إدخال كمية صحيحة أو اختيار غير محددة.');
    return;
  }
  if (discountPercent !== '' && (isNaN(Number(discountPercent)) || Number(discountPercent) < 1 || Number(discountPercent) > 99)) {
    alert('يرجى إدخال نسبة خصم صحيحة بين 1 و 99.');
    return;
  }
  const discountHours = document.getElementById('add-discount-hours-input').value;
  if (discountPercent !== '' && discountHours !== '' && (isNaN(Number(discountHours)) || Number(discountHours) <= 0)) {
    alert('يرجى إدخال مدة خصم صحيحة بالساعات.');
    return;
  }

  // Build the multipart form — the server saves the image into public/images
  // and appends the generated object to products.json
  const formData = new FormData();
  formData.append('name', name);
  formData.append('price', price);
  formData.append('type', type);
  if (keyWords) formData.append('keyWords', keyWords);
  if (discountPercent !== '') {
    formData.append('discountPercent', discountPercent);
    if (discountHours !== '') formData.append('discountHours', discountHours);
  }
  formData.append('quantityMode', qtyMode);
  if (qtyMode === 'limited') formData.append('quantityValue', quantityValue);
  formData.append('image', selectedImageFile);

  const saveBtn = document.getElementById('add-save-btn');
  saveBtn.disabled = true;

  let result = { ok: false };
  try {
    const res = await fetch('/api/owner/products', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      result = { ok: true };
    } else {
      alert(data.error || 'حدث خطأ أثناء إضافة المنتج. حاول مرة أخرى.');
    }
  } catch (err) {
    alert('حدث خطأ أثناء إضافة المنتج. حاول مرة أخرى.');
  }

  saveBtn.disabled = false;
  if (!result.ok) return;

  closeAddModal();
  await reload();
}
