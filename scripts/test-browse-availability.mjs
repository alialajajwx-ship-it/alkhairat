// UI scenario tests for the customer-facing fixes:
//   1. the red-bordered «متوفر ومشابه لطلبك» items carried by the alternatives
//      SMS link are the FIRST cards on the browse page, under their heading
//      (and no misleading header when none of them survive the current view);
//   2. a cancelled order shows «ملغي» in طلباتي instead of «يتم المراجعة»;
//   3. an ordered item whose product left the catalog keeps its tile/row;
//   4. a signed-in customer never sees the localStorage mirror as a ghost
//      order the server (and the owner dashboard) knows nothing about.
//
// Both run the REAL page scripts against a minimal fake DOM.
// Run with:  node scripts/test-browse-availability.mjs

import assert from 'assert';
import fs from 'fs';

let passed = 0;
const failures = [];

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}\n      ${err.message}`);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

// ─── Minimal DOM ─────────────────────────────────────────────

class FakeClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) {
    names.filter(Boolean).forEach((n) => this.set.add(String(n)));
  }
  remove(...names) {
    names.forEach((n) => this.set.delete(String(n)));
  }
  contains(name) {
    return this.set.has(String(name));
  }
  has(name) {
    return this.set.has(String(name));
  }
  toString() {
    return [...this.set].join(' ');
  }
}

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    // style is a plain bag of properties; setProperty covers the
    // --replacement-bar-h custom property the review mode publishes
    this.style = { setProperty() {} };
    this.classList = new FakeClassList();
    this.listeners = {};
    this.value = '';
    this.disabled = false;
    this.href = '';
    this.checked = false;
    this.textContent = '';
    this._html = '';
  }

  get className() {
    return [...this.classList.set].join(' ');
  }

  set className(value) {
    this.classList.set.clear();
    this.classList.add(...String(value == null ? '' : value).split(/\s+/));
  }

  get innerHTML() {
    return this._html;
  }

  set innerHTML(value) {
    this._html = String(value == null ? '' : value);
    // The page scripts use innerHTML = '' to reset a container
    if (this._html === '') this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  removeEventListener() {}

  closest() {
    return null;
  }

  getBoundingClientRect() {
    return { width: 0, height: 0, top: 0, bottom: 0 };
  }
}

function makeDocument() {
  const els = new Map();
  const listeners = {};
  const inputsByName = new Map();

  return {
    listeners,

    /** Register a radio input ("input[name=…]:checked" lookups) */
    registerInput(name, value, checked = false) {
      const input = new FakeEl('input');
      input.name = name;
      input.value = value;
      input.checked = checked;
      if (!inputsByName.has(name)) inputsByName.set(name, []);
      inputsByName.get(name).push(input);
      return input;
    },

    /** Check the radio with this value and uncheck its siblings */
    selectInput(name, value) {
      (inputsByName.get(name) || []).forEach((input) => {
        input.checked = input.value === value;
      });
    },

    getInput(name, value) {
      return (inputsByName.get(name) || []).find((input) => input.value === value) || null;
    },

    getElementById(id) {
      if (!els.has(id)) els.set(id, new FakeEl('div'));
      return els.get(id);
    },

    createElement(tag) {
      return new FakeEl(tag);
    },

    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },

    querySelector(selector) {
      // The only selectors the page scripts use are the radio lookups
      // "input[name=…]" — optionally with [value=…] and/or :checked
      const tail = String(selector).split('input[name="')[1];
      if (!tail) return null;
      const parts = tail.split('"]');
      const name = parts[0];
      const rest = parts[1] || '';

      let list = inputsByName.get(name) || [];
      const valuePart = rest.split('[value="')[1];
      if (valuePart) {
        const value = valuePart.split('"]')[0];
        list = list.filter((input) => input.value === value);
      }

      return rest.includes(':checked')
        ? (list.find((input) => input.checked) || null)
        : (list[0] || null);
    },

    querySelectorAll() {
      return [];
    },

    body: new FakeEl('body'),
    documentElement: new FakeEl('html')
  };
}

/** Fire a click on an element's listeners, awaiting async handlers */
async function fireClick(el, target) {
  const handlers = el.listeners.click || [];
  assert.ok(handlers.length > 0, 'the element has a click listener');
  for (const handler of handlers) {
    await handler({ target, preventDefault() {}, stopPropagation() {} });
  }
}

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
}

/**
 * Import a page script as a fresh module instance, fire its
 * DOMContentLoaded handler and return the fake document.
 * @param {boolean} [opts.authenticated] - mirrors window.IS_AUTHENTICATED
 *   (published by the header); false = a guest, the default in these tests
 * @param {Array} [opts.localOrders] - orders to seed the localStorage mirror
 *   with, so the fallback paths can be exercised
 */
async function runPage(url, { search = '', fetchImpl, authenticated = false, localOrders = null }) {
  const document = makeDocument();
  globalThis.document = document;
  globalThis.window = {
    location: { origin: 'http://localhost:5000', href: '', search },
    IS_AUTHENTICATED: authenticated,
    addEventListener() {},
    dispatchEvent() {}
  };
  const storage = makeLocalStorage();
  if (localOrders) storage.setItem('alkhairat_orders', JSON.stringify(localOrders));
  globalThis.localStorage = storage;
  globalThis.alert = () => {};

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;

  try {
    await import(`${url}?scenario=${Math.random()}`);
    const onReady = (document.listeners.DOMContentLoaded || [])[0];
    assert.ok(onReady, 'the page registered a DOMContentLoaded handler');
    await onReady();
  } finally {
    globalThis.fetch = originalFetch;
  }

  return document;
}

const BROWSE_URL = new URL('../public/js/scripts/browse.js', import.meta.url).href;
const ORDERS_URL = new URL('../public/js/scripts/orders.js', import.meta.url).href;

const CATALOG = [
  { id: 'p-apple', name: 'تفاح', type: 'fruits/vegetable', priceCents: 500, keyWords: ['تفاح'] },
  { id: 'p-milk', name: 'حليب المراعي', type: 'dairy', priceCents: 700, keyWords: ['حليب'] },
  { id: 'p-kiri', name: 'جبنة كيري', type: 'dairy', priceCents: 900, keyWords: ['جبن'] }
];

// ─── Part 1: browse page — suggested items first ─────────────

console.log('\nPart 1 — browse page: «متوفر ومشابه لطلبك» items come first');

function renderBrowse(search) {
  return runPage(BROWSE_URL, {
    search,
    fetchImpl: async () => ({ ok: true, json: async () => ({ products: CATALOG }) })
  });
}

/** ['divider', 'suggested:p-milk', 'card:p-apple', …] — the heading sits
 *  ABOVE the suggested cards it introduces */
function describeGrid(grid) {
  return grid.children.map((el) => {
    if (el.classList.contains('suggested-divider')) return 'divider';
    const kind = el.classList.contains('suggested-card') ? 'suggested' : 'card';
    return `${kind}:${el.dataset.productId}`;
  });
}

const itemParam = (name) => `?completedOrder=false&order=ORD-1&item=${encodeURIComponent(name)}`;

await checkAsync('problem 1: the suggested item jumps to the front of the grid', async () => {
  // حليب is the SECOND product in the catalog — before the fix it stayed there
  const document = await renderBrowse(itemParam('حليب المراعي'));
  assert.deepStrictEqual(describeGrid(document.getElementById('browse-products')), [
    'divider',
    'suggested:p-milk',
    'card:p-apple',
    'card:p-kiri'
  ]);
});

await checkAsync('problem 1: several suggested items keep their link order on top', async () => {
  const document = await renderBrowse(itemParam('جبنة كيري') + '&item=' + encodeURIComponent('حليب المراعي'));
  assert.deepStrictEqual(describeGrid(document.getElementById('browse-products')), [
    'divider',
    'suggested:p-kiri',
    'suggested:p-milk',
    'card:p-apple'
  ]);
});

await checkAsync('problem 1: a keyword match is suggested too', async () => {
  const document = await renderBrowse(itemParam('حليب'));
  const grid = document.getElementById('browse-products');
  assert.strictEqual(grid.children[0].classList.contains('suggested-divider'), true,
    'the heading comes first');
  assert.strictEqual(grid.children[1].dataset.productId, 'p-milk');
  assert.ok(grid.children[1].classList.contains('suggested-card'));
});

await checkAsync('an unknown suggested name adds nothing and no header', async () => {
  const document = await renderBrowse(itemParam('منتج غير موجود'));
  assert.deepStrictEqual(describeGrid(document.getElementById('browse-products')), [
    'card:p-apple',
    'card:p-milk',
    'card:p-kiri'
  ]);
});

await checkAsync('every product suggested → highlighted, but no divider', async () => {
  const search = itemParam('تفاح') + '&item=' + encodeURIComponent('حليب المراعي') +
    '&item=' + encodeURIComponent('جبنة كيري');
  const document = await renderBrowse(search);
  assert.deepStrictEqual(describeGrid(document.getElementById('browse-products')), [
    'suggested:p-apple',
    'suggested:p-milk',
    'suggested:p-kiri'
  ]);
});

await checkAsync('a plain browse visit keeps the catalog order (no divider)', async () => {
  const document = await renderBrowse('');
  assert.deepStrictEqual(describeGrid(document.getElementById('browse-products')), [
    'card:p-apple',
    'card:p-milk',
    'card:p-kiri'
  ]);
});

// ─── Part 2: orders page — cancelled orders ──────────────────

console.log('\nPart 2 — طلباتي: a cancelled order is not «يتم المراجعة»');

const orderWith = (extra) => ({
  orderId: 'ORD-260926010525',
  orderTime: new Date('2026-09-26T01:05:25.000Z').toISOString(),
  total: 42.5,
  items: [{ productId: 'p-milk', quantity: 2 }],
  confirmed: false,
  cancelled: false,
  ...extra
});

async function ordersPageHtml(orders) {
  const document = await runPage(ORDERS_URL, {
    search: '?tab=orders',
    fetchImpl: async (url) => String(url).includes('/api/my-orders')
      ? { ok: true, json: async () => ({ orders }) }
      : { ok: true, json: async () => ({ products: CATALOG }) }
  });

  const list = document.getElementById('orders-list');
  assert.strictEqual(list.children.length, orders.length, 'every order got a card');
  return list.children.map((card) => card.innerHTML);
}

await checkAsync('a cancelled order shows «ملغي» with the cancelled style', async () => {
  const [html] = await ordersPageHtml([orderWith({ cancelled: true })]);
  assert.ok(html.includes('حالة الطلب: ملغي'), `unexpected status tag:\n${html}`);
  assert.ok(html.includes('status status-cancelled'), 'the red/brick style is applied');
  assert.ok(!html.includes('يتم المراجعة'), 'a dropped order must not look like it is being reviewed');
});

await checkAsync('confirmed / pending orders keep their own tags', async () => {
  const [confirmed, pending] = await ordersPageHtml([
    orderWith({ orderId: 'ORD-A', confirmed: true }),
    orderWith({ orderId: 'ORD-B' })
  ]);
  assert.ok(confirmed.includes('حالة الطلب: مؤكد'));
  assert.ok(confirmed.includes('status-confirmed'));
  assert.ok(pending.includes('حالة الطلب: يتم المراجعة'));
  assert.ok(pending.includes('status-review'));
});

await checkAsync('a legacy order cancelled through its status field also shows ملغي', async () => {
  const [html] = await ordersPageHtml([orderWith({ status: 'cancelled' })]);
  assert.ok(html.includes('حالة الطلب: ملغي'));
});

await checkAsync('a card order that never paid (pending_authorization) is not listed', async () => {
  // /api/my-orders filters those out server-side; the page must therefore
  // render whatever it is given without inventing statuses
  const [html] = await ordersPageHtml([orderWith({ cancelled: true, confirmed: false })]);
  assert.ok(html.includes('ملغي'));
  assert.ok(!html.includes('مؤكد'));
});

/** An order that only exists in the browser's localStorage mirror */
const ghostOrder = {
  id: 'ORD-GHOST',
  orderId: 'ORD-GHOST',
  orderTime: new Date('2026-09-01T10:00:00.000Z').toISOString(),
  total: 30,
  items: [{ productId: 'p-milk', quantity: 1 }],
  confirmed: false,
  cancelled: false
};

await checkAsync('a signed-in customer never sees a ghost localStorage order', async () => {
  // The order was deleted on the server (or belongs to another account used on
  // this browser) but its mirror is still in localStorage: the account's real
  // list is empty, so the page must show the empty state, not the mirror.
  const document = await runPage(ORDERS_URL, {
    search: '?tab=orders',
    authenticated: true,
    localOrders: [ghostOrder],
    fetchImpl: async (url) => String(url).includes('/api/my-orders')
      ? { ok: true, json: async () => ({ orders: [] }) }
      : { ok: true, json: async () => ({ products: CATALOG }) }
  });

  assert.strictEqual(document.getElementById('orders-list').children.length, 0,
    'the stale mirror must not be rendered');
  assert.strictEqual(document.getElementById('no-orders').style.display, 'block',
    'an empty server list is the empty state');
});

await checkAsync('a signed-in customer gets exactly the server list', async () => {
  const document = await runPage(ORDERS_URL, {
    search: '?tab=orders',
    authenticated: true,
    localOrders: [ghostOrder],
    fetchImpl: async (url) => String(url).includes('/api/my-orders')
      ? { ok: true, json: async () => ({ orders: [orderWith({ orderId: 'ORD-REAL' })] }) }
      : { ok: true, json: async () => ({ products: CATALOG }) }
  });

  const list = document.getElementById('orders-list');
  assert.strictEqual(list.children.length, 1, 'only the server order is listed');
  assert.ok(list.children[0].innerHTML.includes('ORD-REAL'));
  assert.ok(!list.children[0].innerHTML.includes('ORD-GHOST'));
});

await checkAsync('a guest keeps the localStorage fallback', async () => {
  const document = await runPage(ORDERS_URL, {
    search: '?tab=orders',
    authenticated: false,
    localOrders: [ghostOrder],
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'no' }) })
  });

  const list = document.getElementById('orders-list');
  assert.strictEqual(list.children.length, 1,
    'a guest still sees the orders mirrored on this device');
  assert.ok(list.children[0].innerHTML.includes('ORD-GHOST'));
});

await checkAsync('problem 1: an item whose product left the catalog keeps its tile', async () => {
  // p-sold-out is not in CATALOG: /api/products drops products that are
  // hidden (sold out for 24h) or deleted, and before the fix the whole image
  // was dropped with them.
  const [html] = await ordersPageHtml([
    orderWith({
      items: [
        { productId: 'p-milk', quantity: 1 },
        { productId: 'p-sold-out', name: 'لبن زبادي', price: 4.5, quantity: 2 }
      ]
    })
  ]);

  assert.strictEqual((html.match(/class="order-item-img"/g) || []).length, 2,
    'both ordered items must show a preview tile');
  assert.ok(html.includes('title="لبن زبادي"'), 'the name is taken from the order itself');
  assert.ok(html.includes('inventory_2'), 'the missing photo falls back to an icon');
});

// The same fallback powers the tracking and customer-order item lists (all
// three pages share it), so the helper is checked directly here too.
const { resolveOrderItem } = await import(
  new URL('../public/js/data/products.js', import.meta.url).href
);

await checkAsync('problem 1: resolveOrderItem falls back to the order copy', async () => {
  const gone = resolveOrderItem(
    { productId: 'p-gone', name: 'لبن زبادي', price: 4.5, quantity: 2 },
    undefined
  );
  assert.strictEqual(gone.name, 'لبن زبادي');
  assert.strictEqual(gone.imageUrl, '');
  assert.strictEqual(gone.price.original, '4.50');
  assert.strictEqual(gone.price.hasDiscount, false);

  const live = resolveOrderItem(
    { productId: 'p-milk', name: 'اسم قديم', price: 1, quantity: 1 },
    { name: 'حليب المراعي', imageUrl: '/img/milk.png', priceCents: 700 }
  );
  assert.strictEqual(live.name, 'حليب المراعي', 'the live catalog wins when it has the product');
  assert.strictEqual(live.imageUrl, '/img/milk.png');
  assert.strictEqual(live.price.original, '7.00');
});

// ─── Part 3: owner page — finished hides and untouched edits ──

console.log('\nPart 3 — owner alternatives page: no stale hide, no accidental re-hide');

const OWNER_URL = new URL('../public/js/scripts/owner-browsing.js', import.meta.url).href;
const HOUR_MS = 60 * 60 * 1000;

const ownerProduct = (extra = {}) => ({
  id: 'p-milk',
  name: 'حليب المراعي',
  type: 'dairy',
  priceCents: 700,
  keyWords: ['حليب'],
  unlimitedQuantity: true,
  ...extra
});

/**
 * Load the owner alternatives page with one product in the catalog and hand
 * the scenario the fake document plus every PUT body the page sent.
 * @param {Object} [options]
 * @param {string} [options.search] - query string (review mode: ?replacement=1&order=…)
 * @param {Object|null} [options.review] - the parked replacement review
 * @param {Object|null} [options.order] - the reviewed order
 */
async function withOwnerPage(product, scenario, options = {}) {
  const { search = '', review = null, order = null } = options;
  const document = makeDocument();

  [['qty-mode', 'unlimited', true], ['qty-mode', 'limited', false],
   ['visibility-mode', 'visible', true], ['visibility-mode', 'hidden', false],
   ['hide-duration', '24', true], ['hide-duration', 'custom', false],
   ['discount-mode', 'none', true], ['discount-mode', 'active', false],
   ['discount-duration', 'none', true], ['discount-duration', 'custom', false]
  ].forEach(([name, value, checked]) => document.registerInput(name, value, checked));

  const puts = [];
  const alerts = [];
  const originalFetch = globalThis.fetch;

  globalThis.document = document;
  globalThis.window = {
    location: { origin: 'http://localhost:5000', href: '', search },
    addEventListener() {},
    dispatchEvent() {}
  };
  globalThis.localStorage = makeLocalStorage();
  globalThis.alert = (message) => { alerts.push(String(message)); };

  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'PUT') {
      puts.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ product }) };
    }
    const target = String(url);
    if (target.includes('/api/admin/replacements/')) {
      return { ok: true, json: async () => ({ replacements: review }) };
    }
    if (target.includes('/api/admin/orders/')) {
      return { ok: true, json: async () => ({ order }) };
    }
    return { ok: true, json: async () => ({ products: [product] }) };
  };

  try {
    await import(`${OWNER_URL}?scenario=${Math.random()}`);
    const onReady = (document.listeners.DOMContentLoaded || [])[0];
    assert.ok(onReady, 'the owner page registered a DOMContentLoaded handler');
    await onReady();
    await scenario({ document, puts, alerts });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** Click تعديل on a card */
async function clickEdit(document, productId = 'p-milk') {
  const btn = new FakeEl('button');
  btn.className = 'edit-btn';
  btn.dataset.productId = productId;
  await fireClick(document.getElementById('products-grid'), {
    closest: (selector) => (selector === '.edit-btn' ? btn : null)
  });
}

/** Fill a valid price and press حفظ in the edit modal */
async function clickSave(document) {
  document.getElementById('edit-price-input').value = '7.00';
  await fireClick(document.getElementById('edit-save-btn'), { closest: () => null });
}

const firstCardHtml = (document) => document.getElementById('products-grid').children[0].innerHTML;

await checkAsync('a finished 24h hide shows no «انتهت مدة الإخفاء» tag', async () => {
  await withOwnerPage(ownerProduct({
    unlimitedQuantity: false,
    stockQuantity: 4,
    hidden: true,
    hideUntil: new Date(Date.now() - HOUR_MS).toISOString(),
    hideReason: 'unavailable'
  }), async ({ document }) => {
    const html = firstCardHtml(document);
    assert.ok(!html.includes('انتهت مدة الإخفاء'), `stale tag on the card:\n${html}`);
    assert.ok(html.includes('4 في المخزون'), 'the card shows the real stock instead');
  });
});

await checkAsync('a capped card shows the owner stock next to what customers may order', async () => {
  await withOwnerPage(ownerProduct({
    unlimitedQuantity: false,
    ownerStock: 5,
    stockQuantity: 2
  }), async ({ document }) => {
    const html = firstCardHtml(document);
    assert.ok(html.includes('5 في المخزون'),
      `an accepted order must not reduce the owner's in-stock count:\n${html}`);
    assert.ok(html.includes('2 متاح للعملاء'),
      `the customer-facing availability is missing:\n${html}`);
  });
});

await checkAsync('a sold-out product hides the availability line for the owner', async () => {
  await withOwnerPage(ownerProduct({
    unlimitedQuantity: false,
    ownerStock: 5,
    stockQuantity: 0,
    hidden: true,
    hideUntil: new Date(Date.now() + 24 * HOUR_MS).toISOString(),
    hideReason: 'soldout'
  }), async ({ document }) => {
    const html = firstCardHtml(document);
    assert.ok(html.includes('5 في المخزون'), 'the owner still has the goods');
    assert.ok(html.includes('مخفي للعملاء لمدة 24 ساعة'),
      `the sold-out window replaces the availability line:\n${html}`);
    assert.ok(!html.includes('متاح للعملاء'), 'nothing is orderable right now');
  });
});

await checkAsync('a hidden product without a quantity shows no stock number', async () => {
  await withOwnerPage(ownerProduct({
    unlimitedQuantity: true,
    hidden: true,
    hideUntil: new Date(Date.now() + 24 * HOUR_MS).toISOString(),
    hideReason: 'unavailable'
  }), async ({ document }) => {
    const html = firstCardHtml(document);
    assert.ok(html.includes('مخفي للعملاء'), 'the hide window is shown');
    assert.ok(!html.includes('في المخزون'), 'there is no count to report');
  });
});

await checkAsync('the edit modal prefills and saves both numbers', async () => {
  await withOwnerPage(ownerProduct({
    unlimitedQuantity: false,
    ownerStock: 5,
    stockQuantity: 2
  }), async ({ document, puts }) => {
    await clickEdit(document);

    assert.strictEqual(String(document.getElementById('quantity-input').value), '5',
      'the form opens on the owner stock');
    assert.strictEqual(String(document.getElementById('available-input').value), '2',
      'and on the customer-facing availability');

    const before = puts.length;
    await clickSave(document);
    const quantity = puts.slice(before).map((body) => body.quantity).find(Boolean);

    assert.deepStrictEqual(quantity, { mode: 'limited', inStock: 5, value: 2 },
      'saving an untouched form keeps both numbers exactly as they were');
  });
});

await checkAsync('the edit modal can restock and reserve at the same time', async () => {
  await withOwnerPage(ownerProduct({
    unlimitedQuantity: false,
    ownerStock: 5,
    stockQuantity: 2
  }), async ({ document, puts }) => {
    await clickEdit(document);
    document.getElementById('quantity-input').value = '10';
    document.getElementById('available-input').value = '4';

    const before = puts.length;
    await clickSave(document);
    const quantity = puts.slice(before).map((body) => body.quantity).find(Boolean);

    assert.deepStrictEqual(quantity, { mode: 'limited', inStock: 10, value: 4 });
  });
});

await checkAsync('حفظ refuses an availability larger than the stock on hand', async () => {
  await withOwnerPage(ownerProduct({
    unlimitedQuantity: false,
    ownerStock: 5,
    stockQuantity: 2
  }), async ({ document, puts, alerts }) => {
    await clickEdit(document);
    document.getElementById('quantity-input').value = '2';
    document.getElementById('available-input').value = '5';

    const before = puts.length;
    await clickSave(document);

    assert.strictEqual(puts.length, before,
      'an impossible pair must never reach the server');
    assert.strictEqual(alerts.length, 1, 'the owner is told why nothing was saved');
    assert.ok(alerts[0].includes('الكمية في المخزون'), alerts[0]);
    assert.ok(alerts[0].includes('المتاح للعملاء'), alerts[0]);
  });
});

await checkAsync('حفظ allows stock exactly equal to the availability', async () => {
  await withOwnerPage(ownerProduct({
    unlimitedQuantity: false,
    ownerStock: 5,
    stockQuantity: 2
  }), async ({ document, puts, alerts }) => {
    await clickEdit(document);
    document.getElementById('quantity-input').value = '4';
    document.getElementById('available-input').value = '4';

    const before = puts.length;
    await clickSave(document);
    const quantity = puts.slice(before).map((body) => body.quantity).find(Boolean);

    assert.deepStrictEqual(quantity, { mode: 'limited', inStock: 4, value: 4 });
    assert.deepStrictEqual(alerts, [], 'selling everything on the shelf is fine');
  });
});

await checkAsync('«تعديل» on a finished hide opens on ظاهر and حفظ sends no hide', async () => {
  await withOwnerPage(ownerProduct({
    unlimitedQuantity: false,
    stockQuantity: 4,
    hidden: true,
    hideUntil: new Date(Date.now() - HOUR_MS).toISOString(),
    hideReason: 'unavailable'
  }), async ({ document, puts }) => {
    await clickEdit(document);

    assert.strictEqual(document.getInput('visibility-mode', 'visible').checked, true);
    assert.strictEqual(document.getInput('visibility-mode', 'hidden').checked, false);
    assert.strictEqual(document.getElementById('hidden-until-hint').style.display, 'none');

    const before = puts.length;
    await clickSave(document);
    const saved = puts.slice(before);

    assert.ok(saved.length > 0, 'the rest of the form is still saved');
    assert.ok(!saved.some((body) => body.hide), 'the product must NOT be hidden again');
  });
});

await checkAsync('a running hide is shown and a plain حفظ does not restart it', async () => {
  await withOwnerPage(ownerProduct({
    unlimitedQuantity: false,
    stockQuantity: 4,
    hidden: true,
    hideUntil: new Date(Date.now() + 5 * HOUR_MS).toISOString(),
    hideReason: 'unavailable'
  }), async ({ document, puts }) => {
    assert.ok(firstCardHtml(document).includes('مخفي'), 'the badge shows the hide');

    await clickEdit(document);
    assert.strictEqual(document.getInput('visibility-mode', 'hidden').checked, true);
    assert.ok(String(document.getElementById('hidden-until-hint').style.display).includes('block'));

    const before = puts.length;
    await clickSave(document);
    assert.ok(!puts.slice(before).some((body) => body.hide),
      'saving without a change must not extend the hide');
  });
});

await checkAsync('a real change to مخفي still hides the product for 24 hours', async () => {
  await withOwnerPage(ownerProduct(), async ({ document, puts }) => {
    await clickEdit(document);
    document.selectInput('visibility-mode', 'hidden');

    const before = puts.length;
    await clickSave(document);
    const hide = puts.slice(before).map((body) => body.hide).find(Boolean);

    assert.deepStrictEqual(hide, { hidden: true, hours: 24 });
  });
});

await checkAsync('a real change to ظاهر unhides the product', async () => {
  await withOwnerPage(ownerProduct({
    hidden: true,
    hideUntil: new Date(Date.now() + 3 * HOUR_MS).toISOString()
  }), async ({ document, puts }) => {
    await clickEdit(document);
    document.selectInput('visibility-mode', 'visible');

    const before = puts.length;
    await clickSave(document);
    const hide = puts.slice(before).map((body) => body.hide).find(Boolean);

    assert.deepStrictEqual(hide, { hidden: false });
  });
});

// ─── Replacement review mode ─────────────────────────────────
// Item 5: «المنتجات المقترحة» is the view the owner uses to change their
// mind, so a marked card gets a one-click undo that drops the mark and
// persists the review again.

const REVIEW_ITEM = encodeURIComponent('حليب المراعي');

await checkAsync('review mode: a marked card in المنتجات المقترحة has an undo button', async () => {
  await withOwnerPage(
    ownerProduct(),
    async ({ document, puts }) => {
      // The parked review + the order arrive asynchronously — let them land
      await new Promise((resolve) => setTimeout(resolve, 0));

      await fireClick(document.getElementById('suggested-btn'), { closest: () => null });

      const cards = () => document.getElementById('products-grid').children;
      assert.ok(cards().length === 1, 'the suggested view shows the order item');
      assert.ok(cards()[0].innerHTML.includes('repl-btn unavailable active'),
        `the owner's earlier mark is still shown:\n${cards()[0].innerHTML}`);
      assert.ok(cards()[0].innerHTML.includes('repl-clear-btn'),
        `the undo button is missing from the suggested card:\n${cards()[0].innerHTML}`);

      // Click إلغاء on that card
      const clearBtn = new FakeEl('button');
      clearBtn.className = 'repl-clear-btn';
      const wrap = new FakeEl('div');
      wrap.className = 'replacement-btns';
      wrap.dataset.productId = 'p-milk';
      clearBtn.closest = (selector) => (selector === '.replacement-btns' ? wrap : null);

      const before = puts.length;
      await fireClick(document.getElementById('products-grid'), {
        closest: (selector) => (selector === '.repl-clear-btn' ? clearBtn : null)
      });

      const sent = puts.slice(before);
      assert.ok(
        sent.some((body) => Array.isArray(body.replacements) && body.replacements.length === 0),
        `the cleared review must be persisted:\n${JSON.stringify(sent)}`
      );

      const after = cards();
      assert.ok(after.length === 1, 'the item stays in the suggested list');
      assert.ok(!after[0].innerHTML.includes('repl-clear-btn'),
        'an unmarked card no longer offers an undo');
      assert.ok(!after[0].innerHTML.includes('active'),
        'and no availability button stays selected');
    },
    {
      search: '?replacement=1&order=ORD-1&item=' + REVIEW_ITEM,
      review: {
        replacements: [
          { productId: 'p-milk', name: 'حليب المراعي', state: 'unavailable', ordered: 2, available: null }
        ]
      },
      order: {
        orderId: 'ORD-1',
        items: [{ productId: 'p-milk', name: 'حليب المراعي', quantity: 2 }]
      }
    }
  );
});

await checkAsync('review mode: عرض الكل keeps the whole catalog (no undo button)', async () => {
  await withOwnerPage(
    ownerProduct(),
    async ({ document }) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const cards = document.getElementById('products-grid').children;
      assert.ok(cards.length === 1, 'the catalog is rendered');
      assert.ok(cards[0].innerHTML.includes('repl-clear-btn') === false,
        'the undo button belongs to المنتجات المقترحة only');
    },
    {
      search: '?replacement=1&order=ORD-1',
      review: { replacements: [] },
      order: { orderId: 'ORD-1', items: [] }
    }
  );
});

// ─── Part 4: the badge row reserves its space ────────────────

console.log('\nPart 4 — a card never changes height when a badge appears');

// The visual half of the fix lives in CSS: the badge row is measured for two
// lines (= two stacked pills, or one pill plus the hide window) on EVERY card,
// and a pill may not break into two text lines on a narrow card. Together they
// keep every card the same height, no matter which badges it shows.
//
// scripts/layout-check.html proves it in a real browser across viewports; these
// guards only keep the two declarations from being deleted by accident.
const alternativesCss = fs.readFileSync(
  new URL('../public/css/alternatives.css', import.meta.url), 'utf8'
);
const cssBlock = (selector) => {
  const match = alternativesCss.replace(/\/\*[\s\S]*?\*\//g, '')
    .match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} must be styled in alternatives.css`);
  return match[1];
};

await checkAsync('.stock-row keeps room for a second badge line', () => {
  const block = cssBlock('\\.stock-row');
  const minHeight = block.match(/min-height:\s*(\d+)px/);
  assert.ok(minHeight, `.stock-row needs a min-height:\n${block}`);
  // 2 × (12px × 1.25 + 8px padding) + 6px gap
  assert.strictEqual(Number(minHeight[1]), 52,
    'the reserved height must fit exactly two badge lines and one gap');
});

await checkAsync('.stock-badge never breaks its label into two lines', () => {
  const block = cssBlock('\\.stock-badge');
  assert.ok(/white-space:\s*nowrap/.test(block),
    `«مخفي للعملاء لمدة 24 ساعة» must stay on one line:\n${block}`);
});

// ─── Summary ─────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
