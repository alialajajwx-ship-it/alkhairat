// MongoDB-backed catalog access.
//
// This replaces the old readCatalog()/writeCatalog() pair that loaded the whole
// data/products.json into memory and rewrote the entire file on every owner
// edit. Everything is async now and works per-document, which is what lets the
// store hold thousands of products without rewriting a file or shipping the
// whole catalog to each browser.
//
// The owner-side stock rules in utils/order-review.js stay pure and unchanged:
// callers load only the products an operation touches, run the same tested
// mutation over them, and persist whatever changed. No rule was re-implemented
// here, so the existing behaviour (and its tests) still hold.

import Product, { CATEGORY_TYPES } from '../models/Product.js';
import { pruneExpired } from './order-review.js';

// Re-exported so every caller keeps importing it from the catalog layer.
// The list itself lives in models/Product.js next to the schema.
export { CATEGORY_TYPES };

// How many cards a browse page shows by default, and the hard ceiling a client
// may ask for. The ceiling is what stops ?limit=99999 from turning the
// pagination into the exact full-catalog payload it exists to avoid.
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;

// Optional product fields. The pure review helpers remove settings with
// `delete product.field`, so a plain $set would leave the old value behind —
// these are explicitly $unset whenever they are absent from the saved object.
// The value is only a marker: MongoDB ignores it, but it must be truthy so a
// removal is recognisable in a logged or asserted update document.
const UNSET_MARKER = 1;

const OPTIONAL_FIELDS = [
  'discountPercent',
  'discountSetAt',
  'discountUntil',
  'unlimitedQuantity',
  'stockQuantity',
  'ownerStock',
  'stockUntil',
  'unlimitedUntil',
  'hidden',
  'hideUntil',
  'hideReason',
  'deleted'
];

/**
 * A product with neither a set quantity nor the unlimited flag is treated as
 * UNLIMITED by default — the owner never sees "الكمية: null" on a card.
 * Same rule the JSON catalog applied on read.
 */
export function normalizeQuantity(product) {
  if (product.unlimitedQuantity !== true && product.stockQuantity == null) {
    product.unlimitedQuantity = true;
  }
  return product;
}

/**
 * Documents inserted by hand (or by an older export) may only carry _id.
 * Expose it as `id` so every caller keeps using one identifier.
 */
function withId(doc) {
  if (!doc) return doc;
  if (doc.id == null && doc._id != null) doc.id = String(doc._id);
  return normalizeQuantity(doc);
}

function mapDocs(docs) {
  return (docs || []).map(withId);
}

/** Escape a user-supplied search term before it becomes a RegExp */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fold Arabic text so a search is forgiving: drop the diacritics / tatweel and
 * unify the alef / ya / ta-marbuta variants. «شاى» then matches «شاي» and
 * «أرز» matches «ارز».
 *
 * MUST stay in sync with the same-named helpers in
 * public/js/scripts/browse.js and public/js/scripts/owner-browsing.js.
 */
export function foldArabicText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647');
}

/**
 * A Mongo regex that matches `term` inside a field whose text may hold any
 * Arabic variant of the term's letters. The term is folded first (so its own
 * diacritics are gone) and every variant letter becomes a character class, so
 * a search for «شاي» matches a stored «شاى» or «شَاي».
 */
function foldRegexTerm(term) {
  const FOLD = {
    '\u0627': '[\u0623\u0625\u0622\u0671\u0627]', // ا + أ إ آ ٱ
    '\u064A': '[\u0649\u064A]',                    // ي + ى
    '\u0647': '[\u0629\u0647]'                     // ه + ة
  };
  // Diacritics / tatweel are allowed between the letters, so a stored
  // «شَاي» still matches a search for «شاي».
  const DIACRITICS = '[\u064B-\u0652\u0640]*';
  const body = [...foldArabicText(term)]
    .map((ch) => DIACRITICS + (FOLD[ch] || escapeRegex(ch)))
    .join('');
  return new RegExp(body, 'i');
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A Mongo expression that folds a product NAME the same way foldArabicText()
 * folds a search term, so $indexOfCP can find the match POSITION inside it.
 * Names are short, so the handful of $replaceAll calls stay cheap.
 */
function foldedNameExpr() {
  let expr = { $toLower: '$name' };
  const variants = [
    ['\u0623', '\u0627'], // أ → ا
    ['\u0625', '\u0627'], // إ → ا
    ['\u0622', '\u0627'], // آ → ا
    ['\u0671', '\u0627'], // ٱ → ا
    ['\u0649', '\u064A'], // ى → ي
    ['\u0629', '\u0647']  // ة → ه
  ];
  for (const [find, replacement] of variants) {
    expr = { $replaceAll: { input: expr, find, replacement } };
  }
  return expr;
}

// A name hit always outranks a keyword-only hit; among name hits the earlier
// the term appears the higher it scores. This is what keeps a search for «شاي»
// showing tea («شاي ربيع…», position 0) before «بسكويت الشاي» (position 15)
// and the biscuits/snacks that only carry «شاي» as a keyword (score 0).
const NAME_MATCH_BASE = 1000000;

function relevanceExpr(re, foldedTerm) {
  const position = { $indexOfCP: [foldedNameExpr(), foldedTerm] };
  const inName = { $regexMatch: { input: '$name', regex: re } };
  return {
    $cond: [
      inName,
      {
        $cond: [
          { $gte: [position, 0] },
          { $subtract: [NAME_MATCH_BASE, position] },
          // Name matched via a spelling variant the raw index could not find.
          NAME_MATCH_BASE - 1
        ]
      },
      0
    ]
  };
}

/**
 * What a CUSTOMER may see: not deleted, and not currently hidden. A hide with
 * no deadline is the owner's decision (invisible); a hide whose window has
 * passed is over, so the product is visible again.
 *
 * Mirrors server.js isProductActive() exactly, as a Mongo filter.
 */
export function activeConditions(nowIso) {
  return {
    deleted: { $ne: true },
    $or: [
      { hidden: { $ne: true } },
      { hideUntil: { $ne: null, $lte: nowIso } }
    ]
  };
}

/**
 * A discount is only real while its percentage is positive and its deadline
 * has not passed (no deadline = runs until the owner removes it).
 */
function activeDiscountConditions(nowIso) {
  return {
    discountPercent: { $gt: 0 },
    // No deadline (absent or null) = the discount runs until it is removed.
    // `{ field: null }` matches both a missing field and an explicit null.
    $or: [{ discountUntil: null }, { discountUntil: { $gt: nowIso } }]
  };
}

const PRICE_RANGES = {
  under10: { $gte: 0, $lt: 1000 },
  '10to30': { $gte: 1000, $lt: 3000 },
  over30: { $gte: 3000 }
};

/**
 * Build the Mongo filter for a customer catalog query.
 * @param {{ type?: string, priceRange?: string, search?: string,
 *           discount?: boolean, now?: Date }} options
 */
export function buildCustomerFilter({ type, priceRange, search, discount, now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const and = [activeConditions(nowIso)];

  if (type && type !== 'all') and.push({ type });

  const price = PRICE_RANGES[priceRange];
  if (price) and.push({ priceCents: price });

  if (discount) and.push(activeDiscountConditions(nowIso));

  const term = String(search || '').trim();
  if (term) {
    // The term is matched against the product name OR any one of its search
    // keywords, folded so Arabic spelling variants still hit.
    const re = foldRegexTerm(term);
    and.push({ $or: [{ name: re }, { keyWords: re }] });
  }

  return { $and: and };
}

function customerSort(sort) {
  if (sort === 'newest') return { discountSetAt: -1, _id: 1 };
  // Insertion order — the same stable order the JSON file used to have, which
  // is what makes paging consistent across requests.
  return { _id: 1 };
}

/**
 * Per-category counts for the browse sidebar, computed on the SERVER so the
 * numbers stay right now that the page only holds one page of products.
 * @returns {Promise<{ all: number, [type: string]: number }>}
 */
export async function categoryCounts(now = new Date()) {
  const rows = await Product.aggregate([
    { $match: activeConditions(now.toISOString()) },
    { $group: { _id: '$type', n: { $sum: 1 } } }
  ]);

  const counts = { all: 0 };
  CATEGORY_TYPES.forEach((type) => { counts[type] = 0; });
  rows.forEach((row) => {
    const n = Number(row.n) || 0;
    counts.all += n;
    if (row._id) counts[row._id] = n;
  });
  return counts;
}

/**
 * One page of the customer catalog, plus everything the browse UI needs to
 * render it (totals, page count, sidebar counts).
 *
 * @param {{ type?, priceRange?, search?, discount?, sort?, page?, limit?,
 *           random? }} options
 * @returns {Promise<{ products: Array, total: number, page: number,
 *                     pages: number, limit: number, counts: object }>}
 */
export async function listProducts(options = {}) {
  const limit = Math.min(Math.max(toInt(options.limit, DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const filter = buildCustomerFilter(options);

  const total = await Product.countDocuments(filter);
  const pages = Math.max(1, Math.ceil(total / limit));
  // Asking for a page past the end lands on the last real page instead of an
  // empty grid the customer cannot navigate out of.
  const page = Math.min(Math.max(toInt(options.page, 1), 1), pages);

  const term = String(options.search || '').trim();

  let docs;
  // `random` shows a fresh selection of products the moment the page opens.
  // It only applies to the FIRST page: later pages keep the stable insertion
  // order that makes «التالي/السابق» coherent (total and pages are unchanged,
  // so the pager still walks the whole catalog).
  if (options.random && page === 1 && total > 0) {
    docs = await Product.aggregate([
      { $match: filter },
      { $sample: { size: limit } }
    ]);
  } else if (term) {
    // Search results are ordered by relevance instead of insertion order, so
    // the products that actually carry the term in their NAME come first (and
    // the earlier in the name, the higher). The score field is dropped again
    // before the page leaves the database.
    docs = await Product.aggregate([
      { $match: filter },
      { $addFields: { _relevance: relevanceExpr(foldRegexTerm(term), foldArabicText(term)) } },
      { $sort: { _relevance: -1, _id: 1 } },
      { $unset: '_relevance' },
      { $skip: (page - 1) * limit },
      { $limit: limit }
    ]);
  } else {
    docs = await Product.find(filter)
      .sort(customerSort(options.sort))
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
  }

  const counts = await categoryCounts();
  return { products: mapDocs(docs), total, page, pages, limit, counts };
}

/**
 * Products whose name (or a keyword) is one of the given names, in the order
 * the names were given. Powers the «متوفر ومشابه لطلبك» pinned block on the
 * browse page: those items must be found even though they may live on a page
 * far from the one the customer is looking at.
 */
export async function listProductsByNames(names, { limit = 50 } = {}) {
  const wanted = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))]
    .slice(0, limit);
  if (!wanted.length) return [];

  const docs = await Product.find({
    $and: [
      activeConditions(new Date().toISOString()),
      { $or: [{ name: { $in: wanted } }, { keyWords: { $in: wanted } }] }
    ]
  }).limit(limit).lean();

  const rank = new Map(wanted.map((name, index) => [name, index]));
  const rankOf = (product) => {
    if (rank.has(product.name)) return rank.get(product.name);
    const hit = (product.keyWords || []).find((k) => rank.has(k));
    return hit == null ? Number.MAX_SAFE_INTEGER : rank.get(hit);
  };

  return mapDocs(docs).sort((a, b) => rankOf(a) - rankOf(b));
}

/**
 * Exact products for a set of ids — powers the cart, checkout limits and the
 * order pages, which only ever need the handful of products they reference.
 * @param {string[]} ids
 * @param {{ includeHidden?: boolean, limit?: number }} [options]
 */
export async function listProductsByIds(ids, options = {}) {
  const wanted = [...new Set((ids || []).filter(Boolean).map(String))].slice(0, options.limit || 500);
  if (!wanted.length) return [];

  const and = [{ id: { $in: wanted } }];
  if (!options.includeHidden) and.push(activeConditions(new Date().toISOString()));

  const docs = await Product.find({ $and: and }).limit(wanted.length).lean();
  const found = new Map(mapDocs(docs).map((p) => [p.id, p]));
  // Keep the caller's order and drop ids that no longer exist
  return wanted.map((id) => found.get(id)).filter(Boolean);
}

/**
 * productId → imageUrl for any product, hidden or deleted included.
 * Lets an older order show its photos after the product left the catalog.
 * @returns {Promise<Map<string, string>>}
 */
export async function productImageMap(ids) {
  const wanted = [...new Set((ids || []).filter(Boolean).map(String))].slice(0, 500);
  if (!wanted.length) return new Map();

  const docs = await Product.find({ id: { $in: wanted } })
    .select('id imageUrl')
    .lean();

  return new Map(docs.map((doc) => [doc.id != null ? doc.id : String(doc._id), doc.imageUrl || '']));
}

/**
 * The owner catalog (stock status flags are added by the caller).
 * @param {{ includeDeleted?: boolean }} [options]
 */
export async function listOwnerProducts({ includeDeleted = false } = {}) {
  const filter = includeDeleted ? {} : { deleted: { $ne: true } };
  const docs = await Product.find(filter).sort({ _id: 1 }).lean();
  return mapDocs(docs);
}

/** A single product by id (any visibility), or null */
export async function getProductById(id) {
  const doc = await Product.findOne({ id: String(id) }).lean();
  return doc ? withId(doc) : null;
}

/** Persist a whole plain product object, removing fields it no longer has */
async function savePlain(plain) {
  const set = {};
  const unset = {};

  for (const [key, value] of Object.entries(plain)) {
    if (key === '_id' || key === '__v' || key === 'createdAt' || key === 'updatedAt') continue;
    if (value === undefined) {
      unset[key] = UNSET_MARKER;
      continue;
    }
    set[key] = value;
  }

  // `delete product.x` in the pure helpers must actually remove the field
  for (const field of OPTIONAL_FIELDS) {
    if (!(field in set)) unset[field] = UNSET_MARKER;
  }

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  if (!Object.keys(update).length) return;

  const filter = plain._id != null ? { _id: plain._id } : { id: plain.id };
  await Product.updateOne(filter, update);
}

/**
 * Load the products with these ids, run a pure mutation over them, and persist
 * only when it reports a change. This is the bridge to utils/order-review.js.
 * @param {string[]} ids
 * @param {(products: Array) => boolean} mutate
 * @returns {Promise<boolean>} whether anything changed
 */
export async function mutateProducts(ids, mutate) {
  const wanted = [...new Set((ids || []).filter(Boolean).map(String))].slice(0, 1000);
  if (!wanted.length) return false;

  const docs = await Product.find({ id: { $in: wanted } }).lean();
  if (!docs.length) return false;

  const plains = mapDocs(docs);
  if (!mutate(plains)) return false;

  await Promise.all(plains.map(savePlain));
  return true;
}

/**
 * Drop everything that has expired — finished hides, finished review quantity
 * caps, finished discounts and legacy unlimited windows.
 *
 * Only the documents that could be expired are loaded (indexed query), the
 * same tested pure rule decides what changes, and only then are they written.
 * That keeps a 1525-product catalog from being rewritten on every request.
 * @returns {Promise<number>} how many documents were updated
 */
export async function pruneCatalog(now = new Date()) {
  const nowIso = now.toISOString();
  const candidates = await Product.find({
    $or: [
      { hidden: true, hideUntil: { $ne: null, $lte: nowIso } },
      { stockUntil: { $ne: null, $lte: nowIso } },
      { discountUntil: { $ne: null, $lte: nowIso } },
      { unlimitedUntil: { $ne: null, $lte: nowIso } }
    ]
  }).lean();

  if (!candidates.length) return 0;

  const plains = mapDocs(candidates);
  if (!pruneExpired(plains, now.getTime())) return 0;

  await Promise.all(plains.map(savePlain));
  return plains.length;
}

/** Create a product (the caller validates the payload) */
export async function createProduct(product) {
  const normalized = normalizeQuantity({ ...product });
  await Product.create(normalized);
  return normalized;
}

/**
 * Apply an arbitrary update to one product by id.
 * @param {string} id
 * @param {(product: object) => boolean|void} mutate - mutates the plain object
 * @returns {Promise<object|null>} the updated product, or null when not found
 */
export async function updateProductById(id, mutate) {
  const doc = await Product.findOne({ id: String(id) }).lean();
  if (!doc) return null;

  const plain = withId(doc);
  mutate(plain);
  await savePlain(plain);
  return plain;
}

/** Soft delete / restore, used by the delete and restore endpoints */
export async function setProductDeleted(id, deleted) {
  return updateProductById(id, (product) => {
    if (deleted) product.deleted = true;
    else delete product.deleted;
  });
}

/** How many products exist — used to warn about an empty catalog at startup */
export async function catalogCount() {
  return Product.estimatedDocumentCount();
}
