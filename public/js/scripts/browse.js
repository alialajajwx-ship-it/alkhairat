// Browse page script
// Filtering, search, pagination, the mobile filter drawer and add-to-cart.
//
// The catalog is served ONE PAGE AT A TIME (the store holds thousands of
// products), so every filter / search / page change is a new request. The
// «متوفر ومشابه لطلبك» products carried by an alternatives-SMS link are pinned
// to the top of page 1 and resolved by the server, so they are found even when
// they live on a page nobody is looking at.

import { fetchProductPage, createProductCard } from '../data/products.js';
import { isInCart, addToCartOnce, removeFromCart } from '../data/cart.js';
import { renderPager } from './pager.js';

// How many cards one page holds. Sent explicitly so the page size is part of
// the request contract instead of an implicit server default.
const PAGE_SIZE = 24;

// Current view state
let currentType = 'all';
let currentPriceRange = null;
let currentDiscount = 'any'; // 'any' | 'on'
let currentSearch = '';
let currentPage = 1;
let totalPages = 1;
let totalCount = 0;
let pageProducts = [];

/**
 * The category the query actually uses.
 *
 * Search and the category list override each other — the LAST filtering action
 * wins. While the search box has text the selected category is ignored (so
 * searching «شيبس» after picking «مشروبات غازية» still finds the chips). Once
 * the box is emptied the category applies again.
 */
function effectiveType() {
  return currentSearch ? 'all' : currentType;
}

// Suggested items (owner review flow): ?item= names mark the products the
// owner marked متوفر, shown first under a متوفر ومشابه لطلبك heading.
// ?completedOrder=false is accepted for link compatibility but has no
// effect beyond the suggested section.
const suggestedNames = new URLSearchParams(window.location.search).getAll('item');
let suggestedProducts = [];
let suggestedIds = new Set();

function setSuggested(products) {
  suggestedProducts = Array.isArray(products) ? products : [];
  suggestedIds = new Set(suggestedProducts.map((product) => product.id));
}

/**
 * Fallback resolver for the pinned items.
 *
 * The server resolves ?item= names against the whole catalog (so a suggested
 * product can be pinned from any page). When it did not send them — an older
 * server, or a mocked response — resolve them against whatever this page has,
 * which is the behaviour this page always had.
 */
function resolveSuggestedLocally(products) {
  const found = new Map();
  const rank = new Map();

  suggestedNames.forEach((name, index) => {
    const match = (products || []).find(
      (p) => p.name === name || (p.keyWords || []).some((k) => k === name)
    );
    if (!match || found.has(match.id)) return;
    found.set(match.id, match);
    rank.set(match.id, index);
  });

  return [...found.values()].sort((a, b) => rank.get(a.id) - rank.get(b.id));
}

/**
 * Load a page of the catalog and render it.
 * Every UI action funnels through here, so the pager, the filters and the
 * search box can never disagree about what is on screen.
 */
async function loadPage(page = 1, { random = false } = {}) {
  const data = await fetchProductPage({
    page,
    limit: PAGE_SIZE,
    type: effectiveType(),
    priceRange: currentPriceRange,
    search: currentSearch,
    discount: currentDiscount === 'on',
    // A fresh random selection on the landing page (see DOMContentLoaded)
    random,
    // Only page 1 carries the pinned items — they are a landing block.
    items: page === 1 ? suggestedNames : []
  });

  currentPage = data.page;
  totalPages = data.pages;
  totalCount = data.total;
  pageProducts = data.products;

  if (page === 1) {
    setSuggested(data.suggested.length ? data.suggested : resolveSuggestedLocally(pageProducts));
  } else {
    // The pinned block belongs to page 1; other pages show plain results
    setSuggested([]);
  }

  updateCategoryCounts();
  renderProducts();
}

/** Render the pinned items and the current page, then the pagination bar */
function renderProducts() {
  const container = document.getElementById('browse-products');
  const noResults = document.getElementById('no-results');
  const resultsCount = document.getElementById('results-count');

  // Pinned items are rendered first and removed from the page list, so a
  // product that is both pinned AND on this page is never shown twice.
  const pinned = suggestedProducts.filter((product) => !isFilteredOut(product));
  const pinnedIds = new Set(pinned.map((product) => product.id));
  const others = pageProducts.filter((product) => !pinnedIds.has(product.id));

  container.innerHTML = '';

  if (!pinned.length && !others.length) {
    noResults.style.display = 'block';
    if (resultsCount) resultsCount.textContent = 'عرض 0 منتج';
    renderPager('browse-pager', { page: currentPage, pages: totalPages, onSelect: goToPage });
    return;
  }

  noResults.style.display = 'none';
  if (resultsCount) {
    resultsCount.textContent = totalCount > pageProducts.length
      ? `عرض ${pageProducts.length} من ${totalCount} منتج`
      : `عرض ${totalCount} منتج`;
  }

  // Heading ABOVE the block it describes (the cards that follow are the
  // suggested ones). Only rendered when that block is really on screen AND
  // something follows it — a filter (or a product removed from the catalog)
  // can hide them all, and «متوفر ومشابه لطلبك» on top of ordinary products
  // would then be a lie.
  if (pinned.length && others.length) {
    const suggestedHeader = document.createElement('div');
    suggestedHeader.className = 'suggested-divider';
    suggestedHeader.innerHTML = '<span>متوفر ومشابه لطلبك</span>';
    container.appendChild(suggestedHeader);
  }

  pinned.forEach((product) => {
    const card = createProductCard(product, {
      showAddButton: true,
      isInCart: isInCart(product.id)
    });
    card.classList.add('suggested-card');
    container.appendChild(card);
  });

  others.forEach((product) => {
    container.appendChild(createProductCard(product, {
      showAddButton: true,
      isInCart: isInCart(product.id)
    }));
  });

  renderPager('browse-pager', { page: currentPage, pages: totalPages, onSelect: goToPage });
}

/**
 * A pinned product is only shown when it still matches the current filter —
 * otherwise «متوفر ومشابه لطلبك» would sit on top of a «فواكه وخضار» view
 * listing a dairy product.
 */
function isFilteredOut(product) {
  if (!product) return true;
  const type = effectiveType();
  if (type !== 'all' && product.type !== type) return true;
  if (currentDiscount === 'on' && !product.discountPercent) return true;

  if (currentPriceRange) {
    const ranges = { under10: [0, 10], '10to30': [10, 30], over30: [30, Infinity] };
    const [min, max] = ranges[currentPriceRange] || [0, Infinity];
    let price = product.priceCents / 100;
    if (product.discountPercent) price = price * (1 - product.discountPercent / 100);
    if (price < min || price >= max) return true;
  }

  if (currentSearch) {
    // Fold Arabic the same way the category search does, so «شاى» finds
    // «شاي». A pinned item matches when the term is inside its name OR
    // inside any one of its search keywords.
    const term = normalizeArabic(currentSearch);
    const nameMatch = normalizeArabic(product.name).includes(term);
    const keyMatch = (product.keyWords || []).some((k) => normalizeArabic(k).includes(term));
    if (!nameMatch && !keyMatch) return true;
  }

  return false;
}

/**
 * The customer browse sidebar no longer shows per-category counts (the owner's
 * alternatives page keeps its own). Kept as a no-op so the fetch callback that
 * calls it stays symmetrical with the owner page's dispatcher.
 */
function updateCategoryCounts() {}

/** Keep ?page= in the address bar so refresh and Back land where you were */
function syncUrl() {
  if (typeof history === 'undefined' || typeof history.replaceState !== 'function') return;
  try {
    const url = new URL(window.location.href || 'http://localhost/');
    if (currentPage > 1) url.searchParams.set('page', String(currentPage));
    else url.searchParams.delete('page');
    history.replaceState(null, '', url.pathname + url.search);
  } catch {
    // A malformed URL must never break browsing
  }
}

async function goToPage(page) {
  if (page < 1 || page > totalPages || page === currentPage) return;
  await loadPage(page);
  syncUrl();
  const results = document.querySelector ? document.querySelector('.results') : null;
  if (results && typeof results.scrollIntoView === 'function') {
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/**
 * Fold Arabic text so the category search is forgiving: lowercase, drop the
 * diacritics/tatweel, and unify the alef / ya / ta-marbuta variants (so
 * «اغذيه» still matches «أغذية»).
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

/**
 * Highlight the category row the query actually uses. While the search box
 * has text no category is highlighted, because they are being ignored.
 */
function reflectCategorySelection() {
  const list = document.getElementById('category-filters');
  if (!list) return;
  const searching = !!currentSearch;
  list.querySelectorAll('li').forEach((li) => {
    li.classList.toggle('active', !searching && li.dataset.type === currentType);
  });
}

/** Filter the category list itself as the customer types. */
function setupCategorySearch() {
  const input = document.getElementById('category-search');
  const list = document.getElementById('category-filters');
  if (!input || !list) return;

  input.addEventListener('input', () => {
    const term = normalizeArabic(input.value);
    list.querySelectorAll('li').forEach((li) => {
      // «جميع المنتجات» is the "no category" row — it always stays visible.
      if (li.dataset.type === 'all') return;
      const label = normalizeArabic(li.dataset.type || li.textContent);
      li.style.display = !term || label.includes(term) ? '' : 'none';
    });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  // The skeleton cards are static HTML in the page; the first render replaces
  // them. Page 1 also carries the pinned suggested items.
  const startPage = Number(new URLSearchParams(window.location.search).get('page'));
  const initialPage = Number.isFinite(startPage) && startPage > 1 ? startPage : 1;

  const searchInput = document.getElementById('search-input');
  let searchTimeout;

  // A freshly opened, unfiltered browse page shows a random selection of
  // products instead of the same ordered shelf every time.
  const landingUnfiltered = initialPage === 1 && !currentSearch && currentType === 'all'
    && !currentPriceRange && currentDiscount === 'any';
  await loadPage(initialPage, { random: landingUnfiltered });
  syncUrl();

  // Search input (server-side search, debounced, back to page 1). Typing is
  // the last filtering action, so the selected category is ignored while the
  // box has text.
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        currentSearch = e.target.value.trim();
        reflectCategorySelection();
        loadPage(1).then(syncUrl);
      }, 300);
    });
  }

  // Search the category list itself
  setupCategorySearch();

  // Category filter clicks
  const categoryFilters = document.getElementById('category-filters');
  if (categoryFilters) {
    categoryFilters.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li) return;

      // Clicking a category is the last filtering action: it takes over from
      // whatever is in the search box, which is cleared.
      clearTimeout(searchTimeout);
      if (searchInput) searchInput.value = '';
      currentSearch = '';

      currentType = li.dataset.type;
      reflectCategorySelection();
      loadPage(1).then(syncUrl);
    });
  }

  // Price filter clicks
  const priceFilters = document.getElementById('price-filters');
  if (priceFilters) {
    priceFilters.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li) return;

      // Toggle active state
      if (li.classList.contains('active')) {
        li.classList.remove('active');
        currentPriceRange = null;
      } else {
        priceFilters.querySelectorAll('li').forEach((item) => item.classList.remove('active'));
        li.classList.add('active');
        currentPriceRange = li.dataset.price;
      }
      loadPage(1).then(syncUrl);
    });
  }

  // Discount filter clicks (single-select, toggleable)
  const discountFilters = document.getElementById('discount-filters');
  if (discountFilters) {
    discountFilters.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li) return;

      if (li.dataset.discount === 'on') {
        // Toggle the 'عليها خصم' option on and off
        const isActive = li.classList.contains('active');
        discountFilters.querySelectorAll('li').forEach((item) => item.classList.remove('active'));
        if (isActive) {
          discountFilters.querySelector('[data-discount="any"]').classList.add('active');
          currentDiscount = 'any';
        } else {
          li.classList.add('active');
          currentDiscount = 'on';
        }
      } else {
        discountFilters.querySelectorAll('li').forEach((item) => item.classList.remove('active'));
        li.classList.add('active');
        currentDiscount = 'any';
      }
      loadPage(1).then(syncUrl);
    });
  }

  // Mobile filter toggle
  const filterToggle = document.getElementById('filter-toggle');
  const filtersPanel = document.getElementById('filters-panel');
  const filterOverlay = document.getElementById('filter-overlay');
  const filterClose = document.getElementById('filter-close');

  if (filterToggle && filtersPanel && filterOverlay && filterClose) {
    filterToggle.addEventListener('click', () => {
      filtersPanel.classList.add('open');
      filterOverlay.classList.add('open');
      document.body.style.overflow = 'hidden';
    });

    function closeFilters() {
      filtersPanel.classList.remove('open');
      filterOverlay.classList.remove('open');
      document.body.style.overflow = '';
    }

    filterOverlay.addEventListener('click', closeFilters);
    filterClose.addEventListener('click', closeFilters);
  }

  // Handle add/remove buttons
  const productsContainer = document.getElementById('browse-products');
  productsContainer.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.add-btn');
    const removeBtn = e.target.closest('.remove-btn');

    if (addBtn) {
      const productId = addBtn.dataset.productId;
      const added = addToCartOnce(productId);
      if (added) {
        const card = addBtn.closest('.product-card');
        // Show the "تمت اضافة المنتج الى السلة" overlay on the image for 3.2s
        const message = card.querySelector('.cart-message');
        if (message) {
          message.style.display = 'flex';
          clearTimeout(card.__msgTimer);
          card.__msgTimer = setTimeout(() => {
            message.style.display = 'none';
          }, 3200);
        }
        // Persistent "مضاف إلى السلة" tag in the card's bottom band
        card.classList.add('in-cart');

        // Replace button with remove
        addBtn.outerHTML = `
          <button class="remove-btn" data-product-id="${productId}" title="ازالة من السلة">
            <span class="material-symbols-outlined">remove</span>
          </button>
        `;

        // Update header cart badge
        window.dispatchEvent(new Event('cart-updated'));
      }
    }

    if (removeBtn) {
      const productId = removeBtn.dataset.productId;
      removeFromCart(productId);
      const card = removeBtn.closest('.product-card');
      if (card) card.classList.remove('in-cart');
      removeBtn.outerHTML = `
        <button class="add-btn" data-product-id="${productId}" title="اضافة الى السلة">
          <span class="material-symbols-outlined">add</span>
        </button>
      `;

      // Update header cart badge
      window.dispatchEvent(new Event('cart-updated'));
    }
  });
});
