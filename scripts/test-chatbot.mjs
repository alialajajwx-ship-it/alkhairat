// Store chatbot — headless test suite
//
// Covers the parts that can be checked without a browser or an AI provider:
//   • the model fallback chain (a rate-limited model must roll over to the next)
//   • the tool-calling loop (the model asks for a tool, gets JSON, then answers)
//   • the tool executor against a mocked catalog (images are URLs, never bytes)
//   • the rolling 40-messages / 24-hour limit
//   • the client widget (launcher, tooltip, guest lock, product cards)

import assert from 'node:assert/strict';
import http from 'node:http';

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

// ─── 1. Model fallback ───────────────────────────────────────
// A mock OpenAI-compatible provider: the first model is rate-limited, the
// second answers. The client must roll over instead of failing.

console.log('\nChatbot — model fallback');

const tried = [];
const exhausted = [];
let rounds = 0;

const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    tried.push(payload.model);
    const send = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (payload.model === 'model-a') {
      return send({ error: { message: 'rate limit exceeded' } }, 429);
    }
    if (payload.model === 'model-b') {
      rounds += 1;
      if (rounds === 1 && Array.isArray(payload.tools) && payload.tools.length) {
        return send({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'search_products', arguments: '{"query":"حليب","limit":2}' }
              }]
            }
          }]
        });
      }
      return send({ choices: [{ message: { role: 'assistant', content: 'نعم، المنتج متوفر.' } }] });
    }
    send({ error: { message: 'unexpected model' } }, 500);
  });
});

await new Promise((r) => provider.listen(0, r));
const port = provider.address().port;

process.env.NVIDIA_API_KEY = 'test-key';
process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.NVIDIA_MODELS = 'model-a,model-b,model-c';

const ai = await import('../utils/ai-chat.js');
const bot = await import('../utils/chatbot.js');

await check('a rate-limited model falls through to the next one', async () => {
  const res = await ai.chatComplete({ messages: [{ role: 'user', content: 'مرحبا' }] });
  assert.strictEqual(res.ok, true, 'the second model answered');
  assert.strictEqual(res.model, 'model-b');
  assert.ok(tried.includes('model-a'), 'the first model was tried');
});

await check('every configured model is attempted before giving up', async () => {
  // A provider that rate-limits EVERY model: the client must try each one in
  // order and report failure only after the whole list is exhausted.
  const dead = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      exhausted.push(payload.model);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'quota exhausted' } }));
    });
  });
  await new Promise((r) => dead.listen(0, r));

  const savedUrl = process.env.NVIDIA_BASE_URL;
  process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${dead.address().port}/v1`;

  const res = await ai.chatComplete({ messages: [{ role: 'user', content: 'x' }] });

  process.env.NVIDIA_BASE_URL = savedUrl;
  dead.close();

  assert.strictEqual(res.ok, false, 'all models failed');
  assert.deepStrictEqual(exhausted, ['model-a', 'model-b', 'model-c'], 'each model was tried once');
  assert.strictEqual(res.errors.length, 3, 'one error is reported per model');
});

await check('apiKeyEnvName derives a stable env var name per model', () => {
  assert.strictEqual(
    ai.apiKeyEnvName('deepseek-ai/deepseek-v4.1-flash'),
    'NVIDIA_API_KEY_DEEPSEEK_AI_DEEPSEEK_V4_1_FLASH'
  );
  assert.strictEqual(ai.apiKeyEnvName('openai/gpt-oss-20b'), 'NVIDIA_API_KEY_OPENAI_GPT_OSS_20B');
});

await check('the default model list only contains responsive models', () => {
  assert.deepStrictEqual(ai.DEFAULT_MODELS, [
    'openai/gpt-oss-20b',
    'nvidia/nemotron-3.5-lightning-30b-a3b',
    'meta/llama-3.2-11b-vision-instruct'
  ]);
  // None of the old model IDs that hang until timeout may be in the chain.
  assert.ok(!ai.DEFAULT_MODELS.includes('deepseek-ai/deepseek-v4.1-flash'));
  assert.ok(!ai.DEFAULT_MODELS.includes('z-ai/glm-5.3'));
  assert.ok(!ai.DEFAULT_MODELS.includes('google/gemma-4-31b-it'));
});

await check('a hanging model is timed out and the next model answers quickly', async () => {
  // A provider whose first model never responds: the client must abandon it at
  // the per-model deadline and roll over to the next model instead of hanging.
  const hang = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      if (payload.model === 'slow-model') return; // never reply
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'تم' } }] }));
    });
  });
  await new Promise((r) => hang.listen(0, r));

  const savedUrl = process.env.NVIDIA_BASE_URL;
  const savedModels = process.env.NVIDIA_MODELS;
  process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${hang.address().port}/v1`;
  process.env.NVIDIA_MODELS = 'slow-model,fast-model';

  const t0 = Date.now();
  const res = await ai.chatComplete({ messages: [{ role: 'user', content: 'x' }], timeoutMs: 800 });
  const elapsed = Date.now() - t0;

  process.env.NVIDIA_BASE_URL = savedUrl;
  process.env.NVIDIA_MODELS = savedModels;
  hang.close();

  assert.strictEqual(res.ok, true, 'the fast model answered');
  assert.strictEqual(res.model, 'fast-model');
  assert.ok(elapsed < 5000, `answered within the deadline (took ${elapsed}ms)`);
});

await check('a dead model is remembered and skipped on the next request', async () => {
  let hits = 0;
  const gone = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits += 1;
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'gone' }));
    });
  });
  await new Promise((r) => gone.listen(0, r));

  const savedUrl = process.env.NVIDIA_BASE_URL;
  const savedModels = process.env.NVIDIA_MODELS;
  process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${gone.address().port}/v1`;
  process.env.NVIDIA_MODELS = 'gone-model';

  const first = await ai.chatComplete({ messages: [{ role: 'user', content: 'x' }] });
  const second = await ai.chatComplete({ messages: [{ role: 'user', content: 'x' }] });

  process.env.NVIDIA_BASE_URL = savedUrl;
  process.env.NVIDIA_MODELS = savedModels;
  gone.close();

  assert.strictEqual(first.ok, false);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(hits, 1, 'the gone model was only called once before being skipped');
});

await check('configuredModels only reports models that actually have a key', () => {
  const savedModels = process.env.NVIDIA_MODELS;
  process.env.NVIDIA_MODELS = 'has-key,no-key';
  process.env.NVIDIA_API_KEY_HAS_KEY = 'k';
  delete process.env.NVIDIA_API_KEY_NO_KEY;
  const savedShared = process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY;

  const models = ai.configuredModels();

  process.env.NVIDIA_MODELS = savedModels;
  process.env.NVIDIA_API_KEY = savedShared;
  delete process.env.NVIDIA_API_KEY_HAS_KEY;

  assert.deepStrictEqual(models, ['has-key']);
});

// ─── 2. Tool-calling loop ────────────────────────────────────

console.log('\nChatbot — tool-calling loop');

await check('the model may call a tool, then answers with the tool result', async () => {
  rounds = 0;
  const events = { products: [], actions: [] };
  const res = await ai.chatWithTools({
    messages: [
      { role: 'system', content: bot.buildSystemPrompt({ page: '/browse' }) },
      { role: 'user', content: 'هل الحليب متوفر؟' }
    ],
    tools: bot.CHAT_TOOLS,
    executeTool: bot.createToolExecutor({ events })
  });
  assert.strictEqual(res.ok, true, 'the loop finished');
  assert.match(res.text, /متوفر/);
});

await check('the tool round-trip passes a JSON result back to the model', async () => {
  const calls = [];
  const seen = [];
  const fakeProvider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      seen.push(payload.messages);
      const send = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const hasToolResult = (payload.messages || []).some((m) => m.role === 'tool');
      if (!hasToolResult) {
        return send({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_x',
                type: 'function',
                function: { name: 'list_categories', arguments: '{}' }
              }]
            }
          }]
        });
      }
      return send({ choices: [{ message: { role: 'assistant', content: 'تم' } }] });
    });
  });
  await new Promise((r) => fakeProvider.listen(0, r));
  const savedUrl = process.env.NVIDIA_BASE_URL;
  process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${fakeProvider.address().port}/v1`;
  process.env.NVIDIA_MODELS = 'model-b';

  await ai.chatWithTools({
    messages: [{ role: 'user', content: 'الأقسام' }],
    tools: bot.CHAT_TOOLS,
    executeTool: async (name) => { calls.push(name); return { ok: true }; }
  });

  process.env.NVIDIA_BASE_URL = savedUrl;
  process.env.NVIDIA_MODELS = 'model-a,model-b,model-c';
  fakeProvider.close();

  assert.deepStrictEqual(calls, ['list_categories'], 'the executor was asked for the tool');
  const last = seen[seen.length - 1];
  assert.ok(last.some((m) => m.role === 'tool'), 'a tool message was sent back');
});

// ─── 3. Tool executor ────────────────────────────────────────

console.log('\nChatbot — tool executor');

await check('an unknown tool reports an error instead of throwing', async () => {
  const events = { products: [], actions: [] };
  const exec = bot.createToolExecutor({ events });
  const res = await exec('not_a_tool', {});
  assert.ok(res.error, 'an error is reported');
});

await check('the system prompt teaches the page the customer is on', () => {
  const prompt = bot.buildSystemPrompt({ page: '/orders' });
  assert.match(prompt, /طلباتي/);
  assert.match(prompt, /التفاصيل والتتبع/);
});

await check('the system prompt is Arabic and site-specific', () => {
  const prompt = bot.buildSystemPrompt({ page: '/' });
  assert.match(prompt, /بقالة الخيرات/);
  assert.match(prompt, /الدفع عند الاستلام/);
  assert.match(prompt, /بعد أن يوافق المتجر/);
  assert.match(prompt, /العربية/);
});

await check('the system prompt tells the assistant the store location and hours', () => {
  const prompt = bot.buildSystemPrompt({ page: '/' });
  assert.match(prompt, /https:\/\/www\.google\.com\/maps\/place\/Alkhayrat\+Grocery/);
  assert.match(prompt, /صفوى/);
  assert.match(prompt, /7:00 صباحاً/);
  assert.match(prompt, /11:30 مساءً/);
});

await check('the cart context is included so removal can be resolved', () => {
  const prompt = bot.buildSystemPrompt({
    page: '/checkout',
    cart: [{ id: 'abc', name: 'حليب', quantity: 2 }]
  });
  assert.match(prompt, /حليب/);
  assert.match(prompt, /abc/);
});

await check('the tool set covers search, lookup, categories and cart actions', () => {
  const names = bot.CHAT_TOOLS.map((t) => t.function.name).sort();
  assert.deepStrictEqual(names, [
    'get_product',
    'list_categories',
    'propose_add_to_cart',
    'remove_from_cart',
    'search_products'
  ]);
});

await check('a product name with a detached unit is repaired for the model', async () => {
  assert.strictEqual(bot.normalizeProductName('mlصانسيلك شامبو ناعم وانسيابي 400'), 'صانسيلك شامبو ناعم وانسيابي 400ml');
  assert.strictEqual(bot.normalizeProductName('gليز رقائق البطاطس بالملح 165'), 'ليز رقائق البطاطس بالملح 165g');
  assert.strictEqual(bot.normalizeProductName('kgريان زبادي طازج كامل الدسم 2'), 'ريان زبادي طازج كامل الدسم 2kg');
  // Already-correct and plain names are untouched
  assert.strictEqual(bot.normalizeProductName('ريان حليب طازج كامل الدسم 1.5 لتر'), 'ريان حليب طازج كامل الدسم 1.5 لتر');
  assert.strictEqual(bot.normalizeProductName('mlبدون رقم'), 'mlبدون رقم');
});

await check('images are only ever passed as URLs, never bytes', () => {
  const searchTool = bot.CHAT_TOOLS.find((t) => t.function.name === 'search_products');
  assert.ok(searchTool, 'the search tool exists');
  const props = searchTool.function.parameters.properties;
  assert.deepStrictEqual(Object.keys(props).sort(), ['category', 'limit', 'query']);
  // Nothing in the tool schema accepts an image payload
  assert.ok(!JSON.stringify(bot.CHAT_TOOLS).includes('imageBase64'));
});

// ─── 4. Rolling rate limit ───────────────────────────────────

console.log('\nChatbot — rate limit');

await check('the limit is 40 messages per 24 hours', async () => {
  const limit = await import('../utils/chat-limit.js');
  assert.strictEqual(limit.CHAT_LIMIT, 40);
  assert.strictEqual(limit.CHAT_WINDOW_MS, 24 * 60 * 60 * 1000);
});

// ─── 5. Client widget ────────────────────────────────────────
// A tiny DOM stub, same approach as the add-product UI test.

console.log('\nChatbot — client widget');

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
    this.src = '';
    this.href = '';
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
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
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
  scrollIntoView() {}
}

function makeDocument() {
  const els = new Map();
  const listeners = {};
  const byId = (id) => {
    if (!els.has(id)) {
      const e = new FakeEl('div');
      e.id = id;
      els.set(id, e);
    }
    return els.get(id);
  };
  const doc = {
    listeners,
    getElementById: byId,
    createElement: (tag) => new FakeEl(tag),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    body: new FakeEl('body'),
    documentElement: new FakeEl('html'),
    readyState: 'complete'
  };
  // The widget builds its markup through innerHTML then looks the nodes up by
  // id. Register every id it declares so getElementById finds them.
  const realCreate = doc.createElement;
  doc.createElement = (tag) => realCreate(tag);
  return doc;
}

// The widget's `build()` sets innerHTML with ids; the stub cannot parse HTML,
// so pre-register the ids the widget looks up.
function makeDocumentWithChatIds() {
  const doc = makeDocument();
  ['chat-launcher', 'chat-tooltip', 'chat-overlay', 'chat-panel', 'chat-close',
    'chat-messages', 'chat-suggestions', 'chat-usage', 'chat-input', 'chat-send'
  ].forEach((id) => doc.getElementById(id));
  return doc;
}

globalThis.document = makeDocumentWithChatIds();
globalThis.window = {
  location: { pathname: '/browse' },
  IS_AUTHENTICATED: true,
  addEventListener() {},
  dispatchEvent() {}
};
globalThis.setTimeout = globalThis.setTimeout;
globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

const widget = await import('../public/js/scripts/chatbot.js');

await check('the widget exposes the four starter suggestions', () => {
  assert.strictEqual(widget.SUGGESTIONS.length, 4);
  assert.ok(widget.SUGGESTIONS.some((s) => s.includes('أحذف منتجاً من سلتي')));
  assert.ok(widget.SUGGESTIONS.some((s) => s.includes('أتابع حالة طلبي')));
});

await check('building the widget creates the launcher and the panel', () => {
  widget.build();
  const root = globalThis.document.body.querySelector('#chatbot-root');
  assert.ok(root, 'the root exists');
  const html = root.innerHTML;
  assert.match(html, /chat-launcher/);
  assert.match(html, /\bsmart_toy\b/, 'the launcher uses the smart_toy icon');
  assert.ok(!html.includes('support_agent'), 'the old support_agent icon is gone');
  assert.ok(!html.includes('>man<'), 'the old man icon is gone');
  assert.match(html, /تحدث مع المساعد الآلي/);
  assert.match(html, /chat-panel/);
});

await check('the launcher icon is a font icon, not an emoji', () => {
  const root = globalThis.document.body.querySelector('#chatbot-root');
  const html = root.innerHTML;
  // No pictographic emoji in the launcher markup
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(html), 'no emoji characters');
  assert.match(html, /material-symbols-outlined/);
});

await check('a bot message renders as text, not markup', () => {
  const before = globalThis.document.getElementById('chat-messages').children.length;
  widget.addMessage('<b>مرحبا</b>', 'bot');
  const msgs = globalThis.document.getElementById('chat-messages').children;
  assert.strictEqual(msgs.length, before + 1);
  assert.strictEqual(msgs[msgs.length - 1].textContent, '<b>مرحبا</b>', 'escaped as text');
});

await check('a product card shows the image URL from the database', () => {
  widget.addProductCard({
    id: 'p1',
    name: 'حليب المراعي',
    imageUrl: 'https://cdn.example.com/milk.png',
    priceLabel: '8.50 ر.س',
    finalPriceLabel: '8.50 ر.س',
    discountPercent: 0,
    inStock: true,
    unlimited: true
  }, 'info');

  const msgs = globalThis.document.getElementById('chat-messages');
  const img = msgs.querySelectorAll('img')[0];
  assert.ok(img, 'an image element was created');
  assert.strictEqual(img.src, 'https://cdn.example.com/milk.png');
});

await check('an add-to-cart card asks for confirmation before adding', () => {
  widget.addProductCard({
    id: 'p2',
    name: 'أرز',
    imageUrl: 'https://cdn.example.com/rice.png',
    priceLabel: '20.00 ر.س',
    finalPriceLabel: '20.00 ر.س',
    discountPercent: 0,
    inStock: true,
    unlimited: false,
    availableQuantity: 5
  }, 'add');

  const buttons = globalThis.document.getElementById('chat-messages').querySelectorAll('.chat-mini-btn');
  const confirm = buttons.find((b) => String(b.innerHTML).includes('نعم'));
  assert.ok(confirm, 'the confirm button exists');
  const decline = buttons.find((b) => b.textContent === 'لا، شكراً');
  assert.ok(decline, 'the decline button exists');
});

await check('an out-of-stock product gets no confirm button', () => {
  const before = globalThis.document.getElementById('chat-messages').querySelectorAll('.chat-mini-btn').length;
  widget.addProductCard({
    id: 'p3',
    name: 'منتج منتهي',
    imageUrl: '',
    priceLabel: '5.00 ر.س',
    finalPriceLabel: '5.00 ر.س',
    discountPercent: 0,
    inStock: false,
    unlimited: false,
    availableQuantity: 0
  }, 'add');
  const after = globalThis.document.getElementById('chat-messages').querySelectorAll('.chat-mini-btn').length;
  assert.strictEqual(after, before, 'nothing was added');
});

await check('starter suggestions render as clickable chips while logged in', () => {
  const suggestions = globalThis.document.getElementById('chat-suggestions');
  widget.renderSuggestions();
  const chips = suggestions.querySelectorAll('.chat-chip');
  assert.strictEqual(chips.length, widget.SUGGESTIONS.length, 'one chip per suggestion');
  assert.ok(chips.every((c) => c.listeners.click && c.listeners.click.length), 'each chip is clickable');
});

await check('no launcher is built on the login page', async () => {
  // Re-import the widget fresh (a query string bypasses the module cache) on a
  // simulated /login page: the auth pages must never show the chatbot bubble.
  const savedDoc = globalThis.document;
  const savedWindow = globalThis.window;
  globalThis.document = makeDocumentWithChatIds();
  globalThis.window = {
    location: { pathname: '/login' },
    IS_AUTHENTICATED: false,
    addEventListener() {},
    dispatchEvent() {}
  };
  await import('../public/js/scripts/chatbot.js?login-page');
  assert.strictEqual(
    globalThis.document.body.querySelector('#chatbot-root'),
    null,
    'the widget root is not added on /login'
  );
  globalThis.document = savedDoc;
  globalThis.window = savedWindow;
});

// ─── Done ────────────────────────────────────────────────────

provider.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
