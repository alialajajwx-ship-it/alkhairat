import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { encryptField, decryptField, hashPhone } from '../utils/crypto.js';

const otpSchema = new mongoose.Schema({
  // Encrypted phone (same scheme as the User model)
  phone: {
    type: String,
    required: true
  },
  // Deterministic hash for lookups — same input always gives the same hash
  phoneHash: {
    type: String,
    required: true,
    index: true
  },
  // What this code is for: 'register' (signup) or 'reset' (forgot password).
  // A code can only be used for the purpose it was issued for.
  purpose: {
    type: String,
    enum: ['register', 'reset'],
    required: true
  },
  code: {
    type: String,
    required: true
  },
  attempts: {
    type: Number,
    default: 0,
    max: 5
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 } // TTL index: auto-delete after expiration
  }
}, {
  timestamps: true
});

// Note: the OTP code is hashed in the route before saving
// (Mongoose 9 async pre-save hooks no longer receive a `next` callback)

// Compare entered OTP with hashed code
otpSchema.methods.compareCode = async function (candidateCode) {
  return bcrypt.compare(candidateCode, this.code);
};

/**
 * Fill in the encrypted phone + hash from a raw number. Call before saving.
 */
otpSchema.methods.setPhone = function (rawPhone) {
  this.phone = encryptField(rawPhone);
  this.phoneHash = hashPhone(rawPhone);
};

/**
 * Plaintext phone number (decrypted on demand, e.g. to resend the SMS).
 */
otpSchema.methods.getPhone = function () {
  return decryptField(this.phone) || '';
};

const OTP = mongoose.model('OTP', otpSchema);

export default OTP;
