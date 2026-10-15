// Home page script
// Renders featured discounted products

import { getFeaturedProducts, createProductCard } from '../data/products.js';
import { isInCart, addToCartOnce, removeFromCart } from '../data/cart.js';

document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('home-products');
  if (!container) return;

  const products = await getFeaturedProducts();

  if (products.length === 0) {
    container.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0;">لا توجد عروض حالياً</p>';
    return;
  }

  products.forEach((product) => {
    const card = createProductCard(product, {
      showAddButton: true,
      isInCart: isInCart(product.id)
    });
    container.appendChild(card);
  });

  // Handle add/remove buttons
  container.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.add-btn');
    const removeBtn = e.target.closest('.remove-btn');

    if (addBtn) {
      const productId = addBtn.dataset.productId;
      const added = addToCartOnce(productId);
      if (added) {
        const card = addBtn.closest('.product-card');
        // Show the "تمت اضافة المنتج الى السلة" overlay on the image for 3.2s
        const message = card.querySelector('.cart-message');
        if (message) {
          message.style.display = 'flex';
          clearTimeout(card.__msgTimer);
          card.__msgTimer = setTimeout(() => {
            message.style.display = 'none';
          }, 3200);
        }
        // Persistent "مضاف إلى السلة" tag in the card's bottom band
        card.classList.add('in-cart');

        // Replace button with remove
        addBtn.outerHTML = `
          <button class="remove-btn" data-product-id="${productId}" title="ازالة من السلة">
            <span class="material-symbols-outlined">remove</span>
          </button>
        `;

        // Update header cart badge
        window.dispatchEvent(new Event('cart-updated'));
      }
    }

    if (removeBtn) {
      const productId = removeBtn.dataset.productId;
      removeFromCart(productId);
      const card = removeBtn.closest('.product-card');
      if (card) card.classList.remove('in-cart');
      // Replace button with add
      removeBtn.outerHTML = `
        <button class="add-btn" data-product-id="${productId}" title="اضافة الى السلة">
          <span class="material-symbols-outlined">add</span>
        </button>
      `;

      // Update header cart badge
      window.dispatchEvent(new Event('cart-updated'));
    }
  });
});
