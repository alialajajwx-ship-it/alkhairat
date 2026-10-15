// «تواصل معنا» history, rendered - headless DOM stub, no database, no server.
//
// The page script is loaded against a minimal document, exactly like a browser
// would load it, and the history it draws is inspected. This is the level the
// static suite cannot reach: the endpoint can return the right JSON while the
// page still renders nothing.
//
// Run with:  node scripts/test-contact-history-ui.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CONTACT_SCRIPT = pathToFileURL(path.join(ROOT, 'public/js/scripts/contact.js')).href;

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

/** The smallest DOM the contact script needs, with real text nodes inside */
function makeEl(tag = 'div') {
  const el = {
    tag,
    textContent: '',
    className: '',
    value: '',
    children: [],
    listeners: {},
    style: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    reset() {},
    focus() {}
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (value) => { html = value; if (value === '') el.children = []; }
  });
  return el;
}

const messages = [
  { id: '3', topic: 'استفسار 3', message: 'رسالة رقم 3', createdAt: '2026-10-15T10:00:00.000Z' },
  { id: '2', topic: '', message: 'رسالة رقم 2', createdAt: '2026-10-15T09:00:00.000Z' },
  { id: '1', topic: 'شكراً', message: 'رسالة رقم 1', createdAt: '2026-10-14T08:00:00.000Z' }
];

/** Load the page script against the stub and wait for its history fetch */
async function loadContactPage(payload, { fail = false } = {}) {
  const els = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    createElement: (tag) => makeEl(tag),
    querySelectorAll: () => [],
    addEventListener() {}
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (fail) throw new Error('offline');
    return { ok: true, json: async () => (String(url).includes('contact-messages') ? payload : {}) };
  };

  try {
    await import(`${CONTACT_SCRIPT}?scenario=${Math.random()}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  } finally {
    globalThis.fetch = originalFetch;
  }
  return els;
}

console.log('\nContact page - rendering the history');

await (async () => {
  const els = await loadContactPage({ messages });
  const list = els.get('contact-history-list');

  check('every message appears in the list', () => {
    assert.strictEqual(list.children.length, 3, `rendered ${list.children.length} items`);
  });

  check('each row carries the text the customer typed', () => {
    const texts = list.children.map((item) => item.children[1].textContent);
    assert.deepStrictEqual(texts, ['رسالة رقم 3', 'رسالة رقم 2', 'رسالة رقم 1']);
  });

  check('each row shows its topic and when it was sent', () => {
    const first = list.children[0];
    assert.strictEqual(first.children[0].children[0].textContent, 'استفسار 3', 'the topic is missing');
    const date = first.children[0].children[1].textContent;
    assert.ok(date && !/[-–—]/.test(date), `the date shows a dash: ${date}`);

    // A message with no topic still gets a label instead of an empty header
    const second = list.children[1];
    assert.strictEqual(second.children[0].children.length, 2, 'the header lost a column');
  });

  check('the loading spinner is replaced by the list', () => {
    assert.strictEqual(els.get('contact-history-loading').style.display, 'none');
    assert.notStrictEqual(list.style.display, 'none');
    assert.strictEqual(els.get('contact-history-empty').style.display, 'none');
  });

  check('the count matches the messages shown', () => {
    assert.ok(els.get('contact-history-count').textContent.includes('3'),
      `got ${els.get('contact-history-count').textContent}`);
  });
})();

await (async () => {
  const els = await loadContactPage({ messages: [] });

  check('an account with no messages gets the empty state', () => {
    assert.strictEqual(els.get('contact-history-list').children.length, 0);
    assert.strictEqual(els.get('contact-history-list').style.display, 'none');
    assert.strictEqual(els.get('contact-history-empty').style.display, 'block');
  });
})();

await (async () => {
  const els = await loadContactPage(null, { fail: true });

  check('a failed history call still leaves the page usable', () => {
    assert.strictEqual(els.get('contact-history-loading').style.display, 'none');
    assert.strictEqual(els.get('contact-history-empty').style.display, 'block');
  });
})();

console.log(`\nContact history: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
