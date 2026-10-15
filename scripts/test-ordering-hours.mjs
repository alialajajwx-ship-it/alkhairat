// Ordering hours - headless unit tests (utils/ordering-hours.js).
//
// The owner picks, per day, whether ordering from the website is open and
// between which times; the server then rejects any order placed outside that
// window. These tests pin the RULES down, because getting them wrong means
// either turning customers away while the store is open, or accepting orders
// the owner explicitly closed.
//
// No database and no browser are needed. The store clock is a fixed UTC+3, so
// the expected values below are written in UTC and are independent of the
// machine's timezone.
//
// Run with:  node scripts/test-ordering-hours.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DAY_NAMES_AR,
  defaultOrderingHours,
  normalizeTime,
  normalizeOrderingHours,
  validateOrderingHours,
  storeClock,
  formatTimeAr,
  orderingStatus
} from '../utils/ordering-hours.js';

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

/** Sunday (day 0) is 2026-10-11; every day open 16:00 → 20:00 (Riyadh = UTC+3). */
function everyDay(from = '16:00', to = '20:00', open = true) {
  return { enabled: true, days: DAY_NAMES_AR.map((_, day) => ({ day, open, from, to })) };
}

console.log('\nOrdering hours - the store clock');

check('the store clock is Saudi time (UTC+3), whatever the machine runs', () => {
  // 13:00 UTC on a Sunday = 16:00 in Riyadh, day 0
  assert.deepStrictEqual(storeClock(new Date('2026-10-11T13:00:00Z')), { day: 0, minutes: 16 * 60 });
  // 21:30 UTC on a Sunday = 00:30 on MONDAY in Riyadh (day 1)
  assert.deepStrictEqual(storeClock(new Date('2026-10-11T21:30:00Z')), { day: 1, minutes: 30 });
});

console.log('\nOrdering hours - open / closed');

check('a disabled schedule never blocks ordering', () => {
  const status = orderingStatus({ enabled: false }, new Date('2026-10-11T02:00:00Z'));
  assert.strictEqual(status.enabled, false);
  assert.strictEqual(status.open, true);
  assert.strictEqual(status.message, '');
});

check('inside the window the order is accepted', () => {
  const status = orderingStatus(everyDay(), new Date('2026-10-11T14:00:00Z')); // 17:00 Riyadh
  assert.strictEqual(status.open, true);
  assert.strictEqual(status.message, 'الطلبات متاحة الآن حتى 8:00 م');
});

check('before the window opens the order is refused until the same day', () => {
  const status = orderingStatus(everyDay(), new Date('2026-10-11T12:00:00Z')); // 15:00 Riyadh
  assert.strictEqual(status.open, false);
  assert.match(status.message, /اليوم/);
  assert.match(status.message, /4:00 م/);
  assert.strictEqual(status.nextOpen.fromLabel, '4:00 م');
  assert.strictEqual(status.nextOpen.toLabel, '8:00 م');
});

check('after the window closes the order is refused until the NEXT day', () => {
  const status = orderingStatus(everyDay(), new Date('2026-10-11T18:00:00Z')); // 21:00 Riyadh
  assert.strictEqual(status.open, false);
  assert.match(status.message, /غداً/);
  assert.strictEqual(status.nextOpen.dayLabel, 'غداً');
});

check('the window boundaries are [from, to)', () => {
  // 16:00 Riyadh is open, 20:00 Riyadh is already closed
  assert.strictEqual(orderingStatus(everyDay(), new Date('2026-10-11T13:00:00Z')).open, true);
  assert.strictEqual(orderingStatus(everyDay(), new Date('2026-10-11T17:00:00Z')).open, false);
});

check('only the selected days count', () => {
  // Sunday (0) and Monday (1) open, everything else closed
  const schedule = everyDay('16:00', '20:00', false);
  schedule.days[0].open = true;
  schedule.days[1].open = true;

  assert.strictEqual(orderingStatus(schedule, new Date('2026-10-11T14:00:00Z')).open, true, 'Sunday 17:00');
  assert.strictEqual(orderingStatus(schedule, new Date('2026-10-12T14:00:00Z')).open, true, 'Monday 17:00');
  // Tuesday is closed - the customer waits until the next Sunday
  const tuesday = orderingStatus(schedule, new Date('2026-10-13T14:00:00Z'));
  assert.strictEqual(tuesday.open, false);
  assert.strictEqual(tuesday.nextOpen.dayLabel, 'الأحد');
});

check('a window that crosses midnight stays open in the early morning', () => {
  const schedule = everyDay('22:00', '02:00');
  assert.strictEqual(orderingStatus(schedule, new Date('2026-10-11T19:00:00Z')).open, true, '22:00 Riyadh');
  assert.strictEqual(orderingStatus(schedule, new Date('2026-10-11T21:00:00Z')).open, true, '00:00 Riyadh (next day)');
  assert.strictEqual(orderingStatus(schedule, new Date('2026-10-11T22:30:00Z')).open, true, '01:30 Riyadh');
  assert.strictEqual(orderingStatus(schedule, new Date('2026-10-11T23:30:00Z')).open, false, '02:30 Riyadh');
});

check('every day closed is reported as temporarily unavailable', () => {
  const status = orderingStatus(everyDay('16:00', '20:00', false), new Date('2026-10-11T14:00:00Z'));
  assert.strictEqual(status.open, false);
  assert.strictEqual(status.nextOpen, null);
  assert.match(status.message, /متوقف/);
});

check('a malformed stored schedule falls back to \"always open\" defaults', () => {
  assert.strictEqual(orderingStatus(null, new Date()).open, true);
  assert.strictEqual(orderingStatus('garbage', new Date()).open, true);
  const partial = normalizeOrderingHours({ enabled: true, days: [{ day: 0, open: true, from: '9', to: 'لا شيء' }] });
  assert.strictEqual(partial.days.length, 7, 'always a full week');
  assert.strictEqual(partial.days[0].from, '16:00', 'a bad time falls back to the default');
  assert.strictEqual(partial.days[1].open, false, 'a missing day is closed');
});

console.log('\nOrdering hours - validation (owner input)');

check('a valid schedule passes', () => {
  assert.strictEqual(validateOrderingHours(everyDay()), null);
  // A closed day does not need usable times
  assert.strictEqual(
    validateOrderingHours({ enabled: true, days: [{ day: 3, open: false, from: '', to: '' }] }),
    null
  );
});

check('bad payloads are rejected with an Arabic reason', () => {
  assert.ok(validateOrderingHours(null));
  assert.ok(validateOrderingHours({ enabled: 'yes', days: [] }));
  assert.ok(validateOrderingHours({ enabled: true, days: 'nope' }));
  assert.ok(validateOrderingHours({ enabled: true, days: [{ day: 9, open: true, from: '16:00', to: '20:00' }] }));
  assert.ok(validateOrderingHours({ enabled: true, days: [{ day: 0, open: true, from: '25:00', to: '20:00' }] }));
  assert.ok(validateOrderingHours({ enabled: true, days: [{ day: 0, open: true, from: '16:00', to: '16:00' }] }));
  assert.match(
    validateOrderingHours({ enabled: true, days: [{ day: 2, open: true, from: '', to: '20:00' }] }),
    /الثلاثاء/
  );
});

check('normalizeTime accepts only real 24-hour times', () => {
  assert.strictEqual(normalizeTime('9:05'), '09:05');
  assert.strictEqual(normalizeTime('16:00'), '16:00');
  assert.strictEqual(normalizeTime('23:59'), '23:59');
  assert.strictEqual(normalizeTime('24:00'), null);
  assert.strictEqual(normalizeTime('16:60'), null);
  assert.strictEqual(normalizeTime('4 pm'), null);
  assert.strictEqual(normalizeTime(undefined), null);
});

check('times are shown to the customer in 12-hour Arabic', () => {
  assert.strictEqual(formatTimeAr('16:00'), '4:00 م');
  assert.strictEqual(formatTimeAr('00:30'), '12:30 ص');
  assert.strictEqual(formatTimeAr('12:00'), '12:00 م');
  assert.strictEqual(formatTimeAr('07:15'), '7:15 ص');
});

check('the default schedule is disabled and covers all seven days', () => {
  const defaults = defaultOrderingHours();
  assert.strictEqual(defaults.enabled, false);
  assert.deepStrictEqual(defaults.days.map((d) => d.day), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(defaults.days.every((d) => d.open === false));
  assert.deepStrictEqual(DAY_NAMES_AR.slice(0, 3), ['الأحد', 'الاثنين', 'الثلاثاء']);
});

console.log('\nOrdering hours - owner form wiring');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const view = fs.readFileSync(path.join(ROOT, 'public', 'views', 'owner-settings.ejs'), 'utf-8');
const script = fs.readFileSync(path.join(ROOT, 'public', 'js', 'scripts', 'settings.js'), 'utf-8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8');

check('the owner settings page and its script agree on every element id', () => {
  ['oh-toggle', 'oh-days', 'oh-apply-all', 'oh-save', 'oh-status'].forEach((id) => {
    assert.ok(view.includes(`id="${id}"`), `owner-settings.ejs has no #${id}`);
    assert.ok(script.includes(`'${id}'`), `settings.js never touches #${id}`);
  });

  // The per-day controls are generated by the script, so its own markup and
  // its own lookups must use the same class names.
  ['oh-open', 'oh-from', 'oh-to'].forEach((cls) => {
    assert.ok(script.includes(`.${cls}[data-day=`), `settings.js never reads .${cls} by day`);
    assert.ok(script.includes(`class="${cls}"`), `settings.js never renders .${cls}`);
  });
});

check('the form talks to the owner-only ordering-hours endpoints', () => {
  assert.ok(script.includes("fetch('/api/owner/ordering-hours')"), 'the form must load the saved schedule');
  assert.ok(script.includes("fetch('/api/owner/ordering-hours', {"), 'the form must save the schedule');
  assert.ok(
    server.includes("app.get('/api/owner/ordering-hours', requireAuth, requireOwner"),
    'the schedule read must be owner-only'
  );
  assert.ok(
    server.includes("app.post('/api/owner/ordering-hours', requireAuth, requireOwner"),
    'the schedule write must be owner-only'
  );
  assert.ok(server.includes('validateOrderingHours('), 'the server must validate the submitted schedule');
});

check('the ordering-hours form is NOT on the customer settings page', () => {
  const customerView = fs.readFileSync(path.join(ROOT, 'public', 'views', 'settings.ejs'), 'utf-8');
  assert.ok(!customerView.includes('oh-days'), 'customers must not get the owner controls');
  assert.ok(!customerView.includes('mm-toggle'), 'customers must not get the maintenance switch');
});

console.log(`\nOrdering hours: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
