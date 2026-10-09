// One-time (and repeatable) migration: a products.json file → MongoDB `products`.
//
// Safe by default: it only INSERTS products whose id is not in the collection
// yet. Nothing already in MongoDB is ever touched unless you pass --force.
//
// Run it with the project's env so MONGO_URI is available:
//   npm run seed:products                       # insert the missing products
//   npm run seed:products -- --force            # overwrite every product from the file
//   npm run seed:products -- --dry              # show what would happen, write nothing
//   npm run seed:products -- --file <path>      # import a specific products.json
//   npm run seed:products -- <path>             # same, as a plain argument
//   npm run seed:products -- --replace          # WIPE the collection, then import
//
// --replace is destructive: it deletes EVERY product already in MongoDB, then
// writes the file. Before deleting it dumps the current collection to a
// timestamped <file>.backup-<stamp>.json so a bad run can be undone.
//
// The default file is the repo seed, data/products.json. A relative <path> is
// resolved against the CURRENT working directory (the repo root).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

import { connectDB } from '../config/db.js';
import Product from '../models/Product.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_FILE = path.join(__dirname, '..', 'data', 'products.json');

const force = process.argv.includes('--force');
const dry = process.argv.includes('--dry');
const replace = process.argv.includes('--replace');

// Which file to import: --file <path>, else the first non-flag argument, else
// the repo seed. Relative paths are resolved from the current directory.
function resolveCatalogFile(argv) {
  const flagAt = argv.indexOf('--file');
  let chosen = flagAt > -1 ? argv[flagAt + 1] : argv.find((a, i) => i > 1 && !a.startsWith('--'));
  if (!chosen) return DEFAULT_CATALOG_FILE;
  return path.resolve(process.cwd(), chosen);
}

const CATALOG_FILE = resolveCatalogFile(process.argv);
const CATALOG_LABEL = path.relative(process.cwd(), CATALOG_FILE) || CATALOG_FILE;

function readFile() {
  const raw = fs.readFileSync(CATALOG_FILE, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('products.json must contain an array');
  return parsed;
}

/** A product must have a stable id before it can be referenced by carts/orders */
function withId(product, index) {
  if (product && product.id) return product;
  return { ...product, id: crypto.randomBytes(4).toString('hex'), _generatedId: index };
}

/** Dump the current collection to a timestamped backup next to the source file. */
function backupCurrent(products) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${CATALOG_FILE}.backup-${stamp}.json`;
  fs.writeFileSync(backupPath, JSON.stringify(products, null, 2), 'utf-8');
  return path.relative(process.cwd(), backupPath);
}

async function main() {
  const fromFile = readFile().map(withId);

  await connectDB();
  if (mongoose.connection.readyState !== 1) {
    console.error('\nNo MongoDB connection — set MONGO_URI in .env and try again.');
    process.exit(1);
  }

  const existingIds = new Set(
    (await Product.find({ id: { $in: fromFile.map((p) => p.id) } }).select('id').lean())
      .map((p) => p.id)
  );

  const toInsert = fromFile.filter((p) => force || replace || !existingIds.has(p.id));
  const skipped = fromFile.length - toInsert.length;

  console.log(`\n${CATALOG_LABEL} holds ${fromFile.length} product(s).`);
  console.log(`Already in MongoDB : ${existingIds.size}`);
  console.log(`Will write         : ${toInsert.length}`);
  console.log(`Left untouched     : ${skipped}`);

  if (toInsert.length && fromFile.some((p) => p._generatedId !== undefined)) {
    console.warn('\n⚠  Some products had no "id" — a random one was generated. Their carts/links will differ from products.json.');
  }

  if (replace) {
    const existingCount = await Product.estimatedDocumentCount();
    console.log(`\n--replace: the whole "products" collection (${existingCount} doc(s)) will be deleted first.`);
  }

  if (dry) {
    console.log('\n--dry: nothing was written.');
    await mongoose.disconnect();
    return;
  }

  if (replace) {
    const current = await Product.find({}).lean();
    const backupFile = backupCurrent(current);
    console.log(`Backed up ${current.length} existing product(s) to ${backupFile}`);
    const del = await Product.deleteMany({});
    console.log(`Deleted ${del.deletedCount ?? current.length} product(s) from "products".`);
  }

  // Batched replaceOne operations (not $set) so --force really overwrites: a
  // field the file no longer sets must not survive from an older document.
  // Batched because 1500+ single round-trips to a remote MongoDB is slow.
  const BATCH_SIZE = 500;
  let written = 0;
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const chunk = toInsert.slice(i, i + BATCH_SIZE).map((product) => {
      const { _generatedId, ...clean } = product;
      return { replaceOne: { filter: { id: clean.id }, replacement: clean, upsert: true } };
    });
    const result = await Product.bulkWrite(chunk, { ordered: false });
    written += (result.upsertedCount || 0) + (result.matchedCount || 0);
    console.log(`  … ${Math.min(i + BATCH_SIZE, toInsert.length)}/${toInsert.length}`);
  }

  console.log(`\n✓ Wrote ${written} product(s) into the "products" collection.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Seed failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
