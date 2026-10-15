// Owner delivery-price editor page
// Reads the current fee from /api/settings and saves changes to
// /api/owner/delivery-price

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('delivery-form');
  const feeInput = document.getElementById('delivery-fee');
  const errorEl = document.getElementById('delivery-error');
  const saveBtn = document.getElementById('delivery-save');

  // Load the live value from the server so the field is never stale
  try {
    const res = await fetch('/api/settings');
    if (res.ok) {
      const data = await res.json();
      if (Number.isFinite(data.deliveryFee)) feeInput.value = data.deliveryFee;
    }
  } catch {
    // keep the server-rendered value
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    saveBtn.disabled = true;
    saveBtn.textContent = 'جاري الحفظ...';

    try {
      const res = await fetch('/api/owner/delivery-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deliveryFee: parseFloat(feeInput.value) })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        errorEl.textContent = data.error || 'حدث خطأ أثناء الحفظ. حاول مرة أخرى.';
        return;
      }

      feeInput.value = data.deliveryFee;
      alert('تم حفظ سعر التوصيل بنجاح.');
    } catch {
      errorEl.textContent = 'خطأ في الاتصال بالخادم. حاول مرة أخرى.';
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'حفظ السعر';
    }
  });
});
