// Authorization guard rail - headless, no database, no server.
//
// The store keeps every customer's data and the owner's settings in one
// process, so the ONLY thing standing between a normal visitor and the owner's
// controls is the middleware chain on each route. This suite reads the real
// server source and fails when a route that must be protected is not - it
// catches the classic "someone added an endpoint and forgot requireOwner"
// regression before it can ever ship.
//
// It checks, from the source itself:
//   • every owner/admin endpoint (and owner page) is behind requireAuth +
//     requireOwner, with requireAuth FIRST
//   • every ordering endpoint is behind the ordering gate (maintenance mode +
//     the weekly ordering hours)
//   • every /api/me/* endpoint authenticates and edits ONLY req.user (never an
//     id taken from the request body/query/params)
//   • the cart API authenticates every request
//   • no route mass-assigns the request body onto a document
//
// Run with:  node scripts/test-authz.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8');
const cartRoutes = fs.readFileSync(path.join(ROOT, 'routes', 'cart.js'), 'utf-8');

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

/**
 * Every `app.<method>('…', middleware…` declaration, as the source writes it.
 * A route that put its path on a different line than `app.method(` would slip
 * through this regex, so the count is cross-checked below.
 */
function routeDeclarations(source) {
  const routes = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/app\.(get|post|put|delete|patch)\(\s*'([^']+)'/);
    if (!match) return;
    routes.push({ method: match[1].toUpperCase(), path: match[2], line: line.trim(), number: index + 1 });
  });
  return routes;
}

const routes = routeDeclarations(server);
const allAppCalls = [...server.matchAll(/app\.(get|post|put|delete|patch)\(/g)].length;

console.log('\nAuthorization - route registry');

check('every route declaration is on one line (so none is invisible to this test)', () => {
  assert.strictEqual(
    routes.length,
    allAppCalls,
    `${allAppCalls} app.<method>() calls but only ${routes.length} declarations were parsed`
  );
  assert.ok(routes.length > 50, `expected the real server's routes, found ${routes.length}`);
});

check('every /api/owner/* and /api/admin/* route requires auth AND the owner role', () => {
  const guarded = routes.filter((r) => /^\/api\/(owner|admin)\//.test(r.path));
  assert.ok(guarded.length >= 12, `expected the owner API routes, found ${guarded.length}`);

  const unguarded = guarded.filter(
    (r) => !r.line.includes('requireAuth') || !r.line.includes('requireOwner')
  );
  assert.deepStrictEqual(
    unguarded.map((r) => `${r.method} ${r.path} (server.js:${r.number})`),
    [],
    'these owner/admin endpoints are missing requireAuth/requireOwner'
  );

  // requireAuth must run BEFORE requireOwner, otherwise a guest is compared
  // against a user that was never attached to the request.
  const wrongOrder = guarded.filter(
    (r) => r.line.indexOf('requireOwner') < r.line.indexOf('requireAuth')
  );
  assert.deepStrictEqual(wrongOrder.map((r) => r.path), [], 'requireAuth must come before requireOwner');
});

check('every owner-only PAGE redirects non-owners away', () => {
  // These pages use the middleware pair directly.
  ['/alternatives', '/deleted-products', '/dashboard', '/customer-order', '/banner', '/delivery-price']
    .forEach((page) => {
      const route = routes.find((r) => r.path === page);
      assert.ok(route, `${page} is missing`);
      assert.ok(
        route.line.includes('requireAuth') && route.line.includes('requireOwner'),
        `${page} is not restricted to the owner`
      );
    });

  // /owner-settings and /alternatives-sms check the role inside the handler so
  // a guest gets redirected to /login instead of a raw 401. Both checks must
  // still exist in the source.
  ['/owner-settings', '/alternatives-sms'].forEach((page) => {
    assert.ok(routes.some((r) => r.path === page), `${page} is missing`);
  });
  assert.ok(
    server.includes("if (req.user.role !== 'owner') return res.redirect('/');"),
    'owner-only pages must redirect non-owners home'
  );
});

check('every ordering endpoint is behind the ordering gate (pause + hours)', () => {
  ['/api/place-order', '/api/create-payment'].forEach((endpoint) => {
    const route = routes.find((r) => r.path === endpoint);
    assert.ok(route, `${endpoint} is missing`);
    assert.ok(route.line.includes('requireAuth'), `${endpoint} must require a signed-in user`);
    assert.ok(
      route.line.includes('orderingGate'),
      `${endpoint} must run the orderingGate (maintenance mode + ordering hours)`
    );
  });

  // The gate itself must enforce BOTH rules, not just one.
  const gate = server.slice(server.indexOf('function orderingGate'));
  const gateBody = gate.slice(0, gate.indexOf('\n}'));
  assert.ok(gateBody.includes('maintenanceMode'), 'orderingGate must honor maintenance mode');
  assert.ok(gateBody.includes('orderingStatus'), 'orderingGate must honor the ordering hours');
});

check('every /api/me/* endpoint authenticates and edits only req.user', () => {
  const meRoutes = routes.filter((r) => r.path.startsWith('/api/me/'));
  assert.ok(meRoutes.length >= 6, `expected the account endpoints, found ${meRoutes.length}`);

  const unauthenticated = meRoutes.filter((r) => !r.line.includes('requireAuth'));
  assert.deepStrictEqual(unauthenticated.map((r) => r.path), [], 'account endpoints must require auth');

  // Reading/writing the signed-in user's own document is the whole point; a
  // handler that identified the ACCOUNT from the request instead would be an
  // IDOR. (Non-account ids - a banner id, a product id - are fine; they are
  // resolved inside owner-only endpoints.)
  const identityFromRequest = [
    /req\.body\.userId/,
    /req\.body\.user\b/,
    /req\.query\.userId/,
    /req\.params\.userId/,
    /req\.body\.role/,
    /req\.body\.isOwner/,
    /req\.body\.owner\b/
  ];
  identityFromRequest.forEach((pattern) => {
    assert.ok(!pattern.test(server), `a route takes the account identity from the request: ${pattern}`);
  });
  assert.ok(
    server.includes('req.user.getAddresses()'),
    'address edits must operate on the signed-in user\'s own address list'
  );
  assert.ok(
    server.includes('await req.user.save()'),
    'account edits must save the authenticated user document'
  );
});

check('the cart API authenticates every request', () => {
  assert.ok(
    cartRoutes.includes('router.use(requireAuth)'),
    'cart.js must mount requireAuth for the whole router'
  );
  assert.ok(cartRoutes.includes('req.user._id'), 'cart reads must be scoped to req.user._id');
});

check('no route mass-assigns the request body onto a document', () => {
  const source = server + cartRoutes;
  const dangerous = [
    /new User\(\s*req\.body/,
    /User\.create\(\s*req\.body/,
    /Object\.assign\([^)]*req\.body/,
    /\.\.\.req\.body/
  ];
  dangerous.forEach((pattern) => {
    assert.ok(!pattern.test(source), `forbidden mass assignment: ${pattern}`);
  });
});

console.log(`\nAuthorization: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
