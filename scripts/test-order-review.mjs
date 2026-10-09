// Scenario tests for the owner availability-review flow
// (مراجعة توفر المنتجات → alternatives SMS → cart restore).
//
// Run with:  node scripts/test-order-review.mjs
//
// Part 1 exercises the pure decisions in utils/order-review.js.
// Part 2 loads public/js/scripts/alternatives-sms.js against a fake DOM and
// checks the SMS it builds (link params + per-item availability summary).
// The blocks of the default message are separated by ONE blank line.

import assert from 'assert';
import fs from 'fs';
import { body, validationResult } from 'express-validator';
import {
  hasOrderProblem,
  computeReturnQuantities,
  pruneExpired,
  applyReviewAvailability,
  markSoldOut,
  restoreSoldOut,
  isHideActive,
  REVIEW_STOCK_HOURS
} from '../utils/order-review.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}\n      ${err.message}`);
    console.log(`  �’ ${name}\n      ${err.message}`);
  }
}

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

// ─── Part 1: utils/order-review.js ───────────────────────────

console.log('\nPart 1 — cart return quantities + order problem detection');

const MILK = { productId: 'p-milk', quantity: 3, name: 'حليب' };
const KIRI = { productId: 'p-kiri', quantity: 1, name: 'جبنة' };

const asObject = (map) => Object.fromEntries(map);

check('problem 1: low stock returns the available amount, not the ordered one', () => {
  const out = asObject(computeReturnQuantities([MILK], [
    { productId: 'p-milk', state: 'low', available: 2 }
  ]));
  assert.deepStrictEqual(out, { 'p-milk': { quantity: 2, capped: true } });
});

check('problem 1: low stock larger than the order keeps the ordered amount', () => {
  const out = asObject(computeReturnQuantities([MILK], [
    { productId: 'p-milk', state: 'low', available: 9 }
  ]));
  assert.deepStrictEqual(out, { 'p-milk': { quantity: 3, capped: true } });
});

check('problem 1: low stock with 0 available is dropped like unavailable', () => {
  const out = asObject(computeReturnQuantities([MILK], [
    { productId: 'p-milk', state: 'low', available: 0 }
  ]));
  assert.deepStrictEqual(out, {});
});

check('unavailable items are not returned', () => {
  const out = asObject(computeReturnQuantities([MILK, KIRI], [
    { productId: 'p-milk', state: 'unavailable' }
  ]));
  assert.deepStrictEqual(out, { 'p-kiri': { quantity: 1, capped: false } });
});

check('available / unmarked items come back with the ordered quantity', () => {
  const out = asObject(computeReturnQuantities([MILK, KIRI], [
    { productId: 'p-milk', state: 'available' }
  ]));
  assert.deepStrictEqual(out, {
    'p-milk': { quantity: 3, capped: false },
    'p-kiri': { quantity: 1, capped: false }
  });
});

check('a plain cancel (no review) returns every item untouched', () => {
  const out = asObject(computeReturnQuantities([MILK, KIRI], null));
  assert.deepStrictEqual(out, {
    'p-milk': { quantity: 3, capped: false },
    'p-kiri': { quantity: 1, capped: false }
  });
});

check('low mark without an available number keeps the ordered quantity', () => {
  const out = asObject(computeReturnQuantities([MILK], [
    { productId: 'p-milk', state: 'low', available: null }
  ]));
  assert.deepStrictEqual(out, { 'p-milk': { quantity: 3, capped: false } });
});

check('marks for products outside the order are ignored', () => {
  const out = asObject(computeReturnQuantities([MILK], [
    { productId: 'p-other', state: 'unavailable' }
  ]));
  assert.deepStrictEqual(out, { 'p-milk': { quantity: 3, capped: false } });
});

check('no items / no marks never throw', () => {
  assert.deepStrictEqual(asObject(computeReturnQuantities(null, null)), {});
  assert.deepStrictEqual(asObject(computeReturnQuantities([], [])), {});
  assert.deepStrictEqual(asObject(computeReturnQuantities([{}], [])), {});
});

check('a problem on one of the order items cancels the order', () => {
  assert.strictEqual(hasOrderProblem([MILK, KIRI], [
    { productId: 'p-milk', state: 'low', available: 2 }
  ]), true);
  assert.strictEqual(hasOrderProblem([MILK], [
    { productId: 'p-milk', state: 'unavailable' }
  ]), true);
});

check('marks on alternatives never cancel an order (extra fix)', () => {
  assert.strictEqual(hasOrderProblem([MILK], [
    { productId: 'p-alt', state: 'unavailable' },
    { productId: 'p-alt2', state: 'low', available: 1 }
  ]), false);
});

check('an all-available review confirms the order', () => {
  assert.strictEqual(hasOrderProblem([MILK, KIRI], [
    { productId: 'p-milk', state: 'available' },
    { productId: 'p-kiri', state: 'available' }
  ]), false);
});

check('an empty review is not a problem', () => {
  assert.strictEqual(hasOrderProblem([MILK], null), false);
  assert.strictEqual(hasOrderProblem([MILK], []), false);
});

check('a low mark on another product is not a problem for this order (mixed)', () => {
  assert.strictEqual(hasOrderProblem([MILK, KIRI], [
    { productId: 'p-milk', state: 'available' },
    { productId: 'p-alt', state: 'unavailable' }
  ]), false);
});

// ─── Part 2: alternatives-sms.js message builder (fake DOM) ───

console.log('\nPart 2 — the SMS the owner sends (link params + summary)');

const SMS_MODULE = new URL(
  '../public/js/scripts/alternatives-sms.js',
  import.meta.url
).href;

function makeEl(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    href: '',
    checked: false,
    style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    querySelectorAll: () => []
  };
}

/**
 * The message body the page rendered.
 *
 * The preview is written with innerHTML now — the link inside the message has
 * to be a real, tappable <a> — while the stub above keeps `textContent`
 * empty. Read whichever one was filled and strip the tags back out so the
 * assertions can keep matching the plain message the customer receives.
 */
function renderedMessage(el) {
  if (el.textContent) return el.textContent;
  return String(el.innerHTML)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/**
 * Load the page script against a fake DOM, fire DOMContentLoaded and return
 * the element stubs so the test can inspect what the page rendered.
 */
async function loadSmsPage({ search, order, review }) {
  const els = new Map();
  const listeners = {};

  const document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    querySelectorAll: () => [],
    body: { style: {} }
  };

  const window = {
    location: { origin: 'http://localhost:5000', href: '', search }
  };

  globalThis.document = document;
  globalThis.window = window;
  globalThis.alert = () => {};

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const payload = String(url).includes('/replacements/') ? { replacements: review } : { order };
    return { ok: true, json: async () => payload };
  };

  try {
    // Unique query string → a fresh module instance for every scenario
    const mod = await import(`${SMS_MODULE}?scenario=${Math.random()}`);
    assert.ok(mod, 'module loaded');
    const onReady = (listeners.DOMContentLoaded || [])[0];
    assert.ok(onReady, 'DOMContentLoaded handler registered');
    await onReady();
  } finally {
    globalThis.fetch = originalFetch;
  }

  return { els, window };
}

const orderWith = (items, extra = {}) => ({
  orderId: 'ORD-260926010525',
  cancelled: false,
  items,
  ...extra
});

await checkAsync('problem 2: alternatives marked متوفر end up in the browse link', async () => {
  const { els } = await loadSmsPage({
    search: '?order=ORD-260926010525',
    order: orderWith([
      { productId: 'p-milk', name: 'حليب المراعي', quantity: 1 },
      { productId: 'p-kiri', name: 'جبنة كيري', quantity: 1 },
      { productId: 'p-tomato', name: 'طماطم', quantity: 2 }
    ]),
    review: {
      replacements: [
        { productId: 'p-milk', name: 'حليب المراعي', state: 'unavailable', available: null },
        { productId: 'p-kiri', name: 'جبنة كيري', state: 'low', available: 1 },
        { productId: 'p-tomato', name: 'طماطم', state: 'unavailable', available: null },
        { productId: 'p-alt', name: 'لبن المراعي', state: 'available', available: null }
      ]
    }
  });

  const message = renderedMessage(els.get('alt-message-preview'));

  assert.ok(
    message.includes(
      'http://localhost:5000/browse?completedOrder=false&order=ORD-260926010525&item=' +
      encodeURIComponent('لبن المراعي')
    ),
    `link missing the alternative item param:\n${message}`
  );
  assert.ok(!message.includes('item=' + encodeURIComponent('حليب المراعي')),
    'an unavailable ordered item must not be suggested');
  assert.ok(!message.includes('item=' + encodeURIComponent('طماطم')),
    'an unavailable ordered item must not be suggested');
  assert.ok(message.includes('حليب المراعي: غير متوفر'), 'summary line for حليب');
  assert.ok(message.includes('جبنة كيري: متوفر 1 فقط (طلبك كان 1)'), 'summary line for جبنة');
  assert.ok(message.includes('طماطم: غير متوفر'), 'summary line for طماطم');
  assert.strictEqual(els.get('alt-order-id').textContent, 'ORD-260926010525');
  assert.strictEqual(els.get('alt-send-btn').disabled, false);
  assert.strictEqual(els.get('alt-cancel-btn').style.display, '',
    'the cancel option is offered when an item is missing');

  // The link must be a REAL anchor — the whole point of the change is that
  // the owner can tap the suggested-items link straight from the preview
  const previewHtml = els.get('alt-message-preview').innerHTML;
  assert.ok(
    /<a href="https?:\/\/[^"]+" target="_blank" rel="noopener noreferrer">/.test(previewHtml),
    `the browse link must be a tappable anchor:\n${previewHtml}`
  );
});

// The preview writes innerHTML now, so a product name that looks like markup
// must stay TEXT — anything unescaped would run in the owner's session.
await checkAsync('item names are escaped in the preview (the link is the only HTML)', async () => {
  const nasty = '<img src=x onerror="alert(1)">حليب';
  const { els } = await loadSmsPage({
    search: '?order=ORD-260926010525',
    order: orderWith([{ productId: 'p-milk', name: nasty, quantity: 1 }]),
    review: {
      replacements: [
        { productId: 'p-milk', name: nasty, state: 'unavailable', available: null }
      ]
    }
  });

  const html = els.get('alt-message-preview').innerHTML;
  assert.ok(!/<img/i.test(html), `markup from a product name leaked into the preview:\n${html}`);
  assert.ok(html.includes('&lt;img'), 'the product name is escaped as plain text');
  assert.ok(
    renderedMessage(els.get('alt-message-preview')).includes(nasty),
    'and it still reads as the original name'
  );
});

await checkAsync('problem 2: several alternatives, duplicates removed, order kept', async () => {
  const { els } = await loadSmsPage({
    search: '?order=ORD-1',
    order: orderWith([
      { productId: 'p-milk', name: 'حليب المراعي', quantity: 2 }
    ]),
    review: {
      replacements: [
        { productId: 'p-a', name: 'لبن', state: 'available' },
        { productId: 'p-b', name: 'جبن', state: 'available' },
        { productId: 'p-c', name: 'لبن', state: 'available' },
        { productId: 'p-milk', name: 'حليب المراعي', state: 'unavailable' }
      ]
    }
  });

  const message = renderedMessage(els.get('alt-message-preview'));
  const items = message
    .split('item=')
    .slice(1)
    .map((s) => decodeURIComponent(s.split('&')[0].split('\n')[0]));
  assert.deepStrictEqual(items, ['لبن', 'جبن'],
    'each suggested product appears once, in marking order');
  assert.ok(message.includes('حليب المراعي: غير متوفر'));
});

await checkAsync('no available marks → a plain link with no item params', async () => {
  const { els } = await loadSmsPage({
    search: '?order=ORD-2',
    order: orderWith([{ productId: 'p-milk', name: 'حليب المراعي', quantity: 3 }]),
    review: {
      replacements: [{ productId: 'p-milk', name: 'حليب المراعي', state: 'low', available: 2 }]
    }
  });

  const message = renderedMessage(els.get('alt-message-preview'));
  assert.ok(message.includes('http://localhost:5000/browse?completedOrder=false&order=ORD-2'));
  assert.ok(!message.includes('item='), 'no suggested items expected');
  assert.ok(message.includes('حليب المراعي: متوفر 2 فقط (طلبك كان 3)'));
});

await checkAsync('order items that are available are not listed as problems', async () => {
  const { els } = await loadSmsPage({
    search: '?order=ORD-3',
    order: orderWith([
      { productId: 'p-milk', name: 'حليب المراعي', quantity: 1 },
      { productId: 'p-kiri', name: 'جبنة كيري', quantity: 1 }
    ]),
    review: {
      replacements: [
        { productId: 'p-milk', name: 'حليب المراعي', state: 'available' },
        { productId: 'p-kiri', name: 'جبنة كيري', state: 'unavailable' }
      ]
    }
  });

  const message = renderedMessage(els.get('alt-message-preview'));
  assert.ok(!message.includes('حليب المراعي: '), 'available items are not summarised');
  assert.ok(message.includes('جبنة كيري: غير متوفر'));
  assert.ok(message.includes('item=' + encodeURIComponent('حليب المراعي')),
    'the available ordered item is still offered on top of browse');
});

await checkAsync('problem 4: the message is 3 blocks separated by one blank line', async () => {
  const { els } = await loadSmsPage({
    search: '?order=ORD-8',
    order: orderWith([
      { productId: 'p-milk', name: 'حليب المراعي', quantity: 3 },
      { productId: 'p-kiri', name: 'جبنة كيري', quantity: 1 }
    ]),
    review: {
      replacements: [
        { productId: 'p-yogurt', name: 'لبن زبادي', state: 'available', available: null },
        { productId: 'p-milk', name: 'حليب المراعي', state: 'low', available: 2 },
        { productId: 'p-kiri', name: 'جبنة كيري', state: 'unavailable', available: null }
      ]
    }
  });

  const message = renderedMessage(els.get('alt-message-preview'));
  const blocks = message.split('\n\n');

  assert.strictEqual(blocks.length, 3, `expected greeting + summary + link:\n${JSON.stringify(message)}`);
  assert.ok(blocks[0].startsWith('مرحباً بك، بعض المنتجات التي طلبتها غير متوفرة حالياً'),
    'the greeting opens the message');
  assert.strictEqual(
    blocks[1],
    'حليب المراعي: متوفر 2 فقط (طلبك كان 3)\nجبنة كيري: غير متوفر',
    'one summary line per problem item, no link mixed in'
  );
  assert.ok(
    blocks[2].startsWith('http://localhost:5000/browse?completedOrder=false&order=ORD-260926010525'),
    'the link is the last block, on its own'
  );
  assert.ok(blocks[2].includes('item=' + encodeURIComponent('لبن زبادي')));
  assert.ok(!message.includes('\n\n\n'), 'exactly one blank line between blocks');
  assert.ok(!/حليب المراعي[^\n]*http/.test(message), 'the link never shares a line with the summary');
});

await checkAsync('an unknown order disables sending', async () => {
  const { els } = await loadSmsPage({ search: '?order=ORD-404', order: null, review: null });
  assert.strictEqual(els.get('alt-send-btn').disabled, true);
  assert.strictEqual(els.get('alt-order-id').textContent, '#ORD-404');
});

await checkAsync('a cancelled order cannot receive another SMS', async () => {
  const { els } = await loadSmsPage({
    search: '?order=ORD-5',
    order: orderWith([{ productId: 'p-milk', name: 'حليب', quantity: 1 }], { cancelled: true }),
    review: null
  });
  assert.strictEqual(els.get('alt-send-btn').disabled, true);
  assert.ok(/إلغاء/.test(els.get('alt-send-btn').textContent));
  assert.strictEqual(els.get('alt-cancel-hint').style.display, 'none');
});

await checkAsync('an all-available review sends a confirmation, not a missing-items SMS', async () => {
  const { els } = await loadSmsPage({
    search: '?order=ORD-7',
    order: orderWith([{ productId: 'p-milk', name: 'حليب', quantity: 1 }]),
    review: {
      replacements: [{ productId: 'p-milk', name: 'حليب', state: 'available' }]
    }
  });

  const message = renderedMessage(els.get('alt-message-preview'));
  assert.ok(message.includes('تم تأكيد طلبك ORD-260926010525'), `unexpected message:\n${message}`);
  assert.ok(!message.includes('غير متوفرة'), 'must not claim missing products');
  assert.ok(!message.includes('/browse?'), 'no suggested-items link when nothing is missing');
  assert.strictEqual(els.get('alt-cancel-btn').style.display, undefined,
    'the cancel option stays hidden when nothing is missing');
});

await checkAsync('marks for items removed from the order are dropped from the summary', async () => {
  const { els } = await loadSmsPage({
    search: '?order=ORD-6',
    order: orderWith([{ productId: 'p-milk', name: 'حليب', quantity: 1 }]),
    review: {
      replacements: [
        { productId: 'p-gone', name: 'منتج محذوف', state: 'unavailable' },
        { productId: 'p-milk', name: 'حليب', state: 'low', available: 1 }
      ]
    }
  });

  const message = renderedMessage(els.get('alt-message-preview'));
  assert.ok(!message.includes('منتج محذوف: '), 'a removed order item must not be summarised');
  assert.ok(message.includes('حليب: متوفر 1 فقط (طلبك كان 1)'));
});

// ─── Part 3: the payload the review page PUTs ─────────────────
// The marks travel as JSON to PUT /api/admin/orders/:orderId/replacements.
// The validator chain is sliced out of server.js so this checks the real
// rules (an alternative product has no ordered quantity → null).

console.log('\nPart 3 — the replacement payload the owner sends');

const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const routeAt = serverSource.indexOf("app.put('/api/admin/orders/:orderId/replacements'");
const chainStart = serverSource.indexOf('[', serverSource.indexOf('requireOwner', routeAt));
const chainEnd = serverSource.indexOf('\n], async', chainStart);
const validatorChain = eval(serverSource.slice(chainStart, chainEnd + 2));

async function validateReplacements(replacements) {
  const req = { body: { replacements } };
  await Promise.all(validatorChain.map((rule) => rule.run(req)));
  return validationResult(req).array().map((e) => `${e.path}: ${e.msg}`);
}

assert.ok(routeAt > -1 && chainStart > -1 && chainEnd > -1, 'replacement route found');
assert.ok(Array.isArray(validatorChain) && validatorChain.length > 0, 'validator chain loaded');

await checkAsync('an alternative marked متوفر is a valid mark (ordered/available null)', async () => {
  const errors = await validateReplacements([
    { productId: 'p-alt', name: 'لبن المراعي', state: 'available', ordered: null, available: null, unlimitedUntil: null },
    { productId: 'p-milk', name: 'حليب المراعي', state: 'unavailable', ordered: 1, available: null, unlimitedUntil: null },
    { productId: 'p-kiri', name: 'جبنة كيري', state: 'low', ordered: 1, available: 2, unlimitedUntil: null }
  ]);
  assert.deepStrictEqual(errors, []);
});

await checkAsync('a low mark with an unlimited window is valid', async () => {
  const errors = await validateReplacements([
    { productId: 'p-kiri', name: 'جبنة كيري', state: 'low', ordered: 1, available: 2,
      unlimitedUntil: new Date(Date.now() + 86400000).toISOString() }
  ]);
  assert.deepStrictEqual(errors, []);
});

await checkAsync('the chain really validates (bad state / bad quantity are rejected)', async () => {
  const badState = await validateReplacements([
    { productId: 'p-1', name: 'منتج', state: 'maybe', ordered: 1, available: null }
  ]);
  assert.ok(badState.length > 0, 'an unknown state must be rejected');

  const badQty = await validateReplacements([
    { productId: 'p-1', name: 'منتج', state: 'low', ordered: 1, available: -3 }
  ]);
  assert.ok(badQty.length > 0, 'a negative available quantity must be rejected');

  const empty = await validateReplacements([]);
  assert.deepStrictEqual(empty, [], 'an empty review is allowed (the owner may unmark everything)');
});

// ─── Part 4: the stock rules the review leaves behind ─────────
// 24h quantity cap / 24h hide / sold-out hide / expiry pruning.

console.log('\nPart 4 — stock lifecycle (24h cap, 24h hide, sold out, expiry)');

const NOW = Date.parse('2026-09-28T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const newMilk = (extra = {}) => ({ id: 'p-milk', name: 'حليب', ...extra });

check('pruneExpired: a finished hide makes the product visible again', () => {
  const products = [newMilk({ hidden: true, hideUntil: iso(NOW - HOUR), hideReason: 'unavailable' })];
  assert.strictEqual(pruneExpired(products, NOW), true);
  assert.deepStrictEqual(products[0], newMilk());
  assert.strictEqual(isHideActive(products[0], NOW), false);
});

check('pruneExpired: a running hide is left alone', () => {
  const p = newMilk({ hidden: true, hideUntil: iso(NOW + HOUR), hideReason: 'soldout' });
  // Something else in the list expires, so the run still reports a change
  const other = newMilk({ id: 'p-b', hidden: true, hideUntil: iso(NOW - HOUR) });
  const products = [p, other];
  assert.strictEqual(pruneExpired(products, NOW), true);
  assert.strictEqual(p.hidden, true);
  assert.strictEqual(p.hideUntil, iso(NOW + HOUR));
  assert.strictEqual(p.hideReason, 'soldout');
  assert.strictEqual(isHideActive(p, NOW), true);
});

check('pruneExpired: nothing expired → nothing changes (no pointless write)', () => {
  const products = [newMilk({ stockQuantity: 4 }), newMilk({ id: 'p-b', hidden: true })];
  assert.strictEqual(pruneExpired(products, NOW), false);
  assert.deepStrictEqual(products[0], newMilk({ stockQuantity: 4 }));
});

check('pruneExpired: a finished review cap is lifted (back to unlimited)', () => {
  const products = [newMilk({ stockQuantity: 4, stockUntil: iso(NOW - 1000), unlimitedQuantity: false })];
  assert.strictEqual(pruneExpired(products, NOW), true);
  assert.deepStrictEqual(products[0], newMilk({ unlimitedQuantity: true }));
});

check('pruneExpired: a finished discount disappears, a running one stays', () => {
  const dead = newMilk({ discountPercent: 20, discountUntil: iso(NOW - HOUR), discountSetAt: iso(NOW - 5000) });
  const alive = newMilk({ id: 'p-b', discountPercent: 10, discountUntil: iso(NOW + HOUR) });
  const open = newMilk({ id: 'p-c', discountPercent: 5 }); // no deadline — runs until removed
  const products = [dead, alive, open];
  assert.strictEqual(pruneExpired(products, NOW), true);
  assert.deepStrictEqual(dead, newMilk());
  assert.strictEqual(alive.discountPercent, 10);
  assert.strictEqual(open.discountPercent, 5);
});

check('review «متوفر N فقط» caps the whole store for 24 hours', () => {
  const products = [newMilk({ unlimitedQuantity: true })];
  const dirty = applyReviewAvailability(products, {
    replacements: [{ productId: 'p-milk', state: 'low', available: 4 }]
  }, NOW);

  assert.strictEqual(dirty, true);
  assert.strictEqual(products[0].stockQuantity, 4);
  assert.strictEqual(products[0].stockUntil, iso(NOW + REVIEW_STOCK_HOURS * HOUR));
  assert.strictEqual(products[0].unlimitedQuantity, undefined);
});

check('review «متوفر N فقط» ignores a legacy unlimited window', () => {
  const products = [newMilk({ unlimitedUntil: iso(NOW + 100 * HOUR) })];
  applyReviewAvailability(products, {
    replacements: [{ productId: 'p-milk', state: 'low', available: 2, unlimitedUntil: iso(NOW + 500 * HOUR) }]
  }, NOW);
  assert.strictEqual(products[0].unlimitedUntil, undefined);
  assert.strictEqual(products[0].stockQuantity, 2);
});

check('review «غير متوفر» hides the product for 24 hours', () => {
  const products = [newMilk({ unlimitedQuantity: true })];
  const dirty = applyReviewAvailability(products, {
    replacements: [{ productId: 'p-milk', state: 'unavailable', available: null }]
  }, NOW);

  assert.strictEqual(dirty, true);
  assert.strictEqual(products[0].hidden, true);
  assert.strictEqual(products[0].hideUntil, iso(NOW + REVIEW_STOCK_HOURS * HOUR));
  assert.strictEqual(products[0].hideReason, 'unavailable');
  assert.strictEqual(isHideActive(products[0], NOW), true);
  assert.strictEqual(isHideActive(products[0], NOW + 25 * HOUR), false);
});

check('review «الكمية ناقصة 0» is treated as غير متوفر', () => {
  const products = [newMilk({})];
  applyReviewAvailability(products, {
    replacements: [{ productId: 'p-milk', state: 'low', available: 0 }]
  }, NOW);
  assert.strictEqual(products[0].hidden, true);
  assert.strictEqual(products[0].stockQuantity, undefined);
});

check('review «متوفر» lifts a system hide but never a manual owner hide', () => {
  const soldOut = newMilk({ hidden: true, hideUntil: iso(NOW + HOUR), hideReason: 'soldout' });
  const markedOut = newMilk({ id: 'p-b', hidden: true, hideUntil: iso(NOW + HOUR), hideReason: 'unavailable' });
  const manual = newMilk({ id: 'p-c', hidden: true });
  const products = [soldOut, markedOut, manual];

  applyReviewAvailability(products, {
    replacements: [
      { productId: 'p-milk', state: 'available' },
      { productId: 'p-b', state: 'available' },
      { productId: 'p-c', state: 'available' }
    ]
  }, NOW);

  assert.strictEqual(soldOut.hidden, undefined);
  assert.strictEqual(markedOut.hidden, undefined);
  assert.strictEqual(manual.hidden, true, 'a manual hide needs a manual unhide');
});

check('problem 3: a partial order leaves the rest for the next customers', () => {
  const products = [newMilk({ stockQuantity: 5 })];
  assert.strictEqual(markSoldOut(products, [{ productId: 'p-milk', quantity: 3 }], NOW), true);
  assert.strictEqual(products[0].stockQuantity, 2, '5 ordered − 3 sold = 2 left for the next customers');
  assert.strictEqual(products[0].hidden, undefined, 'still on sale for everyone');
});

check('problem 3: ordering more than what is left empties it instead of going negative', () => {
  const products = [newMilk({ stockQuantity: 2 })];
  assert.strictEqual(markSoldOut(products, [{ productId: 'p-milk', quantity: 5 }], NOW), true);
  assert.strictEqual(products[0].stockQuantity, 0);
  assert.strictEqual(products[0].hidden, true, 'nothing left → sold out for 24h');
});

check('problem 3: cancelling the order puts the quantity back', () => {
  const products = [newMilk({ stockQuantity: 5 })];
  markSoldOut(products, [{ productId: 'p-milk', quantity: 3 }], NOW);
  assert.strictEqual(products[0].stockQuantity, 2);
  assert.strictEqual(restoreSoldOut(products, [{ productId: 'p-milk', quantity: 3 }]), true);
  assert.strictEqual(products[0].stockQuantity, 5, 'the cancelled order never left the shelf');
});

check('item 1: an accepted order consumes the availability, never the owner stock', () => {
  const products = [newMilk({ ownerStock: 5, stockQuantity: 5 })];
  assert.strictEqual(markSoldOut(products, [{ productId: 'p-milk', quantity: 3 }], NOW), true);
  assert.strictEqual(products[0].stockQuantity, 2,
    'other customers may only order the 2 that are left');
  assert.strictEqual(products[0].ownerStock, 5,
    'the owner keeps counting 5 in stock until the order is delivered');
});

check('item 1: cancelling restores the availability and leaves the owner stock alone', () => {
  const products = [newMilk({ ownerStock: 5, stockQuantity: 2 })];
  assert.strictEqual(restoreSoldOut(products, [{ productId: 'p-milk', quantity: 3 }]), true);
  assert.strictEqual(products[0].stockQuantity, 5);
  assert.strictEqual(products[0].ownerStock, 5);
});

check('item 1: a review cap keeps the owner stock next to the capped availability', () => {
  const products = [newMilk({ ownerStock: 5, stockQuantity: 5 })];
  applyReviewAvailability(products, {
    replacements: [{ productId: 'p-milk', state: 'low', available: 2 }]
  }, NOW);
  assert.strictEqual(products[0].stockQuantity, 2, 'customers are capped at 2');
  assert.strictEqual(products[0].ownerStock, 5, 'but the owner still has 5');
  assert.strictEqual(products[0].stockUntil, iso(NOW + REVIEW_STOCK_HOURS * HOUR));
});

check('item 1: an expired cap takes the owner stock with it', () => {
  const products = [newMilk({ ownerStock: 3, stockQuantity: 3, stockUntil: iso(NOW - 1000) })];
  assert.strictEqual(pruneExpired(products, NOW), true);
  assert.deepStrictEqual(products[0], newMilk({ unlimitedQuantity: true }));
});

check('sold out: taking the whole cap hides the product for 24 hours', () => {
  const products = [newMilk({ stockQuantity: 4, stockUntil: iso(NOW + 10 * HOUR) })];
  assert.strictEqual(markSoldOut(products, [{ productId: 'p-milk', quantity: 4 }], NOW), true);
  assert.strictEqual(products[0].hidden, true);
  assert.strictEqual(products[0].hideReason, 'soldout');
  assert.strictEqual(products[0].hideUntil, iso(NOW + REVIEW_STOCK_HOURS * HOUR));
  assert.strictEqual(products[0].stockQuantity, 0, 'the stock is consumed');
  assert.strictEqual(products[0].stockUntil, iso(NOW + 10 * HOUR), 'the cap deadline is kept');
});

check('an unlimited product is never given a cap', () => {
  const unlimited = newMilk({ id: 'p-b', unlimitedQuantity: true });
  assert.strictEqual(markSoldOut([unlimited], [{ productId: 'p-b', quantity: 9 }], NOW), false);
  assert.strictEqual(unlimited.stockQuantity, undefined);
  assert.strictEqual(unlimited.hidden, undefined);
});

check('sold out: an owner hide is never overwritten by the sold-out hide', () => {
  const products = [newMilk({
    stockQuantity: 4, hidden: true, hideUntil: iso(NOW + 3 * HOUR), hideReason: 'unavailable'
  })];
  assert.strictEqual(markSoldOut(products, [{ productId: 'p-milk', quantity: 4 }], NOW), true);
  assert.strictEqual(products[0].stockQuantity, 0, 'the order still consumes the stock');
  assert.strictEqual(products[0].hideReason, 'unavailable', 'the owner decision stands');
  assert.strictEqual(products[0].hideUntil, iso(NOW + 3 * HOUR));
});

check('sold out: an already empty cap is left alone', () => {
  const products = [newMilk({ stockQuantity: 0 })];
  assert.strictEqual(markSoldOut(products, [{ productId: 'p-milk', quantity: 2 }], NOW), false);
  assert.strictEqual(products[0].stockQuantity, 0);
  assert.strictEqual(products[0].hidden, undefined);
});

check('cancel: the quantity comes back and the sold-out hide is lifted', () => {
  const soldOut = newMilk({ stockQuantity: 0, hidden: true, hideUntil: iso(NOW + HOUR), hideReason: 'soldout' });
  const ownerHide = newMilk({ id: 'p-b', stockQuantity: 3, hidden: true, hideReason: 'unavailable' });
  const products = [soldOut, ownerHide];
  assert.strictEqual(restoreSoldOut(products, [
    { productId: 'p-milk', quantity: 4 },
    { productId: 'p-b', quantity: 1 }
  ]), true);
  assert.strictEqual(soldOut.hidden, undefined);
  assert.strictEqual(soldOut.stockQuantity, 4, 'the cancelled order is on the shelf again');
  assert.strictEqual(ownerHide.hidden, true, 'an owner hide needs a manual unhide');
  assert.strictEqual(ownerHide.stockQuantity, 4, 'its stock is given back too');
});

check('cancel: an unlimited product has no cap to give back', () => {
  const unlimited = newMilk({ unlimitedQuantity: true });
  assert.strictEqual(restoreSoldOut([unlimited], [{ productId: 'p-milk', quantity: 2 }]), false);
  assert.strictEqual(unlimited.stockQuantity, undefined);
});

check('end to end: review → cap → sell out → cancel → orderable again', () => {
  const products = [newMilk({ unlimitedQuantity: true })];

  // 1. the customer ordered 3, the owner only has 2
  applyReviewAvailability(products, {
    replacements: [{ productId: 'p-milk', state: 'low', available: 2 }]
  }, NOW);
  assert.strictEqual(products[0].stockQuantity, 2);

  // 2. another customer takes the last 2 — sold out for 24h
  assert.strictEqual(markSoldOut(products, [{ productId: 'p-milk', quantity: 2 }], NOW), true);
  assert.strictEqual(isHideActive(products[0], NOW), true);
  assert.strictEqual(products[0].stockQuantity, 0);

  // 3. that order is cancelled → the milk is on the shelf again, cap intact
  restoreSoldOut(products, [{ productId: 'p-milk', quantity: 2 }]);
  assert.strictEqual(isHideActive(products[0], NOW), false);
  assert.strictEqual(products[0].stockQuantity, 2);

  // 4. the 24h cap runs out → unlimited again, and the owner sees no badge
  assert.strictEqual(pruneExpired(products, NOW + 25 * HOUR), true);
  assert.deepStrictEqual(products[0], newMilk({ unlimitedQuantity: true }));
});

// ─── Part 5: the server is wired to those decisions ───────────
// The server cannot be imported (it starts listening), so the wiring is
// checked against its source: which helper runs where.

console.log('\nPart 5 — server wiring');

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function routeSource(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  assert.ok(start > -1 && end > start, `could not slice ${startMarker}`);
  return source.slice(start, end);
}

const smsRoute = routeSource("app.post('/api/admin/orders/:orderId/alternatives-sms'", "// Delete the parked review for an order");
const cancelRoute = routeSource("app.post('/api/admin/orders/:orderId/cancel'", "/**\n * Return order items to the customer's saved cart");
const productsRoute = routeSource("app.get('/api/products'", "app.get('/api/admin/orders'");
const ownerProductsRoute = routeSource("app.get('/api/owner/products'", "/**\n * Update a product's stock settings");

check('the SMS route applies the review marks on BOTH outcomes', () => {
  const calls = smsRoute.match(/applyReviewToCatalog\(review\)/g) || [];
  assert.strictEqual(calls.length, 2,
    'the cancelled branch AND the confirmed branch must apply the owner marks');
});

check('the SMS route lifts the sold-out hide before returning the items', () => {
  const restore = smsRoute.indexOf('restoreSoldOutToCatalog(items)');
  const returnItems = smsRoute.indexOf('returnItemsToCart(order.userId, items, review)');
  assert.ok(restore > -1, 'a cancelled order must give its stock back');
  assert.ok(restore < returnItems, 'the stock is restored before the cart is rebuilt');
});

check('a plain cancel also gives the sold-out stock back', () => {
  assert.ok(cancelRoute.includes('restoreSoldOutToCatalog(order.getItems())'));
});

check('every accepted order consumes its stock (acceptOrder wraps the notify)', () => {
  assert.ok(source.includes('async function acceptOrder(order)'), 'acceptOrder exists');
  assert.ok(source.includes('markOrderSoldOut('), 'it consumes the ordered stock');

  const bareCalls = (source.match(/^\s*notifyOwnerForOrder\(order\)/gm) || []).length;
  assert.strictEqual(bareCalls, 0,
    'notifyOwnerForOrder must only be reached through acceptOrder');
  assert.strictEqual((source.match(/acceptOrder\(order\)\.catch/g) || []).length, 4,
    'cash orders + the three card-payment paths are all wrapped');
});

check('an order is claimed atomically before its stock is consumed', () => {
  const body = routeSource('async function acceptOrder(order)', 'async function notifyOwnerForOrder(order)');
  assert.ok(body.includes('findOneAndUpdate'),
    'two concurrent callers must not consume the same order twice');
  assert.ok(body.includes('ownerNotified: { $ne: true }'), 'the claim only matches an unclaimed order');
  assert.ok(body.includes('if (!claimed) return;'), 'the loser does nothing');
  const claimAt = body.indexOf('findOneAndUpdate');
  assert.ok(claimAt < body.indexOf('markOrderSoldOut(claimed)'),
    'the stock is consumed only after the claim succeeded');
});

check('item 1: the owner stock is exposed next to the customer availability', () => {
  const enrich = routeSource('function enrichStockStatus(product)', '// Place order — requires authentication');
  assert.ok(enrich.includes('ownerStock: unlimited ? null'),
    'enrichStockStatus must answer with the owner-facing «في المخزون» number');
  assert.ok(enrich.includes('ownerStock'), 'a capped product always has a stock figure');
});

check('item 1: the owner decides both numbers through the quantity API', () => {
  const putRoute = routeSource("app.put('/api/owner/products/:id'", "app.delete('/api/owner/products/:id'");
  assert.ok(putRoute.includes('product.stockQuantity = value'),
    'the value stays the customer-facing availability');
  assert.ok(putRoute.includes('product.ownerStock = inStock'),
    'inStock is stored separately');
  assert.ok(putRoute.includes('quantity.inStock'),
    'an older caller that sends only a value is still accepted');
});

check('reads never write a filtered catalog (hidden products stay in the file)', () => {
  assert.ok(productsRoute.includes('pruneCatalog()'), 'the products route prunes the catalog');
  assert.ok(!productsRoute.includes('writeCatalog('),
    'a read must never write a filtered list back — that deleted hidden products');
  assert.ok(ownerProductsRoute.includes('pruneCatalog()'),
    'the owner route prunes expired hides so no «انتهت مدة الإخفاء» tag survives');
});

check('the bill SMS rides the same exactly-once claim as the owner notice', () => {
  const accept = routeSource('async function acceptOrder(order)', 'async function notifyOwnerForOrder(order)');
  assert.ok(accept.includes('await sendOrderBill(claimed)'),
    'the bill must be sent from acceptOrder, so it goes out exactly once');
});

check('the bill SMS is gated by the customer toggle — and by nothing else', () => {
  const bill = routeSource('async function sendOrderBill(order)', 'async function acceptOrder(order)');
  assert.ok(bill.includes('order.invoiceSms === false'),
    'an explicit opt-out skips the bill');
  assert.ok(bill.includes('sendSMS('), 'it goes through the shared SMS sender (mock in the terminal)');

  const confirmRoute = routeSource("app.post('/api/confirm-order'", "app.get('/api/admin/replacements/:orderId'");
  assert.ok(!confirmRoute.includes('invoiceSms'),
    'the confirmation SMS must never be suppressed by that toggle');
  assert.ok(!smsRoute.includes('invoiceSms'),
    'and neither must the alternatives SMS');
});

check('the bill lists what was ordered and the payment summary', () => {
  const builder = routeSource('function buildOrderBillMessage(order)', 'async function sendOrderBill(order)');
  assert.ok(builder.includes('order.subtotal') && builder.includes('order.delivery') && builder.includes('order.total'),
    'the money breakdown must be in the message');
  assert.ok(builder.includes('order.paymentMethod') && builder.includes('order.paymentStatus'),
    'so must the payment method and state');
  assert.ok(builder.includes('item.name') && builder.includes('item.quantity'),
    'and one line per ordered product');
});

check('an order item keeps its image from the moment the order is placed', () => {
  assert.ok(source.includes("imageUrl: product.imageUrl || ''"),
    'computeOrderAmounts must copy the product image onto the order item');
  assert.ok((source.match(/orderJSONWithImages\(order\)/g) || []).length >= 2,
    'both single-order routes fill an older order\'s missing images back in');
  assert.ok((source.match(/orders\.map\(orderJSONWithImages\)/g) || []).length >= 2,
    'and so do both list routes');
});

// ─── Summary ─────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
