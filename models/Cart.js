import mongoose from 'mongoose';
import { encryptJSON, decryptJSON } from '../utils/crypto.js';

const cartSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true // one cart per user
    },
    // Cart items are stored as one encrypted blob: [ { productId, quantity } ]
    encryptedItems: {
      type: String,
      default: ''
    },
    itemCount: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

/**
 * Encrypt and store the cart items.
 * @param {Array} items - [{ productId, quantity }]
 */
cartSchema.methods.setItems = function (items) {
  this.encryptedItems = encryptJSON(items);
  this.itemCount = items.reduce((sum, i) => sum + (i.quantity || 1), 0);
};

/**
 * Decrypt and return the cart items.
 */
cartSchema.methods.getItems = function () {
  return decryptJSON(this.encryptedItems, []);
};

const Cart = mongoose.model('Cart', cartSchema);

export default Cart;
