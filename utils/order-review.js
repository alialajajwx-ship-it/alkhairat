// Pure helpers for the owner's availability review of an order
// (مراجعة توفر المنتجات → alternatives-SMS) and for the stock rules that
// review leaves behind (a 24h quantity cap / a 24h hide / a sold-out hide).
// Kept free of database and request state so every decision can be unit-tested
// on its own.

/** How long an owner's stock statement stays valid (cap, hide, sold-out) */
export const REVIEW_STOCK_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Index the owner's marks by productId (marks for products that are not part
 * of the order — e.g. an alternative the owner picked — are kept too).
 * @param {Array|null} replacements - [{ productId, state, available, ... }]
 * @returns {Map<string, object>}
 */
function markByProductId(replacements) {
  return new Map(
    (replacements || [])
      .filter((r) => r && r.productId)
      .map((r) => [r.productId, r])
  );
}

/**
 * Can the reviewed order still be fulfilled? True when one of the CUSTOMER'S
 * OWN items is marked 'low' or 'unavailable'. Marks on other products (the
 * alternatives the owner browsed) are ignored — they must never cancel an
 * order whose own items are all available.
 * @param {Array} items - the order's decrypted items [{ productId, quantity }]
 * @param {Array|null} replacements - the owner's review marks
 * @returns {boolean}
 */
export function hasOrderProblem(items, replacements) {
  const orderedIds = new Set((items || []).map((item) => item && item.productId));
  return (replacements || []).some(
    (r) => r && orderedIds.has(r.productId) &&
      (r.state === 'low' || r.state === 'unavailable')
  );
}

/**
 * Decide what goes back into the customer's cart after a cancelled order.
 * - 'unavailable'            → not returned at all
 * - 'low' with available = 0 → treated exactly like 'unavailable'
 * - 'low' with available = 2 → returned with min(ordered, 2), so the customer
 *                              never sees a quantity the store cannot fulfil
 * - 'available', or no mark  → returned with the ordered quantity
 * @param {Array} items - the order's decrypted items [{ productId, quantity }]
 * @param {Array|null} replacements - the owner's review marks
 * @returns {Map<string, { quantity: number, capped: boolean }>} productId → return
 */
export function computeReturnQuantities(items, replacements) {
  const marks = markByProductId(replacements);
  const result = new Map();

  (items || []).forEach((item) => {
    if (!item || !item.productId) return;

    const mark = marks.get(item.productId);
    if (mark && mark.state === 'unavailable') return; // nothing goes back

    let quantity = Math.max(1, Number(item.quantity) || 1);
    let capped = false;

    if (mark && mark.state === 'low' && mark.available != null) {
      const available = Math.max(0, Number(mark.available) || 0);
      if (available === 0) return; // sold out → same as unavailable
      quantity = Math.min(quantity, available);
      capped = true;
    }

    result.set(item.productId, { quantity, capped });
  });

  return result;
}

// ─── Stock lifecycle (all pure: they mutate the product objects they are
// given and report whether anything changed, so the caller can persist) ────

function findProduct(products, productId) {
  return (products || []).find((p) => p && p.id === productId);
}

function isoIn(hours, now) {
  return new Date(now + hours * HOUR_MS).toISOString();
}

/**
 * True while a product's temporary hide is still running. An EXPIRED hide is
 * not a hide — the product is visible to customers again (and the owner must
 * not see an "انتهت مدة الإخفاء" tag for it).
 */
export function isHideActive(product, now = Date.now()) {
  if (!product || product.hidden !== true) return false;
  if (!product.hideUntil) return true; // manual hide — until the owner unhides
  return new Date(product.hideUntil).getTime() > now;
}

/** Hide a product for the review window, remembering why */
function hideTemporarily(product, now, reason) {
  product.hidden = true;
  product.hideUntil = isoIn(REVIEW_STOCK_HOURS, now);
  product.hideReason = reason;
}

/**
 * Undo a hide the SYSTEM applied (sold out, or a «غير متوفر» review mark).
 * A manual owner hide (no reason) is left alone.
 * @returns {boolean} whether the product changed
 */
function revealSystemHidden(product) {
  if (product.hidden !== true) return false;
  if (product.hideReason !== 'soldout' && product.hideReason !== 'unavailable') return false;
  delete product.hidden;
  delete product.hideUntil;
  delete product.hideReason;
  return true;
}

/**
 * Clean everything that has run out of the catalog:
 * - a finished hide                  → visible again
 * - a finished review quantity cap    → back to unlimited
 * - a finished discount               → removed
 * - a legacy unlimited-quantity window → removed
 * Mutates the products in place.
 * @returns {boolean} true when something changed (persist the catalog then)
 */
export function pruneExpired(products, now = Date.now()) {
  let dirty = false;

  (products || []).forEach((product) => {
    if (!product || typeof product !== 'object') return;

    if (product.hidden === true && product.hideUntil &&
        new Date(product.hideUntil).getTime() <= now) {
      delete product.hidden;
      delete product.hideUntil;
      delete product.hideReason;
      dirty = true;
    }

    if (product.stockUntil && new Date(product.stockUntil).getTime() <= now) {
      // The owner's temporary "only N left" statement has expired — nobody
      // remembers what the quantity was before it, so the product is
      // unlimited again until the owner says otherwise. The owner-facing
      // «في المخزون» count goes with it (the pair cannot drift apart).
      delete product.stockQuantity;
      delete product.ownerStock;
      delete product.stockUntil;
      product.unlimitedQuantity = true;
      dirty = true;
    }

    if (product.discountUntil && new Date(product.discountUntil).getTime() <= now) {
      delete product.discountPercent;
      delete product.discountUntil;
      delete product.discountSetAt;
      dirty = true;
    }

    if (product.unlimitedUntil && new Date(product.unlimitedUntil).getTime() <= now) {
      delete product.unlimitedUntil;
      dirty = true;
    }
  });

  return dirty;
}

/**
 * Apply the owner's review marks to the catalog. Called when the alternatives
 * SMS is sent — the moment the owner commits their findings:
 * - «متوفر N فقط»  → stockQuantity = N, capped for 24 hours for every customer
 *                     (available = 0 means "nothing left" → hidden instead)
 * - «غير متوفر»     → hidden from every customer for 24 hours
 * - «متوفر»         → the product is orderable again (a system hide is lifted)
 * @returns {boolean} true when something changed
 */
export function applyReviewAvailability(products, review, now = Date.now()) {
  if (!review || !Array.isArray(review.replacements)) return false;
  let dirty = false;

  review.replacements.forEach((r) => {
    if (!r || !r.productId) return;
    const product = findProduct(products, r.productId);
    if (!product) return;

    if (r.state === 'unavailable') {
      hideTemporarily(product, now, 'unavailable');
      dirty = true;
      return;
    }

    const available = r.available == null ? null : Math.max(0, Math.round(Number(r.available) || 0));

    if (r.state === 'low' && available === 0) {
      // "only 0 left" is the same thing as غير متوفر
      hideTemporarily(product, now, 'unavailable');
      dirty = true;
      return;
    }

    if (r.state === 'low' && available !== null) {
      product.stockQuantity = available;
      product.stockUntil = isoIn(REVIEW_STOCK_HOURS, now);
      delete product.unlimitedQuantity;
      delete product.unlimitedUntil;
      revealSystemHidden(product);
      dirty = true;
      return;
    }

    // «متوفر» (or a low mark without a number): the product is obtainable
    if (revealSystemHidden(product)) dirty = true;
  });

  return dirty;
}

/**
 * An order was accepted: the stock it consumed is gone from the store for
 * EVERY customer. A capped product loses the ordered quantity from its
 * customer-facing availability — the next customers can only order what is
 * left. The owner's own «في المخزون» count (product.ownerStock) is NOT
 * touched: until the order is delivered the goods are still on the shelf.
 * Taking the last units leaves nothing (0) → the product is also sold out,
 * so it is hidden for everyone for 24 hours. The cap itself is kept, so it is
 * back in force (for good) once the hide expires.
 * @returns {boolean} true when something changed
 */
export function markSoldOut(products, items, now = Date.now()) {
  let dirty = false;

  (items || []).forEach((item) => {
    if (!item || !item.productId) return;
    const product = findProduct(products, item.productId);
    if (!product) return;

    const cap = Number(product.stockQuantity);
    if (product.stockQuantity == null || !Number.isFinite(cap) || cap <= 0) return;

    const ordered = Math.max(0, Math.round(Number(item.quantity) || 0));
    if (ordered <= 0) return;

    // Consume the order from the cap. Ordering more than what is left (a
    // stale cart) empties it rather than going negative.
    const left = Math.max(0, cap - ordered);
    product.stockQuantity = left;
    dirty = true;

    // Nothing left → sold out. An existing hide (manual, or a «غير متوفر»
    // review mark) is never overwritten: only a product that is still on
    // sale earns the 24h sold-out hide.
    if (left === 0 && !isHideActive(product, now)) {
      hideTemporarily(product, now, 'soldout');
    }
  });

  return dirty;
}

/**
 * A cancelled order never consumed its stock: give the ordered quantity back
 * to the cap and lift the sold-out hide it caused. Hides from the owner
 * (manual or a «غير متوفر» mark) are kept.
 * @returns {boolean} true when something changed
 */
export function restoreSoldOut(products, items) {
  let dirty = false;

  (items || []).forEach((item) => {
    if (!item || !item.productId) return;
    const product = findProduct(products, item.productId);
    if (!product) return;

    // The order never took this stock — put it back on the shelf (an
    // unlimited product has no cap to give back to)
    const cap = Number(product.stockQuantity);
    const ordered = Math.max(0, Math.round(Number(item.quantity) || 0));
    if (product.stockQuantity != null && Number.isFinite(cap) && ordered > 0) {
      product.stockQuantity = cap + ordered;
      dirty = true;
    }

    if (product.hideReason !== 'soldout') return;
    delete product.hidden;
    delete product.hideUntil;
    delete product.hideReason;
    dirty = true;
  });

  return dirty;
}
