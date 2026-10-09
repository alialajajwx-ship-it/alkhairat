// Owner product management data module
// Wraps the owner-only product management API (alternatives + deleted pages)

import { normalizeProductName } from './products.js';

/**
 * Load owner products (with stock status flags).
 *
 * @param {boolean} includeDeleted - include soft-deleted products
 * @param {string[]|null} ids - when given, ONLY those products are returned
 *   (hidden and deleted included) instead of the whole catalog. The catalog
 *   can hold thousands of products, so pages that resolve a handful of ids
 *   must never download all of it.
 */
export async function fetchOwnerProducts(includeDeleted = false, ids = null) {
  const wanted = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : null;
  if (wanted && wanted.length === 0) return [];

  try {
    const params = new URLSearchParams({
      includeDeleted: includeDeleted ? 'true' : 'false'
    });
    if (wanted) params.set('ids', wanted.join(','));

    const res = await fetch(`/api/owner/products?${params.toString()}`);
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    return (data.products || []).map((product) => ({
      ...product,
      name: normalizeProductName(product.name)
    }));
  } catch (err) {
    console.error('Failed to load owner products:', err);
    return [];
  }
}

/**
 * Update quantity settings for a product.
 * @param {string} productId
 * @param {{ mode: 'limited'|'unlimited', value?: number }} quantity
 */
export function updateProductQuantity(productId, quantity) {
  return putProduct(productId, { quantity });
}

/**
 * Hide a product from customers.
 * @param {string} productId
 * @param {number|null} hours - hide duration; null = hidden until manually shown
 */
export function hideProduct(productId, hours = null) {
  return putProduct(productId, { hide: { hidden: true, hours } });
}

/**
 * Make a hidden product visible to customers again.
 */
export function unhideProduct(productId) {
  return putProduct(productId, { hide: { hidden: false } });
}

/**
 * Update a product's price.
 * @param {string} productId
 * @param {number} price - price in SAR (e.g. 12.5)
 */
export function updateProductPrice(productId, price) {
  return putProduct(productId, { priceCents: Math.round(Number(price) * 100) });
}

/**
 * Set or remove a discount on a product.
 * @param {string} productId
 * @param {{ percent: number, hours?: number|null }}|null discount - null removes the discount
 */
export function updateProductDiscount(productId, discount) {
  return putProduct(productId, { discount });
}

/**
 * Mark a product's availability inside a replacement review for an order.
 * The server parks the review in replacements.json until the owner sends
 * the alternatives SMS (or cancels).
 * @param {string} orderId
 * @param {Array} replacements - [{ productId, name, state, ordered, available }]
 *   state: 'available' | 'low' | 'unavailable'
 */
export function updateProductReplacement(orderId, replacements) {
  return fetch('/api/admin/orders/' + encodeURIComponent(orderId) + '/replacements', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replacements })
  })
    .then(async (res) => {
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'failed');
      }
      return { ok: true };
    })
    .catch((err) => ({ ok: false, error: err.message }));
}

/**
 * Soft-delete a product — moves it to the deleted items page.
 */
export function deleteProduct(productId) {
  return putProduct(productId, { deleted: true });
}

/**
 * Restore a soft-deleted product back to the catalog.
 */
export function restoreProduct(productId) {
  return putProduct(productId, { deleted: false });
}

async function putProduct(productId, body) {
  try {
    const res = await fetch(`/api/owner/products/${productId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'failed');
    }
    const data = await res.json();
    return { ok: true, product: data.product };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
