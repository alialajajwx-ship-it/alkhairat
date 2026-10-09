import mongoose from 'mongoose';

// The customer/owner product catalog.
//
// It used to live in data/products.json and is now a real collection so the
// store can hold thousands of products without shipping the whole catalog to
// every browser and without rewriting a file on every owner edit.
//
// Field names are kept EXACTLY as the JSON file had them, so the existing
// order-review rules (utils/order-review.js), the owner pages and any
// data already exported from products.json keep working unchanged.
//
// Every date-ish field is an ISO-8601 string on purpose: string comparison in
// MongoDB is chronological for ISO-8601, so `{ hideUntil: { $lte: now } }`
// works with a plain index and no date casting on reads.

// The shop's categories, in the order the browse sidebar shows them. They are
// the real Arabic names the owner's catalog uses (the original English six were
// placeholder data). `type` below is NOT restricted to this list on purpose:
// a manual import or a future category must never be rejected by the schema.
// The UI and the owner create/update endpoints use this list as their options.
const CATEGORY_TYPES = [
  'ألبان وحليب',
  'شاي وقهوة',
  'عصائر ومشروبات',
  'مشروبات غازية',
  'تسالي وشبسات',
  'مخبوزات',
  'شوكولاتة وحلويات',
  'كيك وحلويات',
  'لحوم ومجمدات',
  'حبوب إفطار',
  'قشطة وكريمة',
  'حلويات مبردة',
  'مواد غذائية وطبخ',
  'مثلجات وآيس كريم',
  'أجبان ومشتقاتها',
  'منتجات تموينية',
  'بسكويت وويفر',
  'مشروبات طاقة',
  'مياه',
  'منظفات وعناية منزلية',
  'حلويات وعلكة',
  'عناية شخصية',
  'عناية بالطفل',
  'مستلزمات بلاستيكية ومناديل'
];

const productSchema = new mongoose.Schema(
  {
    // Stable, human-readable id used by carts, orders and links (products.json
    // used the same field). Kept separate from _id so nothing had to change.
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    priceCents: { type: Number, required: true, min: 0 },
    keyWords: { type: [String], default: [] },
    type: { type: String, required: true, trim: true },
    imageUrl: { type: String, default: '' },

    // Pack size shown on the card, kept exactly as the import provides it
    // (e.g. { number: 1.85, unit: 'لتر' }). Optional.
    weight: { type: new mongoose.Schema({ number: Number, unit: String }, { _id: false }) },

    // Discount — percent plus an optional deadline (no deadline = forever)
    discountPercent: { type: Number },
    discountSetAt: { type: String },
    discountUntil: { type: String },

    // Stock: `unlimitedQuantity` wins; otherwise `stockQuantity` is what
    // customers may still order and `ownerStock` is the owner's own count
    // (never reduced by orders). `stockUntil` expires a review-imposed cap.
    unlimitedQuantity: { type: Boolean },
    stockQuantity: { type: Number },
    ownerStock: { type: Number },
    stockUntil: { type: String },

    // Legacy unlimited window (kept for old documents)
    unlimitedUntil: { type: String },

    // Visibility: `hidden` + optional `hideUntil` + a reason so the system can
    // tell its own hides ('soldout' / 'unavailable') from a manual one.
    hidden: { type: Boolean },
    hideUntil: { type: String },
    hideReason: { type: String },

    // Soft delete — moves the product to the deleted-items page
    deleted: { type: Boolean }
  },
  {
    collection: 'products',
    // Manual imports do not have to supply these; they are only for ordering
    timestamps: true,
    minimize: false
  }
);

// The default browse listing and the owner catalog both sort by _id to keep a
// stable insertion order, so the customer sees the same order on every page.
// These indexes keep the customer filters and the expiry sweep cheap at scale.
productSchema.index({ type: 1, _id: 1 });
productSchema.index({ priceCents: 1 });
productSchema.index({ hidden: 1, hideUntil: 1 });
productSchema.index({ stockUntil: 1 });
productSchema.index({ discountUntil: 1 });
productSchema.index({ unlimitedUntil: 1 });
productSchema.index({ deleted: 1, type: 1 });

const Product = mongoose.model('Product', productSchema);

export { CATEGORY_TYPES };
export default Product;
