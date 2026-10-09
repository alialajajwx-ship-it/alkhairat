// Delete user accounts and the data that belongs to them from MongoDB.
//
//   node --env-file=.env scripts/reset-users.mjs                 → DRY RUN (counts only)
//   node --env-file=.env scripts/reset-users.mjs --yes           → deletes everything
//   ... --yes --keep-owner                                       → keeps role:'owner' accounts
//   ... --yes --backup data/users-backup.json                     → export before deleting
//
// Scope: the MongoDB collections only — users, orders, carts, otps.
// The catalog (data/products.json), the parked reviews (data/replacements.json)
// and the store settings (data/settings.json) are FILES, not database rows, and
// are never touched by this script.
//
// --backup writes the documents out AS THEY ARE STORED (customer names,
// phones and addresses are AES-256-GCM ciphertext). It is still personal data:
// keep the file safe and remove it when you no longer need it. Restoring it
// later also needs the same ENCRYPTION_KEY.

import fs from 'fs';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import User from '../models/User.js';
import Order from '../models/Order.js';
import Cart from '../models/Cart.js';
import OTP from '../models/OTP.js';

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const backupIndex = argv.indexOf('--backup');
const backupFile = backupIndex > -1 ? argv[backupIndex + 1] : null;

const willDelete = hasFlag('--yes');
const keepOwner = hasFlag('--keep-owner');

await connectDB();

if (mongoose.connection.readyState !== 1) {
  console.error('\nCould not reach MongoDB (MONGO_URI missing or unreachable).');
  console.error('Nothing was deleted.');
  process.exit(1);
}

// Everything, or everyone except the store owner
const userFilter = keepOwner ? { role: { $ne: 'owner' } } : {};

const users = await User.find(userFilter).select('_id role').lean();
const userIds = users.map((u) => u._id);

// Without --keep-owner this is a full user-data reset: every order and cart is
// removed, including rows whose user account no longer exists (orphans).
const orderFilter = keepOwner ? { userId: { $in: userIds } } : {};
const cartFilter = keepOwner ? { userId: { $in: userIds } } : {};

const counts = {
  users: users.length,
  orders: await Order.countDocuments(orderFilter),
  carts: await Cart.countDocuments(cartFilter),
  otps: await OTP.countDocuments({})
};

console.log('\n──────────────────────────────────────────────');
console.log(keepOwner ? 'Target: every user EXCEPT the owner' : 'Target: every user account');
console.log('──────────────────────────────────────────────');
console.log(`  users : ${counts.users}`);
console.log(`  orders: ${counts.orders}`);
console.log(`  carts : ${counts.carts}`);
console.log(`  otps  : ${counts.otps}  (pending signup / password-reset codes)`);
console.log('──────────────────────────────────────────────');

if (!willDelete) {
  console.log('\nDRY RUN — nothing was deleted.');
  console.log('Re-run the same command with --yes to actually delete.\n');
  await mongoose.disconnect();
  process.exit(0);
}

if (backupFile) {
  const backup = {
    exportedAt: new Date().toISOString(),
    keepOwner,
    users: await User.find(userFilter).lean(),
    orders: await Order.find(orderFilter).lean(),
    carts: await Cart.find(cartFilter).lean()
  };
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), 'utf-8');
  console.log(`\nBackup written to ${backupFile} (encrypted fields stay encrypted).`);
}

// Pending OTP codes are short-lived and belong to nobody in particular —
// everyone can simply request a new code, so they always go.
const deleted = {
  users: (await User.deleteMany(userFilter)).deletedCount,
  orders: (await Order.deleteMany(orderFilter)).deletedCount,
  carts: (await Cart.deleteMany(cartFilter)).deletedCount,
  otps: (await OTP.deleteMany({})).deletedCount
};

console.log('\nDeleted:');
console.log(`  users : ${deleted.users}`);
console.log(`  orders: ${deleted.orders}`);
console.log(`  carts : ${deleted.carts}`);
console.log(`  otps  : ${deleted.otps}`);
console.log('\nDone. The catalog and the store settings were not touched.\n');

await mongoose.disconnect();
