// Dashboard script — fetches real orders from the server (MongoDB)
// so the owner sees every order, not just ones placed in this browser

(function () {
  const tbody = document.getElementById('orders-tbody');
  const emptyState = document.getElementById('empty-state');
  const searchInput = document.getElementById('search-input');
  const modalOverlay = document.getElementById('order-modal-overlay');
  const modalBody = document.getElementById('order-modal-body');
  const modalClose = document.getElementById('order-modal-close');

  // Mirror of normalizeProductName() in js/data/products.js (this page is a
  // classic script, so it cannot import the module). Reattaches a unit marker
  // the catalog source left at the front of a name — "g…165" → "…165g" — so
  // the order modal shows the same corrected name as the rest of the site.
  const LEADING_UNIT = /^(kg|ml|oz|cm|g|l)(?=[\u0600-\u06FF])/i;
  const TRAILING_NUMBER = /[0-9](?:\.[0-9]+)?\s*$/;
  function normalizeProductName(name) {
    const value = String(name == null ? '' : name);
    const match = value.match(LEADING_UNIT);
    if (!match) return value;
    const rest = value.slice(match[1].length);
    if (!TRAILING_NUMBER.test(rest)) return value;
    return rest.replace(/\s+$/, '') + match[1];
  }

  const STATUS_MAP = {
    preparing: 'يتم التجهيز',
    on_the_way: 'قيد التوصيل',
    delivered: 'تم التوصيل'
  };

  const STATUS_CLASS = {
    preparing: 'preparing',
    on_the_way: 'on-way',
    delivered: 'delivered'
  };

  // Cancelled orders (after the replacement review) show a dedicated red tag
  const CANCELLED_BADGE = '<span class="status-badge cancelled">ملغي</span>';

  // The الدفع column shows the payment state — capture happens automatically
  // when the owner confirms the order, so there is no separate button.
  const PAYMENT_LABELS = {
    pending_authorization: 'بانتظار الدفع',
    authorized: 'محجوز على البطاقة',
    paid: 'مدفوع',
    voided: 'مسترجع',
    cash: 'دفع عند الاستلام'
  };

  function statusBadge(order) {
    if (order.cancelled) return CANCELLED_BADGE;

    // A brand-new order is only under REVIEW until the owner accepts it from
    // the customer-order page: the stage stored on it is already 'preparing',
    // but «يتم التجهيز» promised a preparation that had not started.
    if (!order.confirmed) {
      return '<span class="status-badge preparing">يتم المراجعة</span>';
    }

    // The delivery stage is the NEWEST fact about the order: once the owner
    // moved it along, that is what the row must say. A delivered order used
    // to keep the combined «مدفوع / جاري تجهيز الطلب» badge forever.
    if (order.status === 'delivered' || order.status === 'on_the_way') {
      const stageCls = STATUS_CLASS[order.status] || 'preparing';
      return `<span class="status-badge ${stageCls}">${STATUS_MAP[order.status]}</span>`;
    }

    // Paid card orders show the combined status the owner cares about
    if (order.paymentStatus === 'paid') {
      return '<span class="status-badge paid">مدفوع / جاري تجهيز الطلب</span>';
    }

    const statusText = STATUS_MAP[order.status] || order.status;
    const statusCls = STATUS_CLASS[order.status] || 'preparing';
    return `<span class="status-badge ${statusCls}">${statusText}</span>`;
  }

  /**
   * The payment cell: a small label showing the payment state.
   */
  function paymentCell(order) {
    const label = order.paymentStatus === 'paid' && order.paymentMethod === 'cash'
      ? 'دفع عند الاستلام'
      : (PAYMENT_LABELS[order.paymentStatus] || '');
    return `<span class="payment-label">${label}</span>`;
  }

  let allOrders = [];

  // ── Load orders from the server ──────────────────────────
  async function loadOrders() {
    renderSkeletons();
    try {
      const res = await fetch('/api/admin/orders');
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      allOrders = (data.orders || []).map(normalizeOrder);
    } catch {
      allOrders = [];
    }
    updateKPIs();
    renderTable(allOrders);
  }

  // ── Skeleton loading placeholders ────────────────────────
  function renderSkeletons() {
    const kpiOrders = document.getElementById('kpi-total-orders');
    const kpiSales = document.getElementById('kpi-total-sales');
    if (kpiOrders) kpiOrders.innerHTML = '<span class="skel skel-inline"></span>';
    if (kpiSales) kpiSales.innerHTML = '<span class="skel skel-inline"></span>';

    if (!tbody) return;
    let rows = '';
    for (let i = 0; i < 4; i++) {
      rows += '<tr>';
      for (let c = 0; c < 7; c++) {
        rows += '<td><span class="skel skel-inline" style="width:' + (50 + (i % 3) * 20) + 'px"></span></td>';
      }
      rows += '</tr>';
    }
    tbody.innerHTML = rows;
    emptyState.style.display = 'none';
  }

  /**
   * Map the server order shape onto the field names the table expects.
   * Server sends `orderId` + `orderTime` (Date) — the table uses `id`.
   */
  function normalizeOrder(order) {
    return {
      id: order.orderId || order.id,
      items: order.items || [],
      total: order.total || 0,
      subtotal: order.subtotal,
      delivery: order.delivery,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus || (order.paymentMethod === 'cash' ? 'cash' : 'pending_authorization'),
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerAddress: order.customerAddress,
      status: order.status,
      confirmed: order.confirmed,
      cancelled: order.cancelled,
      orderTime: order.orderTime
    };
  }

  // ── KPI Cards ───────────────────────────────────────────
  function updateKPIs() {
    const totalOrders = allOrders.length;
    const totalSales = allOrders.reduce((sum, o) => sum + (o.total || 0), 0);

    document.getElementById('kpi-total-orders').textContent =
      totalOrders + ' طلب';
    document.getElementById('kpi-total-sales').textContent =
      totalSales.toLocaleString('ar-SA') + ' ر.س';
  }

  // ── Render table ────────────────────────────────────────
  function renderTable(orders) {
    if (!orders.length) {
      tbody.innerHTML = '';
      emptyState.style.display = '';
      return;
    }

    emptyState.style.display = 'none';

    // Sort newest first
    orders.sort((a, b) => new Date(b.orderTime) - new Date(a.orderTime));

    tbody.innerHTML = orders
      .map((order) => {
        return `
        <tr>
          <td><span class="order-id">${order.id}</span></td>
          <td><span class="customer-name">${order.customerName || '—'}</span></td>
          <td><span class="customer-phone">${order.customerPhone || '—'}</span></td>
          <td>${statusBadge(order)}</td>
          <td>${paymentCell(order)}</td>
          <td><span class="order-total">${(order.total || 0).toLocaleString('ar-SA')} ر.س</span></td>
          <td>
            <div class="action-cell">
              <a href="/customer-order?id=${order.id}" class="action-link">عرض التفاصيل</a>
            </div>
          </td>
        </tr>`;
      })
      .join('');
  }

  // ── Search ──────────────────────────────────────────────
  searchInput.addEventListener('input', () => {
    const term = searchInput.value.trim().toLowerCase();
    if (!term) {
      renderTable(allOrders);
      return;
    }
    const filtered = allOrders.filter((o) => {
      return (
        (o.id && o.id.toLowerCase().includes(term)) ||
        (o.customerName && o.customerName.toLowerCase().includes(term)) ||
        (o.customerPhone && o.customerPhone.toLowerCase().includes(term))
      );
    });
    renderTable(filtered);
  });

  // ── Modal ───────────────────────────────────────────────
  function openModal(orderId) {
    const order = allOrders.find((o) => o.id === orderId);
    if (!order) return;

    const items = (order.items || [])
      .map(
        (item) => `
      <div class="modal-item">
        <div>
          <div class="modal-item-name">${normalizeProductName(item.name)}</div>
          <div class="modal-item-details">×${item.quantity}${item.price ? ' — ' + item.price.toLocaleString('ar-SA') + ' ر.س للواحدة' : ''}</div>
        </div>
        <div class="modal-item-details">${item.price ? (item.price * item.quantity).toLocaleString('ar-SA') + ' ر.س' : ''}</div>
      </div>`
      )
      .join('');

    modalBody.innerHTML = `
      <div class="modal-order-id">${order.id}</div>
      <div class="modal-customer">
        <strong>${order.customerName || '—'}</strong>
        <span>${order.customerPhone || '—'}</span>
        <span>${order.customerAddress || '—'}</span>
      </div>
      <div class="modal-items">${items}</div>
      <div class="modal-total">
        <span>الإجمالي</span>
        <span class="amount">${(order.total || 0).toLocaleString('ar-SA')} ر.س</span>
      </div>
    `;

    modalOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    modalOverlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  if (modalClose) {
    modalClose.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // ── Init ────────────────────────────────────────────────
  loadOrders();
})();
