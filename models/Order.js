import mongoose from 'mongoose';
import { encryptField, decryptField, encryptJSON, decryptJSON } from '../utils/crypto.js';

const orderSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Order items are stored as one encrypted blob: [ { productId, name, price, quantity } ]
  // Only the product ID stays plaintext so orders can still be joined with
  // the catalog; names and prices are inside the encrypted payload.
  encryptedItems: {
    type: String,
    default: ''
  },
  itemCount: {
    type: Number,
    default: 0
  },
  total: {
    type: Number,
    required: true
  },
  subtotal: { type: Number, default: 0 },
  delivery: { type: Number, default: 0 },
  paymentMethod: {
    type: String,
    enum: ['card', 'cash'],
    default: 'card'
  },
  // Customer details are encrypted at rest (ciphertext, safe to query/load)
  customerName: { type: String, default: '' },
  customerPhone: { type: String, default: '' },
  customerAddress: { type: String, default: '' },
  // Optional geolocation the customer shared (stored as one encrypted blob:
  // { lat, lng } or empty when not shared)
  customerLocation: { type: String, default: '' },
  status: {
    type: String,
    enum: ['preparing', 'on_the_way', 'delivered'],
    default: 'preparing'
  },
  // ─── Payment (Moyasar authorization & capture flow) ────────
  // Moyasar payment id (e.g. "79cced57-..." or "mock_pay_xxx" in mock mode)
  paymentId: {
    type: String,
    default: ''
  },
  // pending_authorization → authorized (funds held) → paid (owner accepted)
  // 'cash' is used for cash-on-delivery orders (no Moyasar involvement)
  // 'voided' means the hold was released after cancelling the order
  paymentStatus: {
    type: String,
    enum: ['pending_authorization', 'authorized', 'paid', 'cash', 'voided'],
    default: 'pending_authorization'
  },
  // Exact total computed SERVER-SIDE from products.json (never the frontend)
  totalAmount: {
    type: Number,
    default: 0
  },
  confirmed: {
    type: Boolean,
    default: false
  },
  // The customer kept «استلام الفواتير وتفاصيل الطلب عبر رقم الجوال» on, so
  // the order-summary (bill) SMS may be sent to them. Chosen at checkout and
  // stored here because the bill goes out later, when the order becomes real.
  // It governs THAT message only — the confirmation SMS and the alternatives
  // SMS are never suppressed by it.
  invoiceSms: {
    type: Boolean,
    default: true
  },
  // The owner's WhatsApp notification for this order was already sent.
  // Card orders only notify once the payment hold is authorized.
  ownerNotified: {
    type: Boolean,
    default: false
  },
  // The owner marked the order cancelled after the replacement review
  cancelled: {
    type: Boolean,
    default: false
  },
  // The owner's review of an incomplete order, encrypted at rest:
  // { orderId, replacements: [{ productId, name, state, ordered, available }],
  //   markedAt } — or '' when the owner has not reviewed anything yet.
  // Kept on the order even after it is cancelled so the state is inspectable.
  encryptedReplacements: {
    type: String,
    default: ''
  },
  orderTime: { type: Date, default: Date.now }
}, {
  timestamps: true
});

/**
 * Encrypt and store the order items.
 * @param {Array} items - [{ productId, name, price, quantity }]
 */
orderSchema.methods.setItems = function (items) {
  this.encryptedItems = encryptJSON(items);
  this.itemCount = items.reduce((sum, i) => sum + (i.quantity || 1), 0);
};

/**
 * Decrypt and return the order items.
 */
orderSchema.methods.getItems = function () {
  return decryptJSON(this.encryptedItems, []);
};

/**
 * Encrypt the customer details. Call before saving a new order.
 * @param {object} customer
 * @param {{ lat: number, lng: number }|null} [customer.location] - optional geolocation
 */
orderSchema.methods.setCustomer = function ({ name, phone, address, location }) {
  this.customerName = encryptField(name || '');
  this.customerPhone = encryptField(phone || '');
  this.customerAddress = encryptField(address || '');
  this.customerLocation = (location && Number.isFinite(location.lat) && Number.isFinite(location.lng))
    ? encryptJSON({ lat: location.lat, lng: location.lng })
    : '';
};

/**
 * Decrypt the customer details.
 */
orderSchema.methods.getCustomer = function () {
  return {
    name: decryptField(this.customerName) || '',
    phone: decryptField(this.customerPhone) || '',
    address: decryptField(this.customerAddress) || '',
    location: decryptJSON(this.customerLocation, null)
  };
};

/**
 * Encrypt and store the owner's replacement review for this order.
 * @param {{ orderId: string, replacements: Array, markedAt: string }} review
 */
orderSchema.methods.setReplacements = function (review) {
  this.encryptedReplacements = encryptJSON(review);
};

/**
 * Decrypt and return the owner's replacement review (or null).
 */
orderSchema.methods.getReplacements = function () {
  return decryptJSON(this.encryptedReplacements, null);
};

/**
 * Plain-object representation with everything decrypted — used by the
 * dashboard and the customer-order page.
 */
orderSchema.methods.toJSON = function () {
  const obj = this.toObject();
  const customer = this.getCustomer();

  obj.items = this.getItems();
  obj.customerName = customer.name;
  obj.customerPhone = customer.phone;
  obj.customerAddress = customer.address;
  obj.customerLocation = customer.location || null;
  obj.replacements = this.getReplacements();

  delete obj.encryptedItems;
  delete obj.encryptedReplacements;
  return obj;
};

const Order = mongoose.model('Order', orderSchema);

export default Order;
