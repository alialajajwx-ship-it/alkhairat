// Deleted products page script (owner)
// Lists soft-deleted products and lets the owner restore them.

import { fetchOwnerProducts, restoreProduct } from '../data/owner-products.js';

let deletedProducts = [];
let currentSearch = '';
let restoringId = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await reload();
  setupSearch();
  setupRestoreModal();
}

async function reload() {
  deletedProducts = await fetchOwnerProducts(true);
  deletedProducts = deletedProducts.filter((p) => p.deleted === true);
  renderProducts();
}

// ─── Rendering ───────────────────────────────────────────────

function renderProducts() {
  const container = document.getElementById('products-grid');
  const noResults = document.getElementById('no-results');
  const resultsCount = document.getElementById('results-count');

  const products = currentSearch
    ? deletedProducts.filter((p) => {
        const term = currentSearch.toLowerCase();
        return (
          p.name.toLowerCase().includes(term) ||
          (p.keyWords || []).some((k) => k.toLowerCase().includes(term))
        );
      })
    : deletedProducts;

  container.innerHTML = '';

  if (products.length === 0) {
    noResults.style.display = 'block';
    resultsCount.textContent = 'عرض 0 منتج';
    return;
  }

  noResults.style.display = 'none';
  resultsCount.textContent = `عرض ${products.length} منتج`;

  products.forEach((product) => {
    const card = document.createElement('article');
    card.className = 'product-card deleted';
    card.dataset.productId = product.id;

    const thumb = product.imageUrl
      ? `<img src="${product.imageUrl}" alt="${product.name}" loading="lazy">`
      : `<span class="placeholder-icon material-symbols-outlined">inventory_2</span>`;

    card.innerHTML = `
      <div class="product-thumb">
        ${thumb}
      </div>
      <div class="product-info">
        <h3>${product.name}</h3>
        <div class="stock-row"><span class="stock-badge deleted">محذوف</span></div>
        <button class="restore-btn" data-product-id="${product.id}">
          <span class="material-symbols-outlined">restore</span> استرجاع
        </button>
      </div>
    `;
    container.appendChild(card);
  });
}

// ─── Search ──────────────────────────────────────────────────

function setupSearch() {
  const searchInput = document.getElementById('search-input');
  let timeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      currentSearch = e.target.value.trim();
      renderProducts();
    }, 300);
  });
}

// ─── Restore modal ───────────────────────────────────────────

function setupRestoreModal() {
  const modal = document.getElementById('restore-modal');

  document.getElementById('products-grid').addEventListener('click', (e) => {
    const restoreBtn = e.target.closest('.restore-btn');
    if (!restoreBtn) return;

    const product = deletedProducts.find((p) => p.id === restoreBtn.dataset.productId);
    if (!product) return;
    restoringId = product.id;

    document.getElementById('restore-product-name').textContent =
      'هل تريد استرجاع "' + product.name + '"؟';
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  });

  function closeModal() {
    modal.classList.remove('active');
    document.body.style.overflow = '';
    restoringId = null;
  }

  document.getElementById('restore-cancel-btn').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  document.getElementById('restore-confirm-btn').addEventListener('click', async () => {
    if (!restoringId) return;

    const confirmBtn = document.getElementById('restore-confirm-btn');
    confirmBtn.disabled = true;

    const result = await restoreProduct(restoringId);

    confirmBtn.disabled = false;
    closeModal();

    if (!result.ok) {
      alert('حدث خطأ أثناء الاسترجاع. حاول مرة أخرى.');
      return;
    }
    await reload();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) closeModal();
  });
}
