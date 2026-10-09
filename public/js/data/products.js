// Products data module
// Reads the catalog from the backend API.
//
// The store holds thousands of products, so NOTHING here downloads the whole
// catalog any more:
//   • fetchProductPage() serves the browse grid one page at a time, with the
//     totals and the per-category counts the sidebar needs;
//   • fetchProductsByIds() serves the cart, checkout and order pages, which
//     only ever need the few products they reference.

// How many cards a browse page asks the server for
const PAGE_SIZE = 24;

// A few unit markers in the source catalog were scraped from a bidi-rendered
// page, which left them stuck to the FRONT of the name instead of right after
// the weight — e.g. "gبرينجلز رقائق البطاطس 165" instead of "… 165g". In an
// RTL card the browser then shows the «g» before the number, so the name reads
// wrong on every page that renders it. Reattach such a leading unit to the
// trailing number at the data layer, so every view gets the same fixed name.
const LEADING_UNIT = /^(kg|ml|oz|cm|g|l)(?=[\u0600-\u06FF])/i;
const TRAILING_NUMBER = /[0-9](?:\.[0-9]+)?\s*$/;

/**
 * Reorder a product name whose unit got detached to the front, e.g.
 * "gبتلو برجر لحم بقري 1100" → "بتلو برجر لحم بقري 1100g".
 * Names that do not match the pattern (including already-correct ones) are
 * returned unchanged, so this is safe to apply everywhere.
 * @param {string} name
 * @returns {string}
 */
export function normalizeProductName(name) {
  const value = String(name == null ? '' : name);
  const match = value.match(LEADING_UNIT);
  if (!match) return value;
  const unit = match[1];
  const rest = value.slice(unit.length);
  if (!TRAILING_NUMBER.test(rest)) return value;
  return rest.replace(/\s+$/, '') + unit;
}
// Hard ceiling the server enforces as well, used when paging through everything
const MAX_PAGE_SIZE = 100;
// Safety stop for the legacy "give me everything" helper
const MAX_PAGES = 100;

// The shop's categories, in the order the browse sidebar lists them. These are
// the real Arabic category names stored on every product's `type`.
export const CATEGORY_TYPES = [
  'ألبان وحليب',
  'شاي وقهوة',
  'عصائر ومشروبات',
  'مشروبات غازية',
  'تسالي وشبسات',
  'مخبوزات',
  'شوكولاتة وحلويات',
  'كيك وحلويات',
  'لحوم ومجمدات',
  'حبوب إفطار',
  'قشطة وكريمة',
  'حلويات مبردة',
  'مواد غذائية وطبخ',
  'مثلجات وآيس كريم',
  'أجبان ومشتقاتها',
  'منتجات تموينية',
  'بسكويت وويفر',
  'مشروبات طاقة',
  'مياه',
  'منظفات وعناية منزلية',
  'حلويات وعلكة',
  'عناية شخصية',
  'عناية بالطفل',
  'مستلزمات بلاستيكية ومناديل'
];

/**
 * One page of the customer catalog, plus its metadata.
 *
 * Always resolves — a failed request returns an empty page instead of
 * throwing, so `.find` / `.filter` on the result never blow up.
 *
 * @param {{ type?: string, priceRange?: string, search?: string,
 *           discount?: boolean, sort?: string, page?: number, limit?: number,
 *           featured?: number, items?: string[], random?: boolean }} params
 * @returns {Promise<{ products: Array, total: number, page: number,
 *                     pages: number, limit: number, counts: object|null,
 *                     suggested: Array }>}
 */
export async function fetchProductPage(params = {}) {
  const query = new URLSearchParams();
  if (params.type && params.type !== 'all') query.set('type', params.type);
  if (params.priceRange) query.set('priceRange', params.priceRange);
  if (params.search) query.set('search', params.search);
  if (params.discount) query.set('discount', 'on');
  if (params.sort) query.set('sort', params.sort);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  if (params.featured) query.set('featured', String(params.featured));
  if (params.random) query.set('random', '1');
  (params.items || []).forEach((name) => query.append('items', name));

  const fallback = {
    products: [],
    total: 0,
    page: 1,
    pages: 1,
    limit: params.limit || PAGE_SIZE,
    counts: null,
    suggested: []
  };

  const numeric = (value, fallbackValue) =>
    Number.isFinite(Number(value)) ? Number(value) : fallbackValue;

  // Every product the page shows gets the same corrected name
  const withName = (product) => ({ ...product, name: normalizeProductName(product.name) });

  try {
    const res = await fetch(`/api/products?${query.toString()}`);
    if (!res.ok) {
      console.error('Failed to fetch products: HTTP ' + res.status);
      return fallback;
    }
    const data = await res.json();
    if (!Array.isArray(data.products)) return fallback;

    return {
      products: data.products.map(withName),
      total: numeric(data.total, data.products.length),
      page: numeric(data.page, 1),
      pages: Math.max(1, numeric(data.pages, 1)),
      limit: numeric(data.limit, data.products.length),
      counts: data.counts && typeof data.counts === 'object' ? data.counts : null,
      suggested: Array.isArray(data.suggested) ? data.suggested.map(withName) : []
    };
  } catch (err) {
    console.error('Failed to fetch products:', err);
    return fallback;
  }
}

/**
 * Exact products for a set of ids — the cart, the checkout quantity limits
 * and the order pages. Never downloads anything else.
 * @param {string[]} ids
 * @returns {Promise<Array>}
 */
export async function fetchProductsByIds(ids) {
  const wanted = [...new Set((ids || []).filter(Boolean))];
  if (!wanted.length) return [];

  try {
    const res = await fetch(`/api/products?ids=${encodeURIComponent(wanted.join(','))}`);
    if (!res.ok) {
      console.error('Failed to fetch products: HTTP ' + res.status);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.products)
      ? data.products.map((product) => ({
          ...product,
          name: normalizeProductName(product.name)
        }))
      : [];
  } catch (err) {
    console.error('Failed to fetch products:', err);
    return [];
  }
}

/**
 * The WHOLE catalog, paged together client-side.
 *
 * Kept only for callers that genuinely need everything; the browse grid uses
 * fetchProductPage() and everything else fetchProductsByIds(). Never returns a
 * partial catalog — if a page fails the loop stops, exactly like a network
 * error used to.
 */
export async function fetchProducts() {
  const all = [];
  let page = 1;
  let pages = 1;

  do {
    const data = await fetchProductPage({ page, limit: MAX_PAGE_SIZE });
    if (!data.products.length) break;
    all.push(...data.products);
    pages = data.pages;
    page += 1;
  } while (page <= pages && page <= MAX_PAGES);

  return all;
}

export async function searchProducts(term) {
  const data = await fetchProductPage({ search: term, limit: MAX_PAGE_SIZE });
  return data.products;
}

export async function filterProducts(type, priceRange) {
  const data = await fetchProductPage({ type, priceRange, limit: MAX_PAGE_SIZE });
  return data.products;
}

/**
 * Calculate discounted price
 * Returns { original, discounted, hasDiscount, discountPercent }
 */
export function calculatePrice(product) {
  const original = product.priceCents / 100;
  if (product.discountPercent) {
    const discounted = original * (1 - product.discountPercent / 100);
    return {
      original: original.toFixed(2),
      discounted: discounted.toFixed(2),
      hasDiscount: true,
      discountPercent: product.discountPercent
    };
  }
  return {
    original: original.toFixed(2),
    discounted: original.toFixed(2),
    hasDiscount: false,
    discountPercent: 0
  };
}

/**
 * Get products with discounts only
 */
export async function getDiscountedProducts() {
  const data = await fetchProductPage({ discount: true, limit: MAX_PAGE_SIZE });
  return data.products;
}

/**
 * Get featured products for homepage: the last 4 discounts the owner added.
 * The server sorts by discountSetAt (set when the owner creates/edits a
 * discount), newest first, and only the 4 are downloaded.
 */
export async function getFeaturedProducts() {
  const data = await fetchProductPage({ featured: 4 });
  return data.products.slice(0, 4);
}

/**
 * Resolve how an ORDER item is shown on the order, tracking and
 * customer-order pages.
 *
 * An order stores its own copy of the name and of the unit price the customer
 * paid, so an item whose product has left the customer catalog (sold out →
 * hidden for 24 hours, deleted, or missing from /api/products for any other
 * reason) must still be rendered — silently dropping it made the customer's
 * images/products disappear from the order history.
 *
 * @param {{ productId: string, name?: string, price?: number, quantity: number, imageUrl?: string }} item
 * @param {Object|undefined} product - the catalog product, when it still exists
 * @returns {{ name: string, imageUrl: string, price: { original: string, discounted: string, hasDiscount: boolean, discountPercent: number } }}
 */
export function resolveOrderItem(item, product) {
  // The order keeps its own copy of the product image too, so an item whose
  // product left the customer catalog still shows its photo. Without this the
  // image vanished exactly on the orders the owner had just reviewed (a
  // «غير متوفر» mark hides the product from /api/products).
  const storedImage = (item && item.imageUrl) || '';

  if (product) {
    return {
      name: normalizeProductName(product.name),
      imageUrl: product.imageUrl || storedImage,
      price: calculatePrice(product)
    };
  }

  // The product is gone from the customer catalog: fall back to what the
  // order itself remembers (unit price paid, no discount information left)
  const paid = Number(item && item.price) || 0;
  return {
    name: normalizeProductName((item && item.name) || 'منتج'),
    imageUrl: storedImage,
    price: {
      original: paid.toFixed(2),
      discounted: paid.toFixed(2),
      hasDiscount: false,
      discountPercent: 0
    }
  };
}

/**
 * Get product by ID
 */
export async function getProductById(id) {
  const products = await fetchProductsByIds([id]);
  return products[0] || null;
}

/**
 * Format price in SAR
 */
export function formatPrice(priceCents) {
  return (priceCents / 100).toFixed(2) + ' ر.س';
}

/**
 * Get category label in Arabic
 */
export function getCategoryLabel(type) {
  // The stored `type` already IS the Arabic category name, so it is shown
  // as-is. The few legacy English slugs are still mapped for old documents.
  const legacy = {
    'fruits/vegetable': 'فواكه وخضار',
    'dairy': 'ألبان وحليب',
    'meat': 'لحوم ومجمدات',
    'drink': 'عصائر ومشروبات',
    'bakery': 'مخبوزات',
    'home': 'عناية شخصية'
  };
  return legacy[type] || type || '';
}

/**
 * Get category icon name for Material Symbols
 */
export function getCategoryIcon(type) {
  const icons = {
    'ألبان وحليب': 'water_drop',
    'شاي وقهوة': 'coffee',
    'عصائر ومشروبات': 'local_drink',
    'مشروبات غازية': 'local_drink',
    'تسالي وشبسات': 'fastfood',
    'مخبوزات': 'bakery_dining',
    'شوكولاتة وحلويات': 'cookie',
    'كيك وحلويات': 'cake',
    'لحوم ومجمدات': 'set_meal',
    'حبوب إفطار': 'breakfast_dining',
    'قشطة وكريمة': 'water_drop',
    'حلويات مبردة': 'icecream',
    'مواد غذائية وطبخ': 'rice_bowl',
    'مثلجات وآيس كريم': 'icecream',
    'أجبان ومشتقاتها': 'water_drop',
    'منتجات تموينية': 'shopping_basket',
    'بسكويت وويفر': 'cookie',
    'مشروبات طاقة': 'bolt',
    'مياه': 'water_drop',
    'منظفات وعناية منزلية': 'cleaning_services',
    'حلويات وعلكة': 'cookie',
    'عناية شخصية': 'spa',
    'عناية بالطفل': 'child_care',
    'مستلزمات بلاستيكية ومناديل': 'inventory_2',
    // Legacy English slugs from the old placeholder catalog
    'fruits/vegetable': 'eco',
    'dairy': 'water_drop',
    'meat': 'set_meal',
    'drink': 'local_cafe',
    'bakery': 'bakery_dining',
    'home': 'cleaning_services'
  };
  return icons[type] || 'inventory_2';
}

/**
 * Create a product card HTML element
 * @param {Object} product - Product data
 * @param {Object} options - { showAddButton: boolean, isInCart: boolean }
 */
export function createProductCard(product, options = {}) {
  const { showAddButton = true, isInCart = false } = options;
  const price = calculatePrice(product);
  const card = document.createElement('article');
  card.className = 'product-card';
  card.dataset.productId = product.id;
  if (isInCart) card.classList.add('in-cart');

  const thumbContent = product.imageUrl
    ? `<span class="img-spinner" aria-hidden="true"></span><img class="thumb-img" src="${product.imageUrl}" alt="${product.name}" loading="lazy">`
    : `<span class="placeholder-icon material-symbols-outlined">${getCategoryIcon(product.type)}</span>`;

  const discountBadge = price.hasDiscount
    ? `<span class="badge">خصم ${price.discountPercent}%</span>`
    : '';

  const priceArea = price.hasDiscount
    ? `<div class="price-area">
        <span class="price-before">${price.original} ر.س</span>
        <span class="price">${price.discounted} ر.س</span>
      </div>`
    : `<div class="price-area">
        <span class="price">${price.original} ر.س</span>
      </div>`;

  const addBtn = showAddButton
    ? isInCart
      ? `<button class="remove-btn" data-product-id="${product.id}" title="ازالة من السلة">
          <span class="material-symbols-outlined">remove</span>
        </button>`
      : `<button class="add-btn" data-product-id="${product.id}" title="اضافة الى السلة">
          <span class="material-symbols-outlined">add</span>
        </button>`
    : '';

  card.innerHTML = `
    <div class="product-thumb">
      ${discountBadge}
      ${thumbContent}
      <div class="cart-message" style="display:none;">تمت اضافة المنتج الى السلة</div>
    </div>
    <div class="product-info">
      <span class="p-cat">${getCategoryLabel(product.type)}</span>
      <h3>${product.name}</h3>
      <div class="p-bottom">
        ${priceArea}
        ${addBtn}
      </div>
      <span class="in-cart-tag"><span class="material-symbols-outlined">check_circle</span>مضاف إلى السلة</span>
    </div>
  `;

  // Image loading spinner: hide the spinner the moment the photo is ready
  // (or mark a failed load so the placeholder icon is the only thing shown)
  const thumbImg = card.querySelector('.product-thumb img.thumb-img');
  if (thumbImg) {
    const markLoaded = () => card.classList.add('img-loaded');
    if (thumbImg.complete && thumbImg.naturalWidth > 0) {
      markLoaded();
    } else {
      thumbImg.addEventListener('load', markLoaded);
      thumbImg.addEventListener('error', () => card.classList.add('img-failed'));
    }
  }

  return card;
}
