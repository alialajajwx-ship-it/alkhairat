// Owner banner manager page
// The owner saves MULTIPLE banners (never overwriting existing ones) and
// picks which one is visible on the home page. Each saved banner shows a
// live preview, an activate button, and a delete button.

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('banner-form');
  const imageInput = document.getElementById('banner-image');
  const pickBtn = document.getElementById('btn-pick-image');
  const clearBtn = document.getElementById('btn-clear-image');
  const previewBox = document.getElementById('banner-preview');
  const errorEl = document.getElementById('banner-error');
  const saveBtn = document.getElementById('banner-save');
  const grid = document.getElementById('banners-grid');
  const emptyEl = document.getElementById('banners-empty');

  // ─── Image picker (add form) ────────────────────────────────

  pickBtn.addEventListener('click', () => imageInput.click());

  imageInput.addEventListener('change', () => {
    const file = imageInput.files && imageInput.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      errorEl.textContent = 'الملف المختار ليس صورة.';
      imageInput.value = '';
      return;
    }
    errorEl.textContent = '';
    // Live local preview
    previewBox.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="">`;
    clearBtn.style.display = 'inline-flex';
  });

  clearBtn.addEventListener('click', () => {
    imageInput.value = '';
    previewBox.innerHTML = '<span class="material-symbols-outlined">image</span>';
    clearBtn.style.display = 'none';
  });

  // ─── Add a new banner ───────────────────────────────────────

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    saveBtn.disabled = true;
    saveBtn.textContent = 'جاري الحفظ...';

    try {
      const body = new FormData();
      body.append('title', document.getElementById('banner-title').value);
      body.append('subtitle', document.getElementById('banner-subtitle').value);
      body.append('link', document.getElementById('banner-link').value);

      const file = imageInput.files && imageInput.files[0];
      if (file) body.append('image', file);

      const res = await fetch('/api/owner/banner', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        errorEl.textContent = data.error || 'حدث خطأ أثناء الحفظ. حاول مرة أخرى.';
        return;
      }

      // Reset the form for the next banner
      form.reset();
      previewBox.innerHTML = '<span class="material-symbols-outlined">image</span>';
      clearBtn.style.display = 'none';
      imageInput.value = '';

      await loadBanners();
      alert('تم حفظ البانر بنجاح.');
    } catch {
      errorEl.textContent = 'خطأ في الاتصال بالخادم. حاول مرة أخرى.';
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'حفظ البانر';
    }
  });

  // ─── Saved banners list ─────────────────────────────────────

  let bannersCache = { activeId: null, banners: [] };

  async function loadBanners() {
    try {
      const res = await fetch('/api/owner/banners');
      if (!res.ok) throw new Error('failed');
      bannersCache = await res.json();
    } catch {
      bannersCache = { activeId: null, banners: [] };
    }
    renderBanners();
  }

  function renderBanners() {
    grid.innerHTML = '';
    const { activeId, banners } = bannersCache;

    if (!banners.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    banners.forEach((banner) => {
      const isActive = banner.id === activeId;
      const isDefault = banner.isDefault === true || banner.id === 'banner-default';
      const card = document.createElement('div');
      card.className = 'banner-item' + (isActive ? ' active' : '');

      const preview = banner.imageUrl
        ? `<img src="${banner.imageUrl}" alt="">`
        : '<span class="material-symbols-outlined">image</span>';

      card.innerHTML = `
        <div class="banner-item-preview">${preview}</div>
        <div class="banner-item-info">
          <div class="banner-title-row">
            <strong>${banner.title || 'بدون عنوان'}</strong>
            ${isDefault ? '<span class="banner-default-tag">افتراضي</span>' : ''}
          </div>
          ${banner.subtitle ? `<span>${banner.subtitle}</span>` : ''}
        </div>
        <div class="banner-item-actions">
          ${isActive
            ? '<span class="banner-active-tag">ظاهر حالياً</span>'
            : `<button class="btn btn-outline btn-sm" data-activate="${banner.id}">تفعيل</button>`}
          ${isDefault
            ? '<button class="btn btn-sm btn-disabled" disabled title="لا يمكن حذف البانر الافتراضي">أساسي</button>'
            : `<button class="btn btn-danger btn-sm" data-delete="${banner.id}">حذف</button>`}
        </div>
      `;
      grid.appendChild(card);
    });
  }

  grid.addEventListener('click', async (e) => {
    const activateId = e.target.closest('[data-activate]');
    const deleteBtn = e.target.closest('[data-delete]');

    if (activateId) {
      try {
        const res = await fetch('/api/owner/banner/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: activateId.dataset.activate })
        });
        if (!res.ok) throw new Error('failed');
        await loadBanners();
      } catch {
        alert('تعذر تفعيل البانر. حاول مرة أخرى.');
      }
    }

    if (deleteBtn) {
      if (!confirm('هل أنت متأكد أنك تريد حذف هذا البانر؟')) return;
      try {
        const res = await fetch('/api/owner/banner/' + encodeURIComponent(deleteBtn.dataset.delete), {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error('failed');
        await loadBanners();
      } catch {
        alert('تعذر حذف البانر. حاول مرة أخرى.');
      }
    }
  });

  loadBanners();
});
