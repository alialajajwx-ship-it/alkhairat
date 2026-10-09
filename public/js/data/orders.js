// Orders data module
// Manages orders via localStorage (nothing permanent)

const ORDERS_KEY = 'alkhairat_orders';

/** Delivery stages in order — the owner moves the order through them manually */
export const ORDER_STAGES = ['preparing', 'on_the_way', 'delivered'];

/**
 * Fetch all orders from localStorage
 */
export function fetchOrders() {
  try {
    const raw = localStorage.getItem(ORDERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Fetch a single order by ID from localStorage
 */
export function fetchOrder(orderId) {
  const orders = fetchOrders();
  return orders.find((o) => o.id === orderId) || null;
}

/**
 * Create a new order and save to localStorage
 * New orders start unconfirmed ("يتم المراجعة") until the owner confirms them
 * @param {Object} orderData - { items, total, customerName, customerPhone, customerAddress, ... }
 * @returns {Object} the created order
 */
export function createOrder(orderData) {
  const now = new Date();
  const order = {
    id: 'ORD-' + now.getFullYear().toString().slice(-2) +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0'),
    items: orderData.items,
    total: orderData.total,
    subtotal: orderData.subtotal || orderData.total,
    delivery: orderData.delivery || 0,
    paymentMethod: orderData.paymentMethod || 'card',
    customerName: orderData.customerName || '',
    customerPhone: orderData.customerPhone || '',
    customerAddress: orderData.customerAddress || '',
    orderTime: now.toISOString(),
    status: 'preparing',
    confirmed: false
  };

  const orders = fetchOrders();
  orders.push(order);
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));

  return order;
}

/**
 * Update any fields on an order
 * @param {string} orderId
 * @param {Object} updates - fields to merge into the order
 * @returns {Object|null} the updated order or null if not found
 */
export function updateOrder(orderId, updates) {
  const orders = fetchOrders();
  const order = orders.find((o) => o.id === orderId);
  if (!order) return null;

  Object.assign(order, updates);
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  return order;
}

/**
 * Update the delivery stage of an order (owner action)
 * @param {string} orderId
 * @param {string} stage - one of ORDER_STAGES
 */
export function setOrderStage(orderId, stage) {
  if (!ORDER_STAGES.includes(stage)) return null;
  return updateOrder(orderId, { status: stage });
}

/**
 * Get stage label in Arabic
 */
export function getStageLabel(status) {
  const labels = {
    preparing: 'يتم التجهيز',
    on_the_way: 'قيد التوصيل',
    delivered: 'تم التوصيل'
  };
  return labels[status] || status;
}

/**
 * Get stage status class
 */
export function getStageClass(status) {
  return `status-${status}`;
}
