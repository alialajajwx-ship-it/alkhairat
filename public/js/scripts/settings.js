// Settings page script — account data, saved addresses, notifications.
// All data comes from the server (/api/me/*); nothing is stored locally.
// The same script serves the owner variant (/owner-settings) which only
// adds two extra links in the account tab.

const state = {
  user: null,
  addresses: [],
  editingId: null // address currently being edited (null = add mode)
};

// ─── Init ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupTabs();
  setupAddressModal();
  setupLogout();
  setupPasswordChange();
  await loadAccount();
  await loadAddresses();
  loadNotificationSetting();
  setupNotificationToggle();
  setupMaintenanceToggle(); // owner page only — no-op elsewhere
}

// ─── Tabs ────────────────────────────────────────────────────

function setupTabs() {
  const links = document.querySelectorAll('.tab-link');
  const backBtn = document.getElementById('mobile-back-btn');

  links.forEach((link) => {
    link.addEventListener('click', () => openTab(link.dataset.tab, link));
  });

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      document.getElementById('mobile-sidebar').classList.remove('hidden-on-mobile');
      document.getElementById('mobile-content').classList.remove('active-on-mobile');
    });
  }
}

function openTab(tabId, linkEl) {
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
  document.querySelectorAll('.tab-link').forEach((l) => l.classList.remove('active'));

  document.getElementById(tabId).classList.add('active');
  linkEl.classList.add('active');

  // Mobile: show the content panel instead of the menu
  if (window.innerWidth <= 800) {
    document.getElementById('mobile-sidebar').classList.add('hidden-on-mobile');
    document.getElementById('mobile-content').classList.add('active-on-mobile');
  }
}

// ─── Account Tab ─────────────────────────────────────────────

async function loadAccount() {
  // Skeleton placeholders while the account data loads
  const dateSkeleton = document.getElementById('stat-registered-at');
  const ordersSkeleton = document.getElementById('stat-orders-count');
  if (dateSkeleton) dateSkeleton.innerHTML = '<span class="skel skel-inline"></span>';
  if (ordersSkeleton) ordersSkeleton.innerHTML = '<span class="skel skel-inline"></span>';

  try {
    const res = await fetch('/api/me/summary');
    if (!res.ok) throw new Error('unauthorized');
    const data = await res.json();
    state.user = data.user;

    // Registration date in Arabic using the browser's own locale data
    const dateEl = document.getElementById('stat-registered-at');
    dateEl.textContent = new Intl.DateTimeFormat('ar', {
      day: 'numeric', month: 'long', year: 'numeric'
    }).format(new Date(state.user.registeredAt));

    document.getElementById('stat-orders-count').textContent =
      state.user.ordersCount + ' طلب';

    document.getElementById('input-name').value = state.user.name || '';
    document.getElementById('input-phone').value = state.user.phone || '';
  } catch {
    // Not logged in — the page route already redirects, but stay safe
    window.location.href = '/login?redirect=/settings';
  }

  // Save button
  const saveBtn = document.getElementById('btn-save-profile');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveProfile);
  }
}

async function saveProfile() {
  const name = document.getElementById('input-name').value.trim();
  const btn = document.getElementById('btn-save-profile');

  if (name.length < 2) {
    alert('الاسم يجب أن يكون حرفين على الأقل');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'جاري الحفظ...';

  try {
    const res = await fetch('/api/me/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'save failed');
    alert('تم حفظ التغييرات بنجاح');
  } catch (err) {
    alert(err.message || 'حدث خطأ أثناء حفظ البيانات.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'حفظ التغييرات';
  }
}

// ─── Password Change ─────────────────────────────────────

function setupPasswordChange() {
  const btn = document.getElementById('btn-change-password');
  if (!btn) return; // safety: page without the section

  // Eye toggles — show/hide what's being typed (shared class with the
  // login page inputs)
  document.querySelectorAll('.password-eye').forEach((eye) => {
    eye.addEventListener('click', () => {
      const input = document.getElementById(eye.dataset.target);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.querySelector('.material-symbols-outlined').textContent = show ? 'visibility_off' : 'visibility';
    });
  });

  // Forgot password — send them to the dedicated reset flow on the
  // login page and bring them back here afterwards
  const forgotLink = document.getElementById('forgot-from-settings');
  if (forgotLink) {
    forgotLink.addEventListener('click', () => {
      window.location.href = '/login?mode=forgot&redirect=/settings';
    });
  }

  btn.addEventListener('click', changePassword);
}

async function changePassword() {
  const current = document.getElementById('input-current-password').value;
  const next = document.getElementById('input-new-password').value;
  const btn = document.getElementById('btn-change-password');

  if (!current) return alert('أدخل كلمة المرور الحالية');
  if (next.length < 6) return alert('كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل');

  btn.disabled = true;
  btn.textContent = 'جاري التغيير...';

  try {
    const res = await fetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: next })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'فشل تغيير كلمة المرور');

    alert('تم تغيير كلمة المرور بنجاح!');
    document.getElementById('input-current-password').value = '';
    document.getElementById('input-new-password').value = '';
  } catch (err) {
    alert(err.message || 'حدث خطأ أثناء تغيير كلمة المرور.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'تغيير كلمة المرور';
  }
}

// ─── Addresses Tab ───────────────────────────────────────────

async function loadAddresses() {
  const grid = document.getElementById('addresses-grid');
  const empty = document.getElementById('addresses-empty');

  try {
    const res = await fetch('/api/me/addresses');
    if (!res.ok) throw new Error('unauthorized');
    const data = await res.json();
    state.addresses = data.addresses || [];
  } catch {
    state.addresses = [];
  }

  renderAddresses(grid, empty);
}

function renderAddresses(grid, empty) {
  grid.innerHTML = '';

  if (state.addresses.length === 0) {
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  for (const addr of state.addresses) {
    const card = document.createElement('div');
    card.className = 'address-card' + (addr.isDefault ? ' default-address' : '');

    const badge = addr.isDefault ? '<div class="address-badge">الافتراضي</div>' : '';
    const defaultBtn = addr.isDefault
      ? ''
      : '<button class="text-btn default-btn" data-action="default" data-id="' + addr.id + '">تعيين كافتراضي</button>';

    card.innerHTML =
      badge +
      '<div class="address-header">' +
        '<span class="material-symbols-outlined">home</span>' +
        '<h4></h4>' +
      '</div>' +
      '<p class="address-text"></p>' +
      '<div class="address-actions">' +
        '<button class="text-btn edit-btn" data-action="edit" data-id="' + addr.id + '">تعديل</button>' +
        '<button class="text-btn delete-btn" data-action="delete" data-id="' + addr.id + '">حذف</button>' +
        defaultBtn +
      '</div>';

    // Set text via textContent so user data is never parsed as HTML
    card.querySelector('h4').textContent = addr.label;
    card.querySelector('.address-text').textContent = addr.address;

    grid.appendChild(card);
  }

  grid.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleAddressAction(btn.dataset.action, btn.dataset.id));
  });
}

async function handleAddressAction(action, id) {
  if (action === 'edit') {
    const addr = state.addresses.find((a) => a.id === id);
    if (!addr) return;
    openAddressModal(addr);
    return;
  }

  if (action === 'delete') {
    if (!confirm('هل تريد حذف هذا العنوان؟')) return;
    try {
      const res = await fetch('/api/me/addresses/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!res.ok) throw new Error();
      await loadAddresses();
    } catch {
      alert('حدث خطأ أثناء حذف العنوان.');
    }
    return;
  }

  if (action === 'default') {
    try {
      const res = await fetch('/api/me/addresses/' + encodeURIComponent(id) + '/default', { method: 'POST' });
      if (!res.ok) throw new Error();
      await loadAddresses();
    } catch {
      alert('حدث خطأ أثناء تعيين العنوان الافتراضي.');
    }
  }
}

// ─── Address Modal ───────────────────────────────────────────

function setupAddressModal() {
  const overlay = document.getElementById('address-modal-overlay');
  document.getElementById('btn-add-address').addEventListener('click', () => openAddressModal(null));
  document.getElementById('address-modal-close').addEventListener('click', closeAddressModal);
  document.getElementById('address-modal-cancel').addEventListener('click', closeAddressModal);
  document.getElementById('address-modal-save').addEventListener('click', saveAddress);

  // Optional geolocation helper inside the modal
  const enableBtn = document.getElementById('btn-enable-location-modal');
  if (enableBtn) enableBtn.addEventListener('click', captureModalLocation);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAddressModal();
  });
}

function openAddressModal(addr) {
  state.editingId = addr ? addr.id : null;
  state.modalLocation = null;
  document.getElementById('address-modal-title').textContent = addr ? 'تعديل العنوان' : 'إضافة عنوان';
  document.getElementById('address-label').value = addr ? addr.label : '';
  document.getElementById('address-text').value = addr ? addr.address : '';
  document.getElementById('address-is-default').checked = addr ? addr.isDefault === true : state.addresses.length === 0;

  // Reset the location rows for a fresh start every time
  const noteRow = document.getElementById('modal-location-note-row');
  const successRow = document.getElementById('modal-location-success');
  const blockedRow = document.getElementById('modal-location-blocked');
  if (noteRow) noteRow.style.display = 'flex';
  if (successRow) successRow.style.display = 'none';
  if (blockedRow) blockedRow.style.display = 'none';

  document.getElementById('address-modal-overlay').classList.add('open');
}

/**
 * Ask the browser for the user's coordinates while filling an address.
 * Optional — never blocks saving, only adds a pin the owner can see.
 */
function captureModalLocation() {
  const noteRow = document.getElementById('modal-location-note-row');
  const successRow = document.getElementById('modal-location-success');
  const blockedRow = document.getElementById('modal-location-blocked');

  if (!('geolocation' in navigator)) {
    if (noteRow) noteRow.style.display = 'none';
    if (blockedRow) blockedRow.style.display = 'flex';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.modalLocation = {
        lat: Number(position.coords.latitude.toFixed(6)),
        lng: Number(position.coords.longitude.toFixed(6))
      };
      if (noteRow) noteRow.style.display = 'none';
      if (blockedRow) blockedRow.style.display = 'none';
      if (successRow) successRow.style.display = 'flex';
    },
    () => {
      // Refused or failed — the note row with the button disappears and the
      // browser-settings hint takes its place
      state.modalLocation = null;
      if (noteRow) noteRow.style.display = 'none';
      if (blockedRow) blockedRow.style.display = 'flex';
    },
    // No `timeout`: while the browser's permission prompt is open the user has
    // not answered yet, and a 15s cap used to expire first and show the
    // browser-settings hint as if they had refused.
    { enableHighAccuracy: false, maximumAge: 60000 }
  );
}

function closeAddressModal() {
  document.getElementById('address-modal-overlay').classList.remove('open');
}

async function saveAddress() {
  const label = document.getElementById('address-label').value.trim();
  const address = document.getElementById('address-text').value.trim();
  const isDefault = document.getElementById('address-is-default').checked;

  if (label.length < 1) return alert('اسم العنوان مطلوب');
  if (address.length < 5) return alert('العنوان يجب أن يكون 5 أحرف على الأقل');

  try {
    const url = state.editingId
      ? '/api/me/addresses/' + encodeURIComponent(state.editingId)
      : '/api/me/addresses';
    const res = await fetch(url, {
      method: state.editingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, address, isDefault, location: state.modalLocation || null })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'save failed');
    closeAddressModal();
    await loadAddresses();
  } catch (err) {
    alert(err.message || 'حدث خطأ أثناء حفظ العنوان.');
  }
}

// ─── Notifications Tab ───────────────────────────────────────

const SMS_TOGGLE_KEY = 'alkhairat_sms_notifications';

function loadNotificationSetting() {
  const toggle = document.getElementById('toggle-sms');
  const saved = localStorage.getItem(SMS_TOGGLE_KEY);
  // Default: on (order updates arrive by SMS for everyone)
  toggle.checked = saved !== 'false';
}

function setupNotificationToggle() {
  const toggle = document.getElementById('toggle-sms');
  toggle.addEventListener('change', () => {
    localStorage.setItem(SMS_TOGGLE_KEY, toggle.checked ? 'true' : 'false');
  });
}

// ─── Maintenance Mode (owner page only) ──────────────────────

function setupMaintenanceToggle() {
  const toggle = document.getElementById('mm-toggle');
  if (!toggle) return; // user settings page has no such toggle

  // Load the current state
  fetch('/api/store-status')
    .then((r) => r.json())
    .then((data) => { toggle.checked = data.maintenanceMode === true; })
    .catch(() => {});

  toggle.addEventListener('change', async () => {
    const turningOn = toggle.checked;

    // Revert the toggle until the owner confirms — the popup decides
    toggle.checked = !turningOn;

    const confirmed = turningOn
      ? confirm(
          'هل أنت متأكد أنك تريد إيقاف المتجر؟\n\n' +
          'سيتم إغلاق الطلبات في الموقع بالكامل:\n' +
          '— لن يستطيع العملاء إضافة منتجات إلى السلة\n' +
          '— لن يستطيع أحد إتمام طلب\n' +
          '— ستظهر رسالة أعلى كل صفحة تخبر الزوار أن المتجر مغلق مؤقتاً\n\n' +
          'الزوار يستطيعون فقط التصفح وإنشاء حساب.'
        )
      : confirm('هل أنت متأكد أنك تريد إعادة فتح المتجر والسماح بالطلبات مرة أخرى؟');

    if (!confirmed) return;

    toggle.disabled = true;
    try {
      const res = await fetch('/api/owner/maintenance-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maintenanceMode: turningOn })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed');
      toggle.checked = turningOn;
      alert(turningOn
        ? 'تم توقيف الطلبات مؤقتاً. لا يمكن إنشاء طلبات جديدة الآن.'
        : 'تم فتح المتجر. الطلبات تعمل الآن بشكل طبيعي.');
    } catch (err) {
      alert('حدث خطأ أثناء تحديث حالة المتجر. حاول مرة أخرى.');
    } finally {
      toggle.disabled = false;
    }
  });
}

// ─── Logout (shared with the header profile button) ──────────

function setupLogout() {
  const btn = document.getElementById('btn-settings-logout');
  if (btn) btn.addEventListener('click', openLogoutConfirm);

  document.getElementById('logout-cancel').addEventListener('click', closeLogoutConfirm);
  document.getElementById('logout-confirm').addEventListener('click', doLogout);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLogoutConfirm();
  });
}

function openLogoutConfirm() {
  document.getElementById('logout-overlay').classList.add('open');
}

function closeLogoutConfirm() {
  document.getElementById('logout-overlay').classList.remove('open');
}

async function doLogout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {}
  window.location.href = '/';
}
