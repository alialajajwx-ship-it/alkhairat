// Customer-facing text guard rails - headless, no database, no server.
//
// Two rules this suite protects:
//   1. No dash ever reaches the customer's screen. Every visible string in the
//      views, the page scripts and the Arabic messages the server builds must
//      be dash-free - including the fallback shown when data is missing.
//   2. «تواصل معنا» lists the sender's own message history and never tells the
//      customer there is an hourly send limit.
//
// Run with:  node scripts/test-visible-text.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const DASH = /[-–—]/;
const ARABIC = /[\u0600-\u06FF]/;

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

function walk(dir, ext, out = []) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, ext, out);
    else if (entry.name.endsWith(ext)) out.push(rel);
  }
  return out;
}

const stripMarkup = (value) => value
  .replace(/<[^>]*>/g, ' ')
  .replace(/\$\{[^}]*\}/g, ' ')
  .replace(/https?:\/\/\S+/g, ' ')   // a link is not prose - its own punctuation stays valid
  .replace(/&nbsp;/g, ' ');

/**
 * Every value a customer can read, taken from the source text: text nodes and
 * the display attributes of the views.
 */
function visibleValues(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const html = src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ');

  const values = html
    .replace(/<%[\s\S]*?%>/g, ' ')   // EJS code - not text
    .replace(/<[^>]*>/g, '\n')       // tags out, text nodes line by line
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const attrRe = /(placeholder|title|alt|aria-label|content)="([^"]*)"/g;
  let match;
  while ((match = attrRe.exec(html))) {
    // The viewport meta is the one attribute value the browser needs verbatim.
    if (/^width=device-width/.test(match[2])) continue;
    values.push(match[2]);
  }
  return values;
}

/** The visible form of every string literal in a JS source text */
function visibleLiterals(source) {
  const hits = [];
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, ' ');

  cleaned.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\/\/.*$/, '');
    const literals = [
      ...[...line.matchAll(/'((?:\\.|[^'\\])*)'/g)].map((m) => m[1]),
      ...[...line.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) => m[1])
    ];
    literals.forEach((literal) => {
      const visible = stripMarkup(literal).trim();
      if (visible && DASH.test(visible)) hits.push(`${index + 1}: ${literal}`);
    });
  });

  // Template literals may span lines, so they are read from the whole source.
  [...cleaned.matchAll(/`([^`]*)`/gs)].forEach((m) => {
    const visible = stripMarkup(m[1]).trim();
    if (visible && DASH.test(visible)) hits.push(m[1].slice(0, 80));
  });

  return hits;
}

const viewFiles = [...walk('public/views', '.ejs')];
const scriptFiles = [...walk('public/js', '.js')];
const serverFiles = [
  'server.js',
  ...walk('utils', '.js'),
  ...walk('routes', '.js'),
  ...walk('models', '.js'),
  ...walk('middleware', '.js')
];

console.log('\nVisible text - no dashes');

check('no view renders a dash in its text or in a display attribute', () => {
  const offenders = [];
  viewFiles.forEach((file) => {
    visibleValues(file).forEach((value) => {
      if (DASH.test(value)) offenders.push(`${file}: ${value}`);
    });
  });
  assert.deepStrictEqual(offenders, [], 'these values would show a dash to the customer');
});

check('no page script prints an Arabic string containing a dash', () => {
  const offenders = [];
  scriptFiles.forEach((file) => {
    visibleLiterals(fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .filter((hit) => ARABIC.test(hit))
      .forEach((hit) => offenders.push(`${file}: ${hit}`));
  });
  assert.deepStrictEqual(offenders, [], 'these rendered strings contain a dash');
});

check('no page script uses a dash as the "no value" placeholder', () => {
  const offenders = [];
  scriptFiles.forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    [...source.matchAll(/(['"`])\s*-\s*\1/g)].forEach(() => offenders.push(file));
  });
  assert.deepStrictEqual(offenders, [], 'a bare dash placeholder is not allowed');
});

check('no server-side Arabic message contains a dash', () => {
  const offenders = [];
  serverFiles.forEach((file) => {
    visibleLiterals(fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .filter((hit) => ARABIC.test(hit))
      .forEach((hit) => offenders.push(`${file}: ${hit}`));
  });
  assert.deepStrictEqual(offenders, [], 'an Arabic message sent to a customer contains a dash');
});

check('order ids are generated without a dash', () => {
  const orders = fs.readFileSync(path.join(ROOT, 'public/js/data/orders.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!orders.includes("'ORD-'"), 'the local order id builder still writes a dash');
  assert.ok(!server.includes("'ORD-'"), 'the server order id builder still writes a dash');
});

console.log('\nContact page - history and no hourly-limit notice');

const contactView = fs.readFileSync(path.join(ROOT, 'public/views/contact.ejs'), 'utf8');
const contactScript = fs.readFileSync(path.join(ROOT, 'public/js/scripts/contact.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

check('the page lists the sender\'s own history', () => {
  assert.ok(contactView.includes('id="contact-history-list"'), 'the history list is missing');
  assert.ok(contactView.includes('id="contact-history-empty"'), 'the empty state is missing');
  assert.ok(
    contactScript.includes("fetch('/api/contact-messages')"),
    'the page never loads the customer\'s messages'
  );
  assert.ok(
    contactScript.includes('formatOrderDateTime('),
    'the history must show when each message was sent'
  );
});

check('the history endpoint requires auth and is scoped to the sender', () => {
  const declaration = serverSource
    .split(/\r?\n/)
    .find((line) => line.includes("app.get('/api/contact-messages'"));
  assert.ok(declaration, 'GET /api/contact-messages is missing');
  assert.ok(declaration.includes('requireAuth'), 'the history endpoint must require a signed-in user');
  assert.ok(
    !declaration.includes('requireOwner'),
    'the history belongs to the customer, not the owner'
  );

  const handler = serverSource.slice(serverSource.indexOf("app.get('/api/contact-messages'"));
  const body = handler.slice(0, handler.indexOf('app.post('));
  assert.ok(
    body.includes('userId: req.user._id'),
    'the history must be filtered by the signed-in user id'
  );
  assert.ok(!body.includes('req.body.userId'), 'the history must never trust a client-supplied id');
});

check('nothing tells the customer about an hourly send limit', () => {
  const limitText = /3 رسائل|ثلاث رسائل|كحد أقصى كل ساعة|في الساعة|رسائل في الساعة|usage/;
  assert.ok(!limitText.test(contactView), 'the contact page mentions the send limit');
  assert.ok(!limitText.test(contactScript), 'the contact script mentions the send limit');
  assert.ok(!contactView.includes('contact-remaining'), 'the remaining-messages text is still rendered');
  assert.ok(!contactScript.includes('remaining'), 'the script still reads a remaining count');
  assert.ok(!serverSource.includes('remaining:'), 'the API still hands out a remaining count');
});

check('a rejected message gets a neutral error, not the limit', () => {
  const handler = serverSource.slice(serverSource.indexOf("app.post('/api/contact-messages'"));
  const body = handler.slice(0, handler.indexOf("app.get('/api/owner/contact-messages'"));
  const rejection = body.slice(body.indexOf('CONTACT_LIMIT_PER_HOUR)'), body.indexOf('ContactMessage.create'));
  assert.ok(rejection.includes('429'), 'the spam guard must still reject the extra message');
  assert.ok(
    !/رسائل في الساعة|كحد أقصى/.test(rejection),
    'the rejection message must not describe the limit'
  );
});

console.log(`\nVisible text: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
