// Add-product keyword rows — headless UI test
//
// The owner types ONE keyword per field, a + button appends another field, and
// each field has an X that deletes it. The last remaining field cannot be
// deleted and empty fields are never keywords. The helpers are exported from
// owner-browsing.js (public/js/scripts) and driven here against a tiny DOM stub,
// so the whole suite still runs with plain `node` and no browser.

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ─── A minimal DOM the script under test can drive ───────────

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
    this.value = '';
    this.attributes = {};
  }
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
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  remove() {
    // Detach from the parent that holds this node, if any
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      node.children.forEach((child) => {
        if (child.matches(selector)) out.push(child);
        walk(child);
      });
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest() { return null; }
  focus() {}
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

const document = makeDocument();
globalThis.document = document;
globalThis.window = { location: { search: '' } };
globalThis.URLSearchParams = globalThis.URLSearchParams || (await import('node:url')).URLSearchParams;

const mod = await import(new URL('../public/js/scripts/owner-browsing.js', import.meta.url).href);
const { resetKeywordRows, addKeywordRow, removeKeywordRow, collectKeywords } = mod;

// The container the rows are appended to
document.getElementById('add-keywords-list');

const rows = () => document.getElementById('add-keywords-list').children;
const removeButtons = () => document.getElementById('add-keywords-list').querySelectorAll('.add-keyword-remove');

console.log('\nAdd-product keyword rows');

await check('opening the modal starts with exactly one empty field', () => {
  resetKeywordRows();
  assert.strictEqual(rows().length, 1);
  assert.strictEqual(rows()[0].querySelector('.add-keyword-input').value, '');
});

await check('the + button appends one more field each time', () => {
  resetKeywordRows();
  addKeywordRow();
  addKeywordRow();
  assert.strictEqual(rows().length, 3);
  assert.ok(rows().every((row) => row.querySelector('.add-keyword-input')), 'every row has an input');
});

await check('the X deletes a field while more than one remains', () => {
  resetKeywordRows();
  addKeywordRow('حليب');
  addKeywordRow('بقري');
  assert.strictEqual(rows().length, 3);

  const middle = rows()[1];
  middle.querySelector('.add-keyword-remove').listeners.click[0]();
  assert.strictEqual(rows().length, 2, 'the row is gone');
  assert.strictEqual(rows()[1].querySelector('.add-keyword-input').value, 'بقري');
});

await check('the last field can never be deleted', () => {
  resetKeywordRows();
  assert.strictEqual(rows().length, 1);
  assert.strictEqual(removeButtons()[0].disabled, true, 'the only X is disabled');

  removeKeywordRow(rows()[0]);
  assert.strictEqual(rows().length, 1, 'the single row survives');
});

await check('the X is disabled again as soon as one field is left', () => {
  resetKeywordRows();
  addKeywordRow('طازج');
  assert.strictEqual(removeButtons().some((b) => b.disabled), false, 'two fields = both X usable');

  rows()[0].querySelector('.add-keyword-remove').listeners.click[0]();
  assert.strictEqual(rows().length, 1);
  assert.strictEqual(removeButtons()[0].disabled, true, 'back to one field = X disabled');
});

await check('empty fields are not keywords', () => {
  resetKeywordRows();
  addKeywordRow('   ');
  addKeywordRow('');
  assert.deepStrictEqual(collectKeywords(), [], 'blank fields are dropped');
});

await check('keywords are trimmed and de-duplicated', () => {
  resetKeywordRows();
  addKeywordRow('  حليب  ');
  addKeywordRow('حليب');
  addKeywordRow('بقري');
  assert.deepStrictEqual(collectKeywords(), ['حليب', 'بقري']);
});

await check('the collected keywords join with commas for the server contract', () => {
  resetKeywordRows();
  addKeywordRow('حليب');
  addKeywordRow('بقري');
  addKeywordRow('طازج');
  // The server splits keyWords on ','
  const sent = collectKeywords().join(', ');
  assert.strictEqual(sent, 'حليب, بقري, طازج');
  assert.deepStrictEqual(sent.split(',').map((k) => k.trim()), ['حليب', 'بقري', 'طازج']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
