// Unit tests for the MongoDB-backed catalog layer (utils/catalog.js).
//
// Run with:  node scripts/test-catalog-db.mjs
//
// No database is required (and none is touched): the Mongoose model is
// replaced with an in-memory fake that records every call, so these tests
// check what the layer ASKS Mongo to do — the pagination window, the sort,
// the projection, and above all which fields get $unset when one of the pure
// order-review rules deletes them. (A plain $set would silently leave a stale
// `hidden: true` behind, which is exactly the bug this guards.)

import assert from 'assert';
import mongoose from 'mongoose';

import Product from '../models/Product.js';
import { markSoldOut, restoreSoldOut, applyReviewAvailability } from '../utils/order-review.js';
import {
  listProducts,
  listProductsByIds,
  listOwnerProducts,
  productImageMap,
  pruneCatalog,
  mutateProducts,
  updateProductById,
  createProduct,
  catalogCount,
  categoryCounts,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE
} from '../utils/catalog.js';

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

// ─── The fake model ──────────────────────────────────────────

let store = [];
let calls = [];
let nextObjectId = 0;

/** Does one document satisfy the (simple) filters the layer actually sends? */
function matches(doc, filter) {
  if (!filter || typeof filter !== 'object') return true;
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') return condition.every((part) => matches(doc, part));
    if (key === '$or') return condition.some((part) => matches(doc, part));
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if ('$in' in condition) return condition.$in.includes(doc[key]);
      if ('$ne' in condition) return doc[key] !== condition.$ne;
      if ('$lt' in condition) return doc[key] < condition.$lt;
      if ('$lte' in condition) return doc[key] <= condition.$lte;
      if ('$gt' in condition) return doc[key] > condition.$gt;
      if ('$gte' in condition) return doc[key] >= condition.$gte;
    }
    return doc[key] === condition;
  });
}

/**
 * A chainable, awaitable stand-in for a Mongoose Query. Everything the layer
 * chains (.sort/.skip/.limit/.select/.lean) is recorded ON the call entry, so
 * the tests can assert the exact window and projection that was requested.
 */
function query(resultFor, record = {}) {
  const q = {
    sort(spec) { record.sort = spec; return q; },
    skip(n) { record.skip = n; return q; },
    limit(n) { record.limit = n; return q; },
    select(spec) { record.select = spec; return q; },
    lean() { record.lean = true; return q; },
    then(resolve, reject) {
      const rows = resultFor(record);
      const start = record.skip || 0;
      const end = record.limit == null ? rows.length : start + record.limit;
      return Promise.resolve(rows.slice(start, end)).then(resolve, reject);
    }
  };
  return q;
}

function installFakeModel(docs) {
  store = docs.map((doc) => ({ _id: 'oid' + (nextObjectId += 1), ...doc }));
  calls = [];
  return store;
}

const findCall = () => calls.filter((c) => c.op === 'find').at(-1);
const updateCalls = () => calls.filter((c) => c.op === 'updateOne');

Product.find = (filter = {}) => {
  const entry = { op: 'find', filter };
  calls.push(entry);
  return query(() => store.filter((doc) => matches(doc, filter)), entry);
};

// findOne() resolves to a SINGLE document (or null) — never an array
Product.findOne = (filter = {}) => {
  const entry = { op: 'findOne', filter };
  calls.push(entry);
  const q = {
    select(spec) { entry.select = spec; return q; },
    lean() { entry.lean = true; return q; },
    then(resolve, reject) {
      return Promise.resolve(store.find((doc) => matches(doc, filter)) || null).then(resolve, reject);
    }
  };
  return q;
};

Product.countDocuments = async (filter = {}) => {
  calls.push({ op: 'countDocuments', filter });
  return store.filter((doc) => matches(doc, filter)).length;
};

Product.estimatedDocumentCount = async () => {
  calls.push({ op: 'estimatedDocumentCount' });
  return store.length;
};

Product.aggregate = async (pipeline = []) => {
  calls.push({ op: 'aggregate', pipeline });
  const byType = {};
  store.forEach((doc) => { byType[doc.type] = (byType[doc.type] || 0) + 1; });
  return Object.entries(byType).map(([_id, n]) => ({ _id, n }));
};

Product.updateOne = async (filter, update) => {
  calls.push({ op: 'updateOne', filter, update });
  const doc = store.find((d) => matches(d, filter));
  if (!doc) return { matchedCount: 0 };

  Object.entries(update.$set || {}).forEach(([key, value]) => { doc[key] = value; });
  Object.keys(update.$unset || {}).forEach((key) => { delete doc[key]; });
  return { matchedCount: 1 };
};

Product.create = async (doc) => {
  calls.push({ op: 'create', doc });
  const created = { _id: 'created' + (nextObjectId += 1), ...doc };
  store.push(created);
  return created;
};

// A large catalog: 1525 products, every 7th one discounted, one capped
function bigCatalog(size = 1525) {
  const types = ['fruits/vegetable', 'dairy', 'meat', 'drink', 'bakery', 'home'];
  return Array.from({ length: size }, (_, i) => ({
    id: 'p' + i,
    name: 'منتج ' + i,
    type: types[i % types.length],
    priceCents: 100 + (i % 40) * 100,
    keyWords: ['كلمة' + i],
    imageUrl: '/images/p' + i + '.webp',
    ...(i % 7 === 0 ? { discountPercent: 10, discountSetAt: '2026-09-01T00:00:00.000Z' } : {})
  }));
}

// ─── Part 1: pagination ──────────────────────────────────────

console.log('\nPart 1 — paginated reads at 1525 products');

await checkAsync('the defaults are one page of 24 with a stable sort', async () => {
  installFakeModel(bigCatalog());

  const result = await listProducts();

  assert.strictEqual(result.limit, DEFAULT_PAGE_SIZE);
  assert.strictEqual(result.page, 1);
  assert.strictEqual(result.pages, 64);
  assert.strictEqual(result.total, 1525);
  assert.strictEqual(result.products.length, 24);

  const find = findCall();
  assert.deepStrictEqual(find.sort, { _id: 1 }, 'paging needs a deterministic order');
  assert.strictEqual(find.skip, 0);
  assert.strictEqual(find.limit, 24);
  assert.strictEqual(find.lean, true, 'documents are read as plain objects');
});

await checkAsync('page 3 skips exactly two pages', async () => {
  installFakeModel(bigCatalog());
  const result = await listProducts({ page: 3, limit: 24 });

  assert.strictEqual(result.products[0].id, 'p48');
  assert.strictEqual(findCall().skip, 48);
});

await checkAsync('a page past the end lands on the last real page', async () => {
  installFakeModel(bigCatalog());
  const result = await listProducts({ page: 999, limit: 24 });

  assert.strictEqual(result.page, 64);
  assert.strictEqual(findCall().skip, 1512);
  assert.strictEqual(result.products.length, 13, '1525 = 63*24 + 13');
});

await checkAsync('a client can never request more than the cap', async () => {
  installFakeModel(bigCatalog());
  const result = await listProducts({ limit: 99999 });
  assert.strictEqual(result.limit, MAX_PAGE_SIZE);
  assert.strictEqual(findCall().limit, MAX_PAGE_SIZE);
});

await checkAsync('page 0 / negative limits are clamped to something sane', async () => {
  installFakeModel(bigCatalog());
  const result = await listProducts({ page: -5, limit: 0 });
  assert.strictEqual(result.page, 1);
  assert.strictEqual(result.limit, 1);
});

await checkAsync('an empty catalog is one empty page, not a crash', async () => {
  installFakeModel([]);
  const result = await listProducts();
  assert.deepStrictEqual(result.products, []);
  assert.strictEqual(result.total, 0);
  assert.strictEqual(result.pages, 1);
  assert.strictEqual(result.page, 1);
});

await checkAsync('the sidebar counts cover every category', async () => {
  installFakeModel(bigCatalog(600));
  const counts = await categoryCounts();

  assert.strictEqual(counts.all, 600);
  assert.strictEqual(counts.dairy, 100);
  assert.strictEqual(counts.home, 100);
  assert.strictEqual(counts['fruits/vegetable'], 100);
  assert.ok(calls.some((c) => c.op === 'aggregate'), 'counts are grouped in the database');
});

await checkAsync('the featured sort asks for the newest discounts first', async () => {
  installFakeModel(bigCatalog());
  await listProducts({ sort: 'newest', discount: true, limit: 4 });
  assert.deepStrictEqual(findCall().sort, { discountSetAt: -1, _id: 1 });
});

// ─── Part 2: by-ids reads ────────────────────────────────────

console.log('\nPart 2 — by-ids reads');

await checkAsync('by-ids keeps the caller order and drops unknown ids', async () => {
  installFakeModel(bigCatalog(50));
  const products = await listProductsByIds(['p9', 'p3', 'p9', 'gone']);

  assert.deepStrictEqual(products.map((p) => p.id), ['p9', 'p3']);
});

await checkAsync('the customer by-ids read only matches visible products', async () => {
  installFakeModel(bigCatalog(10));
  await listProductsByIds(['p1']);

  const filter = JSON.stringify(findCall().filter);
  assert.ok(filter.includes('"deleted":{"$ne":true}'), 'deleted products are skipped');
  assert.ok(filter.includes('hidden'), 'hidden products are skipped');
});

await checkAsync('the owner by-ids read keeps hidden and deleted products', async () => {
  installFakeModel(bigCatalog(10));
  await listProductsByIds(['p1'], { includeHidden: true });

  const filter = JSON.stringify(findCall().filter);
  assert.ok(!filter.includes('deleted'), 'no visibility filter for the owner');
  assert.ok(!filter.includes('hidden'));
});

await checkAsync('by-ids never loads the whole catalog', async () => {
  installFakeModel(bigCatalog());
  await listProductsByIds(['p1', 'p2']);
  assert.strictEqual(findCall().filter.$and[0].id.$in.length, 2);
});

await checkAsync('an image map is returned for any product, hidden or not', async () => {
  installFakeModel([
    { id: 'a', imageUrl: '/a.webp', hidden: true },
    { id: 'b', imageUrl: '/b.webp', deleted: true }
  ]);

  const map = await productImageMap(['a', 'b', 'missing']);
  assert.strictEqual(map.get('a'), '/a.webp');
  assert.strictEqual(map.get('b'), '/b.webp');
  assert.strictEqual(map.has('missing'), false);
  assert.strictEqual(findCall().select, 'id imageUrl', 'only the photo is fetched');
});

// ─── Part 3: expiry sweep ────────────────────────────────────

console.log('\nPart 3 — the expiry sweep only touches what expired');

const HOUR_MS = 60 * 60 * 1000;

await checkAsync('nothing expired → no write at all', async () => {
  installFakeModel([
    { id: 'a', name: 'a', type: 'dairy', priceCents: 100, hidden: true, hideUntil: new Date(Date.now() + HOUR_MS).toISOString() }
  ]);

  const changed = await pruneCatalog();
  assert.strictEqual(changed, 0);
  assert.strictEqual(updateCalls().length, 0, 'a healthy catalog is never rewritten');
});

await checkAsync('a finished hide is $unset — never left behind by a $set', async () => {
  installFakeModel([
    {
      id: 'a', name: 'a', type: 'dairy', priceCents: 100,
      hidden: true,
      hideUntil: new Date(Date.now() - HOUR_MS).toISOString(),
      hideReason: 'unavailable'
    }
  ]);

  const changed = await pruneCatalog();
  assert.strictEqual(changed, 1);

  const update = updateCalls()[0].update;
  assert.ok(update.$unset.hidden, 'hidden must be removed');
  assert.ok(update.$unset.hideUntil, 'hideUntil must be removed');
  assert.ok(update.$unset.hideReason, 'hideReason must be removed');
  assert.ok(!('hidden' in (update.$set || {})), 'and it must not be set back to true');
});

await checkAsync('a finished review cap becomes unlimited again', async () => {
  installFakeModel([
    {
      id: 'a', name: 'a', type: 'dairy', priceCents: 100,
      stockQuantity: 3, ownerStock: 3, stockUntil: new Date(Date.now() - HOUR_MS).toISOString()
    }
  ]);

  await pruneCatalog();
  const update = updateCalls()[0].update;
  assert.ok(update.$unset.stockQuantity);
  assert.ok(update.$unset.ownerStock);
  assert.strictEqual(update.$set.unlimitedQuantity, true, 'the product is orderable again');
});

await checkAsync('a finished discount is cleared', async () => {
  installFakeModel([
    {
      id: 'a', name: 'a', type: 'dairy', priceCents: 100,
      discountPercent: 15, discountSetAt: '2026-01-01T00:00:00.000Z',
      discountUntil: new Date(Date.now() - HOUR_MS).toISOString()
    }
  ]);

  await pruneCatalog();
  const update = updateCalls()[0].update;
  assert.ok(update.$unset.discountPercent);
  assert.ok(update.$unset.discountSetAt);
  assert.ok(update.$unset.discountUntil);
});

// ─── Part 4: the per-document bridge to the pure rules ──────

console.log('\nPart 4 — order-review rules through the mutation bridge');

await checkAsync('markSoldOut consumes only the products in the order', async () => {
  installFakeModel([
    { id: 'milk', name: 'حليب', type: 'dairy', priceCents: 700, unlimitedQuantity: false, stockQuantity: 5, ownerStock: 9 },
    { id: 'bread', name: 'خبز', type: 'bakery', priceCents: 200, unlimitedQuantity: false, stockQuantity: 4, ownerStock: 4 }
  ]);

  const changed = await mutateProducts(['milk'], (products) =>
    markSoldOut(products, [{ productId: 'milk', quantity: 2 }])
  );

  assert.strictEqual(changed, true);
  assert.strictEqual(updateCalls().length, 1, 'only the ordered product was written');
  assert.strictEqual(updateCalls()[0].update.$set.stockQuantity, 3, 'the cap lost the order');
  assert.strictEqual(updateCalls()[0].update.$set.ownerStock, 9, 'the owner count is untouched');
  assert.strictEqual(store.find((d) => d.id === 'bread').stockQuantity, 4, 'the other product is intact');
});

await checkAsync('nothing changed → no write is issued', async () => {
  installFakeModel([
    { id: 'milk', name: 'حليب', type: 'dairy', priceCents: 700, unlimitedQuantity: true }
  ]);

  const changed = await mutateProducts(['milk'], (products) =>
    markSoldOut(products, [{ productId: 'milk', quantity: 2 }])
  );

  assert.strictEqual(changed, false, 'an unlimited product consumed nothing');
  assert.strictEqual(updateCalls().length, 0);
});

await checkAsync('an order that empties the cap also applies the sold-out hide', async () => {
  installFakeModel([
    { id: 'milk', name: 'حليب', type: 'dairy', priceCents: 700, unlimitedQuantity: false, stockQuantity: 2 }
  ]);

  await mutateProducts(['milk'], (products) =>
    markSoldOut(products, [{ productId: 'milk', quantity: 2 }])
  );

  const set = updateCalls()[0].update.$set;
  assert.strictEqual(set.stockQuantity, 0);
  assert.strictEqual(set.hidden, true, 'the last units sold out');
  assert.strictEqual(set.hideReason, 'soldout');
  assert.ok(set.hideUntil, 'and the hide is temporary');
});

await checkAsync('cancelling gives the stock back and lifts the sold-out hide', async () => {
  installFakeModel([
    {
      id: 'milk', name: 'حليب', type: 'dairy', priceCents: 700,
      unlimitedQuantity: false, stockQuantity: 0,
      hidden: true, hideUntil: new Date(Date.now() + HOUR_MS).toISOString(), hideReason: 'soldout'
    }
  ]);

  await mutateProducts(['milk'], (products) =>
    restoreSoldOut(products, [{ productId: 'milk', quantity: 2 }])
  );

  const update = updateCalls()[0].update;
  assert.strictEqual(update.$set.stockQuantity, 2);
  assert.ok(update.$unset.hidden, 'the sold-out hide is gone');
  assert.ok(update.$unset.hideReason);
});

await checkAsync('a «غير متوفر» review mark hides just that product', async () => {
  installFakeModel([
    { id: 'milk', name: 'حليب', type: 'dairy', priceCents: 700 },
    { id: 'bread', name: 'خبز', type: 'bakery', priceCents: 200 }
  ]);

  await mutateProducts(['milk'], (products) =>
    applyReviewAvailability(products, {
      replacements: [{ productId: 'milk', state: 'unavailable' }]
    })
  );

  assert.strictEqual(updateCalls().length, 1);
  const set = updateCalls()[0].update.$set;
  assert.strictEqual(set.hidden, true);
  assert.strictEqual(set.hideReason, 'unavailable');
});

await checkAsync('a «متوفر N فقط» mark caps the whole store for the review window', async () => {
  installFakeModel([{ id: 'milk', name: 'حليب', type: 'dairy', priceCents: 700 }]);

  await mutateProducts(['milk'], (products) =>
    applyReviewAvailability(products, {
      replacements: [{ productId: 'milk', state: 'low', available: 2 }]
    })
  );

  const update = updateCalls()[0].update;
  assert.strictEqual(update.$set.stockQuantity, 2);
  assert.ok(update.$set.stockUntil, 'the cap expires by itself');
  assert.ok(update.$unset.unlimitedQuantity, 'the unlimited flag is dropped');
});

// ─── Part 5: single-document writes ─────────────────────────

console.log('\nPart 5 — owner edits');

await checkAsync('an unknown product id updates nothing and reports 404', async () => {
  installFakeModel(bigCatalog(5));
  const result = await updateProductById('nope', (p) => { p.priceCents = 1; });

  assert.strictEqual(result, null);
  assert.strictEqual(updateCalls().length, 0);
});

await checkAsync('setting a cap removes the unlimited flag in one update', async () => {
  installFakeModel([{ id: 'a', name: 'a', type: 'dairy', priceCents: 100, unlimitedQuantity: true }]);

  const updated = await updateProductById('a', (product) => {
    delete product.unlimitedQuantity;
    product.stockQuantity = 4;
    product.ownerStock = 6;
  });

  assert.strictEqual(updated.stockQuantity, 4);
  const update = updateCalls()[0].update;
  assert.strictEqual(update.$set.stockQuantity, 4);
  assert.strictEqual(update.$set.ownerStock, 6);
  assert.ok(update.$unset.unlimitedQuantity, 'the old flag cannot survive');
});

await checkAsync('removing a discount removes all three of its fields', async () => {
  installFakeModel([
    {
      id: 'a', name: 'a', type: 'dairy', priceCents: 100,
      discountPercent: 20, discountSetAt: '2026-01-01T00:00:00.000Z',
      discountUntil: '2026-12-01T00:00:00.000Z'
    }
  ]);

  await updateProductById('a', (product) => {
    delete product.discountPercent;
    delete product.discountUntil;
    delete product.discountSetAt;
  });

  const update = updateCalls()[0].update;
  assert.ok(update.$unset.discountPercent);
  assert.ok(update.$unset.discountSetAt);
  assert.ok(update.$unset.discountUntil);
});

await checkAsync('creating a product keeps "no quantity" meaning unlimited', async () => {
  installFakeModel([]);
  const created = await createProduct({ id: 'new', name: 'جديد', type: 'dairy', priceCents: 500 });

  assert.strictEqual(created.unlimitedQuantity, true);
  assert.strictEqual(calls.filter((c) => c.op === 'create').length, 1);
});

await checkAsync('the owner catalog is listed without a visibility filter', async () => {
  installFakeModel(bigCatalog(10));

  const all = await listOwnerProducts({ includeDeleted: true });
  assert.strictEqual(all.length, 10);
  assert.deepStrictEqual(findCall().filter, {}, 'nothing is filtered out');
  assert.deepStrictEqual(findCall().sort, { _id: 1 }, 'a stable owner order');

  await listOwnerProducts();
  assert.deepStrictEqual(findCall().filter, { deleted: { $ne: true } });
});

await checkAsync('the empty-catalog startup check counts documents', async () => {
  installFakeModel([]);
  assert.strictEqual(await catalogCount(), 0);
  installFakeModel(bigCatalog(1525));
  assert.strictEqual(await catalogCount(), 1525);
});

await checkAsync('the model stays disconnected — these tests touch no database', async () => {
  assert.notStrictEqual(mongoose.connection.readyState, 1);
});

// ─── Summary ─────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
