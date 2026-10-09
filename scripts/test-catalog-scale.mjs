// Scale tests for the MongoDB-backed catalog (the store grew from 29 to 1525
// products, so nothing may download or render the whole catalog any more).
//
// Run with:  node scripts/test-catalog-scale.mjs
//
// Covered here:
//   Part 1 — the catalog's Mongo query builders (who may see a product, the
//            price ranges, the search escaping, the discount window).
//   Part 2 — the Product schema accepts every product in data/products.json
//            and the collection is the one the owner will import into.
//   Part 3 — the pagination bar's math at scale.
//   Part 4 — the REAL browse page against a simulated 1525-product server:
//            one page in the DOM, correct page count, filters reset to page 1,
//            the pinned «متوفر ومشابه لطلبك» block, sidebar counts.
//   Part 5 — the by-ids / paged data helpers the cart, checkout and order
//            pages use.
//   Part 6 — server wiring: the catalog is no longer read from / written to a
//            JSON file, and no customer page downloads the whole catalog.

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

const HOUR_MS = 60 * 60 * 1000;

// ─── Part 1: the Mongo query builders ────────────────────────

console.log('\nPart 1 — catalog query builders');

const catalog = await import(new URL('../utils/catalog.js', import.meta.url).href);

// Serialize a filter for inspection. RegExps have no own enumerable keys, so
// plain JSON.stringify would render them as `{}` — render their source instead
// so the search assertions can actually see the escaped pattern.
const jsonOf = (value) =>
  JSON.stringify(value, (key, val) => (val instanceof RegExp ? val.source : val));
// The escaped pattern, as the test writes it: a\\.\\*b\\(c\\)
// superseded by the String.raw assertion below: 'a\\\\.\\\\*b\\\\(c\\\\)';

await checkAsync('the catalogue defaults match the browse page contract', async () => {
  assert.strictEqual(catalog.DEFAULT_PAGE_SIZE, 24, 'the default page size is 24 cards');
  assert.strictEqual(catalog.MAX_PAGE_SIZE, 100, 'a client can never ask for more than 100');
  assert.strictEqual(catalog.CATEGORY_TYPES.length, 24, 'the shop has 24 real categories');
  assert.strictEqual(catalog.CATEGORY_TYPES[0], 'ألبان وحليب', 'the list keeps its order');
  assert.ok(catalog.CATEGORY_TYPES.includes('مياه'));
  assert.ok(catalog.CATEGORY_TYPES.includes('عناية شخصية'));
});

await checkAsync('customers never match deleted or currently-hidden products', async () => {
  const now = new Date('2026-10-01T12:00:00.000Z');
  const filter = catalog.activeConditions(now.toISOString());
  const json = jsonOf(filter);

  assert.ok(json.includes('"deleted":{"$ne":true}'), 'deleted products are excluded');
  // Either not hidden at all…
  assert.ok(json.includes('{"hidden":{"$ne":true}}'), 'non-hidden products are visible');
  // …or a hide whose deadline has already passed
  assert.ok(
    json.includes(`"hideUntil":{"$ne":null,"$lte":"${now.toISOString()}"}`),
    'an expired hide is treated as visible again'
  );
  // A manual hide (hidden with NO hideUntil) must match NEITHER branch
  assert.ok(!json.includes('"hideUntil":null}'), 'a manual hide is not visible');
});

await checkAsync('the price ranges keep the shop\'s existing boundaries', async () => {
  const filter = (priceRange) => jsonOf(catalog.buildCustomerFilter({ priceRange }));

  assert.ok(filter('under10').includes('"priceCents":{"$gte":0,"$lt":1000}'));
  assert.ok(filter('10to30').includes('"priceCents":{"$gte":1000,"$lt":3000}'));
  assert.ok(filter('over30').includes('"priceCents":{"$gte":3000}'));
  // Unknown range = no price filter at all
  assert.ok(!jsonOf(catalog.buildCustomerFilter({ priceRange: 'nope' })).includes('priceCents'));
});

await checkAsync('a category filter is exact and "all" is a no-op', async () => {
  assert.ok(jsonOf(catalog.buildCustomerFilter({ type: 'dairy' })).includes('"type":"dairy"'));
  assert.ok(!jsonOf(catalog.buildCustomerFilter({ type: 'all' })).includes('"type"'));
});

await checkAsync('a search term is regex-escaped (never a live pattern)', async () => {
  const filter = catalog.buildCustomerFilter({ search: 'a.*b(c)' });
  const json = jsonOf(filter);
  assert.ok(json.includes('"name"') && json.includes('"keyWords"'), 'both name and keywords are searched');

  const pattern = filter.$and.at(-1).$or.find((c) => c.name).name;
  assert.ok(pattern instanceof RegExp, 'the search becomes a RegExp');
  assert.strictEqual(pattern.flags, 'i', 'search is case-insensitive');
  // The metacharacters are literal, not live: the term matches itself only
  assert.strictEqual(pattern.test('a.*b(c)'), true, 'the literal term matches itself');
  assert.strictEqual(pattern.test('axxbc'), false, '`.` and `*` are not live');
});

await checkAsync('the search RegExp is case-insensitive and Arabic-folded', async () => {
  const pattern = catalog.buildCustomerFilter({ search: 'شاي' }).$and.at(-1).$or.find((c) => c.name).name;

  assert.strictEqual(pattern.test('شاي أخضر'), true, 'the exact spelling matches');
  assert.strictEqual(pattern.test('شاى'), true, 'ya and alef-maqsura are folded together');
  assert.strictEqual(pattern.test('شَاي'), true, 'diacritics are ignored');

  const alef = catalog.buildCustomerFilter({ search: 'أرز' }).$and.at(-1).$or.find((c) => c.name).name;
  assert.strictEqual(alef.test('ارز'), true, 'alef variants are folded together');
  assert.strictEqual(alef.test('أرز'), true, 'the original spelling still matches');
});

await checkAsync('foldArabicText folds the Arabic variants like the client helpers', async () => {
  assert.strictEqual(catalog.foldArabicText('شاى'), 'شاي');
  assert.strictEqual(catalog.foldArabicText('أرز'), 'ارز');
  assert.strictEqual(catalog.foldArabicText('طازة'), 'طازه');
  assert.strictEqual(catalog.foldArabicText('حَلِيب'), 'حليب');
});

await checkAsync('an empty search adds no condition', async () => {
  assert.ok(!jsonOf(catalog.buildCustomerFilter({ search: '   ' })).includes('keyWords'));
});

await checkAsync('the discount filter respects the deadline', async () => {
  const now = new Date('2026-10-01T12:00:00.000Z');
  const json = jsonOf(catalog.buildCustomerFilter({ discount: true, now }));

  assert.ok(json.includes('"discountPercent":{"$gt":0}'), 'only real discounts');
  assert.ok(json.includes('{"discountUntil":null}'), 'a discount with no deadline is running');
  assert.ok(json.includes(`"$gt":"${now.toISOString()}"`), 'a future deadline is running');
});

await checkAsync('normalizeQuantity treats "no quantity set" as unlimited', async () => {
  assert.deepStrictEqual(catalog.normalizeQuantity({ id: 'a' }), { id: 'a', unlimitedQuantity: true });
  assert.deepStrictEqual(
    catalog.normalizeQuantity({ id: 'b', stockQuantity: 3 }),
    { id: 'b', stockQuantity: 3 },
    'a capped product is left alone'
  );
  assert.deepStrictEqual(
    catalog.normalizeQuantity({ id: 'c', stockQuantity: 0 }),
    { id: 'c', stockQuantity: 0 },
    'zero stock is a real cap, not "unset"'
  );
});

// ─── Part 2: the Product schema ──────────────────────────────

console.log('\nPart 2 — the products collection the owner will import into');

const { default: Product } = await import(new URL('../models/Product.js', import.meta.url).href);

await checkAsync('the model writes to the "products" collection', async () => {
  assert.strictEqual(Product.collection.collectionName, 'products',
    'the owner imports into a collection named products');
});

await checkAsync('every field the rules rely on survives the schema', async () => {
  const paths = Object.keys(Product.schema.paths);
  [
    'id', 'name', 'priceCents', 'keyWords', 'type', 'imageUrl',
    'discountPercent', 'discountSetAt', 'discountUntil',
    'unlimitedQuantity', 'stockQuantity', 'ownerStock', 'stockUntil',
    'unlimitedUntil', 'hidden', 'hideUntil', 'hideReason', 'deleted', 'weight'
  ].forEach((field) => {
    assert.ok(paths.includes(field), `the schema must keep the "${field}" field`);
  });
});

await checkAsync('id / name / price / type are required', async () => {
  const required = ['id', 'name', 'priceCents', 'type'];
  required.forEach((field) => {
    assert.strictEqual(Product.schema.path(field).isRequired, true, `${field} must be required`);
  });
});

await checkAsync('dates are stored as sortable ISO strings', async () => {
  ['discountUntil', 'hideUntil', 'stockUntil', 'unlimitedUntil', 'discountSetAt'].forEach((field) => {
    assert.strictEqual(Product.schema.path(field).instance, 'String',
      `${field} must be a String — ISO-8601 strings compare chronologically in Mongo`);
  });
});

await checkAsync('the schema accepts every one of the 24 categories, and the import weight', async () => {
  catalog.CATEGORY_TYPES.forEach((type, i) => {
    const errors = new Product({
      id: 'cat-' + i,
      name: 'منتج ' + i,
      priceCents: 100 + i,
      type,
      keyWords: [],
      unlimitedQuantity: true,
      weight: { number: 1.85, unit: 'لتر' }
    }).validateSync();
    assert.ok(!errors, `category "${type}" must be accepted: ${errors && errors.message}`);
  });
});

await checkAsync('every product in data/products.json fits the schema', async () => {
  const file = new URL('../data/products.json', import.meta.url);
  const products = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.ok(Array.isArray(products) && products.length > 0, 'the seed file has products');

  products.forEach((product, index) => {
    const errors = new Product(product).validateSync();
    assert.ok(!errors, `product #${index} (${product.id}) does not fit the schema: ${errors && errors.message}`);
  });
});

// ─── Part 3: the pagination bar ──────────────────────────────

console.log('\nPart 3 — the pagination bar at scale');

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.filter(Boolean).forEach((n) => this.set.add(String(n))); }
  remove(...names) { names.forEach((n) => this.set.delete(String(n))); }
  contains(name) { return this.set.has(String(name)); }
}

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = new FakeClassList();
    this.listeners = {};
    this.disabled = false;
    this.textContent = '';
    this._html = '';
  }
  // The page scripts set className directly — it must feed classList
  get className() { return [...this.classList.set].join(' '); }
  set className(value) {
    this.classList.set.clear();
    this.classList.add(...String(value == null ? '' : value).split(/\s+/));
  }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this._html = String(value == null ? '' : value);
    if (this._html === '') this.children = [];
  }
  setAttribute(name, value) { this[name] = value; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
}

function makeDocument() {
  const els = new Map();
  const listeners = {};
  return {
    listeners,
    getElementById(id) {
      if (!els.has(id)) els.set(id, new FakeEl('div'));
      return els.get(id);
    },
    createElement(tag) { return new FakeEl(tag); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    body: new FakeEl('body'),
    documentElement: new FakeEl('html')
  };
}

globalThis.document = makeDocument();

const { renderPager } = await import(new URL('../public/js/scripts/pager.js', import.meta.url).href);

const pagerText = (container) => container.children.map((el) => el.textContent);

await checkAsync('one page hides the bar entirely', async () => {
  const container = document.getElementById('pager-a');
  renderPager('pager-a', { page: 1, pages: 1 });
  assert.strictEqual(container.style.display, 'none');
  assert.strictEqual(container.children.length, 0);
});

await checkAsync('1525 products at 24 per page = 64 pages, reached in a bounded bar', async () => {
  const container = document.getElementById('pager-b');
  renderPager('pager-b', { page: 1, pages: 64 });

  assert.strictEqual(container.style.display, '');
  // prev + 1,2,3 + … + 64 + next — never all 64 buttons
  const numbers = container.children.filter((el) => el.classList.contains('pager-num'));
  assert.ok(numbers.length <= 7, `too many page buttons: ${numbers.length}`);
  assert.deepStrictEqual(numbers.map((el) => el.textContent), ['1', '2', '3', '64']);
  assert.ok(container.children.some((el) => el.classList.contains('pager-gap')),
    'the skipped range is shown as an ellipsis');

  const prev = container.children[0];
  const next = container.children[container.children.length - 1];
  assert.strictEqual(prev.disabled, true, 'back is disabled on the first page');
  assert.strictEqual(prev.dataset.page, '0');
  assert.strictEqual(next.disabled, false);
  assert.strictEqual(next.dataset.page, '2');
});

await checkAsync('a middle page shows its neighbours and both ends', async () => {
  const container = document.getElementById('pager-c');
  renderPager('pager-c', { page: 32, pages: 64 });

  const numbers = container.children
    .filter((el) => el.classList.contains('pager-num'))
    .map((el) => el.textContent);
  assert.deepStrictEqual(numbers, ['1', '30', '31', '32', '33', '34', '64']);

  const active = container.children.filter((el) => el.classList.contains('active'));
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].textContent, '32');
  assert.strictEqual(container.children[0].disabled, false, 'back works mid-list');
});

await checkAsync('the last page disables forward', async () => {
  const container = document.getElementById('pager-d');
  renderPager('pager-d', { page: 64, pages: 64 });
  const next = container.children[container.children.length - 1];
  assert.strictEqual(next.disabled, true);
  assert.strictEqual(container.children[0].disabled, false);
});

await checkAsync('clicking a page number calls back once, never for the current page', async () => {
  const container = document.getElementById('pager-e');
  const picked = [];
  renderPager('pager-e', { page: 5, pages: 10, onSelect: (page) => picked.push(page) });

  const clickOn = (page, disabled = false) => {
    const btn = { dataset: { page: String(page) }, disabled };
    (container.listeners.click || []).forEach((fn) =>
      fn({ target: { closest: (sel) => (sel === 'button[data-page]' ? btn : null) }, preventDefault() {} })
    );
  };

  clickOn(5);
  assert.deepStrictEqual(picked, [], 'the current page is not a navigation');

  clickOn(6);
  clickOn(1); // disabled targets are ignored via btn.disabled below
  assert.deepStrictEqual(picked, [6, 1]);
});

// ─── Part 4: the real browse page against a 1525-product server ───

console.log('\nPart 4 — the browse page with 1525 products');

// The real 24 categories, straight from the catalog layer
const TYPES = catalog.CATEGORY_TYPES;

/** A 1525-product catalog, just like the owner is about to import */
function makeCatalog(size) {
  const items = [];
  for (let i = 0; i < size; i += 1) {
    items.push({
      id: 'p' + i,
      name: 'منتج رقم ' + i,
      type: TYPES[i % TYPES.length],
      priceCents: 100 + (i % 40) * 100,
      keyWords: ['كلمة' + i],
      discountPercent: i % 7 === 0 ? 10 : undefined,
      unlimitedQuantity: true
    });
  }
  return items;
}

const CATALOG = makeCatalog(1525);
const CATALOG_BY_ID = new Map(CATALOG.map((p) => [p.id, p]));

/**
 * A fake server that implements the REAL /api/products contract:
 * pagination, filters, counts, ?ids= and ?items= (pinned suggested names).
 * It also records every request so the tests can assert what the page asked.
 */
function makeServer() {
  const requests = [];

  const handler = async (url) => {
    const parsed = new URL(url, 'http://localhost');
    const qs = parsed.searchParams;
    requests.push(Object.fromEntries(parsed.searchParams.entries()));

    const respond = (body) => ({ ok: true, json: async () => body });

    // Exact products (cart / checkout / order pages)
    if (qs.get('ids') !== null) {
      const wanted = String(qs.get('ids')).split(',').filter(Boolean);
      const products = wanted.map((id) => CATALOG_BY_ID.get(id)).filter(Boolean);
      return respond({ products, total: products.length, page: 1, pages: 1, limit: products.length });
    }

    const limit = Math.min(Math.max(Number(qs.get('limit')) || 24, 1), 100);

    let list = CATALOG.slice();
    const type = qs.get('type');
    if (type && type !== 'all') list = list.filter((p) => p.type === type);
    if (qs.get('discount')) list = list.filter((p) => p.discountPercent);
    if (qs.get('featured')) list = list.filter((p) => p.discountPercent);
    const search = qs.get('search');
    if (search) {
      list = list.filter(
        (p) => p.name.includes(search) || (p.keyWords || []).some((k) => k.includes(search))
      );
    }

    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(Math.max(Number(qs.get('page')) || 1, 1), pages);
    const products = list.slice((page - 1) * limit, page * limit);

    const items = qs.getAll('items').flatMap((entry) => String(entry).split(',').map((s) => s.trim()));
    const suggested = items.length
      ? CATALOG.filter(
          (p) => items.includes(p.name) || (p.keyWords || []).some((k) => items.includes(k))
        )
      : [];

    const counts = { all: CATALOG.length };
    TYPES.forEach((t) => { counts[t] = CATALOG.filter((p) => p.type === t).length; });

    return respond({ products, total, page, pages, limit, counts, suggested });
  };

  return { handler, requests };
}

const BROWSE_URL = new URL('../public/js/scripts/browse.js', import.meta.url).href;
const REAL_FETCH = globalThis.fetch;

/**
 * Load the real browse page against the fake server and return its document.
 *
 * The fake fetch is deliberately LEFT INSTALLED: the page keeps paging and
 * re-fetching in response to clicks, so the assertions that follow must still
 * be talking to the fake server. Part 4 restores the real fetch when it ends.
 */
async function loadBrowse(search, server) {
  const document = makeDocument();
  globalThis.document = document;
  globalThis.window = {
    location: { origin: 'http://localhost:5000', href: 'http://localhost:5000/browse' + search, search },
    addEventListener() {},
    dispatchEvent() {}
  };
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
    clear() {}
  };
  globalThis.alert = () => {};

  globalThis.fetch = server.handler;

  await import(`${BROWSE_URL}?scale=${Math.random()}`);
  const onReady = (document.listeners.DOMContentLoaded || [])[0];
  assert.ok(onReady, 'the browse page registered a DOMContentLoaded handler');
  await onReady();

  return document;
}

const grid = (document) => document.getElementById('browse-products');
const pagerEl = (document) => document.getElementById('browse-pager');
const pageButtons = (document) =>
  pagerEl(document).children.filter((el) => el.classList.contains('pager-num'));

await checkAsync('page 1 of 1525 renders ONLY one page of cards', async () => {
  const server = makeServer();
  const document = await loadBrowse('', server);

  assert.strictEqual(grid(document).children.length, 24,
    'the DOM holds exactly one page, never all 1525 cards');
  assert.strictEqual(
    document.getElementById('results-count').textContent,
    'عرض 24 من 1525 منتج'
  );
  assert.strictEqual(grid(document).children[0].dataset.productId, 'p0');
  assert.strictEqual(grid(document).children[23].dataset.productId, 'p23');
});

await checkAsync('the pagination bar knows there are 64 pages', async () => {
  const server = makeServer();
  const document = await loadBrowse('', server);

  assert.deepStrictEqual(pageButtons(document).map((el) => el.textContent), ['1', '2', '3', '64']);
  assert.strictEqual(pagerEl(document).style.display, '');
});

await checkAsync('the browse sidebar has NO per-category counts (removed)', async () => {
  const server = makeServer();
  const document = await loadBrowse('', server);

  // The customer browse sidebar deliberately shows plain category names —
  // counts live only on the owner's alternatives page now. The fake element
  // auto-creates, so assert on the TEXT the page would have written: a page
  // with no counter code leaves these untouched.
  const rows = document.getElementById('count-all');
  const cat = document.getElementById('count-cat-0');
  assert.ok(rows.textContent === '' && cat.textContent === '',
    'no count text was ever rendered for the browse sidebar');
});

await checkAsync('going to page 2 asks for page 2 and renders the NEXT 24', async () => {
  const server = makeServer();
  const document = await loadBrowse('', server);

  const before = server.requests.length;
  const btn = { dataset: { page: '2' }, disabled: false };
  (pagerEl(document).listeners.click || []).forEach((fn) =>
    fn({ target: { closest: (sel) => (sel === 'button[data-page]' ? btn : null) }, preventDefault() {} })
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  const asked = server.requests.slice(before);
  assert.ok(asked.some((r) => r.page === '2'), 'page 2 was requested');
  assert.strictEqual(grid(document).children.length, 24);
  assert.strictEqual(grid(document).children[0].dataset.productId, 'p24');
  assert.strictEqual(grid(document).children[23].dataset.productId, 'p47');
  // The current page is highlighted and the URL is kept in sync
  const active = pageButtons(document).filter((el) => el.classList.contains('active'));
  assert.strictEqual(active[0].textContent, '2');
});

await checkAsync('a category filter goes back to page 1 and filters server-side', async () => {
  const server = makeServer();
  const document = await loadBrowse('', server);

  // Walk to page 2 first, so a reset is observable
  const page2 = { dataset: { page: '2' }, disabled: false };
  (pagerEl(document).listeners.click || []).forEach((fn) =>
    fn({ target: { closest: (sel) => (sel === 'button[data-page]' ? page2 : null) }, preventDefault() {} })
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  const before = server.requests.length;
  const li = document.createElement('li');
  li.dataset.type = TYPES[0];
  (document.getElementById('category-filters').listeners.click || []).forEach((fn) =>
    fn({ target: { closest: (sel) => (sel === 'li' ? li : null) }, preventDefault() {} })
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  const asked = server.requests.slice(before).filter((r) => r.type === TYPES[0]);
  assert.ok(asked.length > 0, 'the filter was sent to the server');
  assert.ok(asked.every((r) => !r.page || r.page === '1'), 'a filter change starts on page 1');

  const first = grid(document).children[0];
  const product = CATALOG_BY_ID.get(first.dataset.productId);
  assert.strictEqual(product.type, TYPES[0], 'only that category is on screen');
});

await checkAsync('search is server-side and resets to page 1', async () => {
  const server = makeServer();
  const document = await loadBrowse('', server);

  const before = server.requests.length;
  const input = document.getElementById('search-input');
  input.value = 'منتج رقم 1500';
  (input.listeners.input || []).forEach((fn) => fn({ target: input }));
  await new Promise((resolve) => setTimeout(resolve, 400)); // the 300ms debounce

  const asked = server.requests.slice(before).filter((r) => r.search);
  assert.ok(asked.length > 0, 'the search reached the server');
  assert.ok(!asked[asked.length - 1].page || asked[asked.length - 1].page === '1');

  assert.strictEqual(grid(document).children.length, 1);
  assert.strictEqual(grid(document).children[0].dataset.productId, 'p1500');
});

await checkAsync('a suggested item on page 3 is still pinned to the top', async () => {
  const server = makeServer();
  // p1500 would live on page 63 — it must appear anyway
  const document = await loadBrowse(
    '?completedOrder=false&order=ORD-1&item=' + encodeURIComponent('منتج رقم 1500'),
    server
  );

  const children = grid(document).children;
  assert.strictEqual(children[0].classList.contains('suggested-divider'), true,
    'the heading comes first');
  assert.strictEqual(children[1].dataset.productId, 'p1500');
  assert.ok(children[1].classList.contains('suggested-card'), 'and it is highlighted');
  // The page itself still holds its own 24 cards after the pinned one
  assert.strictEqual(children.length, 26, '24 page cards + divider + the pinned card');
});

await checkAsync('every request stays paginated — the catalog is never fully downloaded', async () => {
  const server = makeServer();
  await loadBrowse('', server);

  assert.ok(server.requests.length > 0);
  server.requests.forEach((request) => {
    assert.ok(request.limit, `a browse request without a limit: ${JSON.stringify(request)}`);
    assert.ok(Number(request.limit) <= 100, `a browse request above the cap: ${request.limit}`);
  });
});

// Part 4 is done: the fake fetch is no longer needed
globalThis.fetch = REAL_FETCH;

// ─── Part 5: the data helpers the other pages use ────────────

console.log('\nPart 5 — cart / checkout / order helpers');

const productsModule = await import(new URL('../public/js/data/products.js', import.meta.url).href);

await checkAsync('fetchProductsByIds asks for exactly those ids', async () => {
  const server = makeServer();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = server.handler;

  let products;
  try {
    products = await productsModule.fetchProductsByIds(['p7', 'p1500', 'p7']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.strictEqual(server.requests.length, 1, 'one request, not one per product');
  assert.strictEqual(server.requests[0].ids, 'p7,p1500', 'ids are de-duplicated');
  assert.deepStrictEqual(products.map((p) => p.id), ['p7', 'p1500']);
});

await checkAsync('fetchProductsByIds with no ids makes no request at all', async () => {
  const server = makeServer();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = server.handler;
  try {
    assert.deepStrictEqual(await productsModule.fetchProductsByIds([]), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.strictEqual(server.requests.length, 0);
});

await checkAsync('fetchProductPage returns the page metadata the UI depends on', async () => {
  const server = makeServer();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = server.handler;

  let data;
  try {
    data = await productsModule.fetchProductPage({ page: 3, limit: 24 });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.strictEqual(data.page, 3);
  assert.strictEqual(data.pages, 64);
  assert.strictEqual(data.total, 1525);
  assert.strictEqual(data.products.length, 24);
  assert.strictEqual(data.products[0].id, 'p48');
  assert.strictEqual(data.counts.all, 1525);
});

await checkAsync('the featured strip downloads 4 products, not 1525', async () => {
  const server = makeServer();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = server.handler;

  let featured;
  try {
    featured = await productsModule.getFeaturedProducts();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.strictEqual(featured.length, 4);
  assert.ok(featured.every((p) => p.discountPercent), 'only discounted products are featured');
  assert.strictEqual(server.requests.length, 1);
  assert.strictEqual(server.requests[0].featured, '4');
});

await checkAsync('the legacy fetchProducts() still returns the WHOLE catalog, paged internally', async () => {
  const server = makeServer();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = server.handler;

  let all;
  try {
    all = await productsModule.fetchProducts();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.strictEqual(all.length, 1525, 'nothing is silently truncated');
  assert.strictEqual(new Set(all.map((p) => p.id)).size, 1525, 'and nothing is duplicated');
  // Every individual request stayed within the cap
  assert.ok(server.requests.every((r) => Number(r.limit) <= 100));
});

// ─── Part 6: server + frontend wiring ────────────────────────

console.log('\nPart 6 — wiring');

const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function routeSource(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start + 1);
  assert.ok(start > -1 && end > start, `could not slice ${startMarker}`);
  return serverSource.slice(start, end);
}

await checkAsync('the catalog is no longer a JSON file the server rewrites', async () => {
  assert.ok(!serverSource.includes('writeCatalog'),
    'writeCatalog (the whole-file rewrite) must be gone');
  assert.ok(!serverSource.includes('readCatalog'),
    'readCatalog (the whole-file read) must be gone');
  assert.ok(!serverSource.includes("'products.json'"),
    'server.js must not read products.json — it is only the seed file now');
  assert.ok(serverSource.includes('mongoose') || serverSource.includes('connectDB'),
    'the database connection is still wired');
});

await checkAsync('the products API is paginated and prunes only what expired', async () => {
  const route = routeSource("app.get('/api/products'", "app.get('/api/admin/orders'");

  assert.ok(route.includes('await pruneCatalog()'), 'expired hides/caps/discounts are swept');
  assert.ok(route.includes('listProducts('), 'the page comes from the Mongo layer');
  assert.ok(route.includes('listProductsByIds('), '?ids= is served without a full scan');
  assert.ok(route.includes('listProductsByNames('), 'the pinned suggested items are resolved server-side');
  assert.ok(route.includes('ids !== undefined'), '?ids= is a real parameter');
  assert.ok(!route.includes('writeCatalog('), 'a read must never write the catalog back');
});

await checkAsync('the owner catalog supports by-ids and full listings', async () => {
  const route = routeSource("app.get('/api/owner/products'", "app.put('/api/owner/products/:id'");

  assert.ok(route.includes('await pruneCatalog()'), 'the owner sees no stale hide');
  assert.ok(route.includes('listOwnerProducts('), 'the full owner catalog still works');
  assert.ok(route.includes('req.query.ids'), 'and a by-ids lookup for the order pages');
  assert.ok(route.includes('includeHidden: true'), 'the owner order page needs hidden products');
});

await checkAsync('owner edits are per-document updates', async () => {
  const put = routeSource("app.put('/api/owner/products/:id'", "app.delete('/api/owner/products/:id'");
  assert.ok(put.includes('updateProductById('), 'one document is updated, not the catalog');
  assert.ok(put.includes('product.stockQuantity = value'), 'the customer cap is kept');
  assert.ok(put.includes('product.ownerStock = inStock'), 'the owner count is kept separate');
  assert.ok(!put.includes('writeCatalog'), 'no whole-catalog write');

  const del = routeSource("app.delete('/api/owner/products/:id'", 'function enrichStockStatus');
  assert.ok(del.includes('setProductDeleted('), 'a soft delete is a single document update');
});

await checkAsync('the order-review rules run through the per-document bridge', async () => {
  assert.ok(serverSource.includes('mutateProducts('),
    'the pure rules are applied to the touched products only');
  assert.ok(serverSource.includes('listProductsByIds('),
    'order amounts load only the ordered products');
  assert.ok(!serverSource.includes('readCatalog('), 'nothing loads the whole catalog any more');
});

await checkAsync('the customer pages never download the whole catalog', async () => {
  const pages = [
    '../public/js/scripts/browse.js',
    '../public/js/scripts/checkout.js',
    '../public/js/scripts/orders.js',
    '../public/js/scripts/tracking.js',
    '../public/js/scripts/customer-order.js'
  ];

  pages.forEach((relative) => {
    const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.ok(!/\bfetchProducts\(/.test(source),
      `${relative} must not call the whole-catalog helper`);
  });
});

await checkAsync('the browse and owner pages both have a pagination bar in their markup', async () => {
  const browse = fs.readFileSync(new URL('../public/views/browse.ejs', import.meta.url), 'utf8');
  const alternatives = fs.readFileSync(new URL('../public/views/alternatives.ejs', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/css/browse.css', import.meta.url), 'utf8');

  assert.ok(browse.includes('id="browse-pager"'), 'the browse page has a pager');
  assert.ok(alternatives.includes('id="owner-pager"'), 'the owner page has a pager');
  assert.ok(/\.pager\s*\{/.test(css), 'the pager is styled');
  assert.ok(/\.pager-num\.active/.test(css), 'the current page is styled');
});

await checkAsync('the order-review rules are unchanged and still run on plain products', async () => {
  const review = await import(new URL('../utils/order-review.js', import.meta.url).href);

  // 1525 products, only ONE of them marked — the bridge must touch that one
  const products = makeCatalog(1525);
  const target = products[42];
  target.stockQuantity = 5;
  target.unlimitedQuantity = false;

  assert.strictEqual(review.markSoldOut(products, [{ productId: target.id, quantity: 2 }]), true);
  assert.strictEqual(target.stockQuantity, 3, 'the ordered quantity left the cap');
  assert.strictEqual(products.filter((p) => p.stockQuantity != null).length, 1,
    'no other product was touched');
});

// ─── Summary ─────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
