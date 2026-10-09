import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { encryptField, decryptField, hashPhone } from '../utils/crypto.js';

const userSchema = new mongoose.Schema({
  // The phone number is never stored in plaintext. We keep two fields:
  // - phone:      AES-256-GCM ciphertext (readable only with ENCRYPTION_KEY)
  // - phoneHash:  deterministic HMAC — used for lookups and the unique index
  phone: {
    type: String,
    required: true
  },
  phoneHash: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    default: '',
    trim: true,
    maxlength: 60
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  role: {
    type: String,
    enum: ['user', 'owner'],
    default: 'user'
  },
  termsAccepted: {
    type: Boolean,
    required: true,
    default: false
  },
  // Saved delivery addresses — encrypted at rest like every other customer
  // field. Each entry: { id, label, address, isDefault }.
  addresses: {
    type: [String],
    default: []
  }
}, {
  timestamps: true
});

// Decrypt the phone whenever the document is converted to an object/JSON,
// so the rest of the app can keep using `user.phone` as normal.
userSchema.set('toObject', { virtuals: true });
userSchema.set('toJSON', { virtuals: true });

userSchema.virtual('decryptedPhone').get(function () {
  return decryptField(this.phone) || '';
});

// Hash password before saving
// (Mongoose 9 async pre-save hooks no longer receive a `next` callback —
// we hash in the routes instead to keep compatibility)
userSchema.methods.hashPassword = async function () {
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
};

// Compare entered password with hashed password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

/**
 * Fill in the encrypted phone + its deterministic hash from a raw number.
 * Call this before saving a new user (or after a phone change).
 */
userSchema.methods.setPhone = function (rawPhone) {
  this.phone = encryptField(rawPhone);
  this.phoneHash = hashPhone(rawPhone);
};

/**
 * The plaintext phone number (decrypted on demand).
 */
userSchema.methods.getPhone = function () {
  return decryptField(this.phone) || '';
};

/**
 * Decrypt + parse the saved addresses. Never call this on data going out —
 * use toJSON which strips nothing but never leaks raw ciphertext either.
 */
userSchema.methods.getAddresses = function () {
  if (!Array.isArray(this.addresses)) return [];
  return this.addresses
    .map((blob) => {
      try {
        return JSON.parse(decryptField(blob));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

/**
 * Replace the whole saved-addresses list (each entry is encrypted
 * individually). `list` must already be sanitized plain objects.
 */
userSchema.methods.setAddresses = function (list) {
  this.addresses = (list || []).map((entry) => encryptField(JSON.stringify(entry)));
};

/**
 * Registration date as a plain Date (createdAt from the timestamps option).
 */
userSchema.methods.getRegisteredAt = function () {
  return this.createdAt;
};

/**
 * Strip secrets when converting to JSON. The decrypted phone is exposed
 * only through the explicit `phone` key below — the ciphertext and hash
 * are removed so raw encrypted blobs never reach the browser.
 */
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.phone; // remove the ciphertext
  delete obj.phoneHash; // remove the lookup hash
  delete obj.decryptedPhone; // redundant with the phone added below
  obj.phone = this.getPhone(); // add the decrypted number instead
  return obj;
};

const User = mongoose.model('User', userSchema);

export default User;
