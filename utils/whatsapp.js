import axios from 'axios';

const WA_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const WA_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const OWNER_PHONE = process.env.OWNER_PHONE;

/**
 * Check whether the WhatsApp Cloud API credentials are present in the environment.
 * If they are, real WhatsApp messages are sent to the owner; otherwise messages
 * are simulated in the server console so the app stays testable.
 */
export function isWhatsAppConfigured() {
  return Boolean(WA_PHONE_NUMBER_ID && WA_ACCESS_TOKEN && OWNER_PHONE);
}

/**
 * Print a simulated WhatsApp message to the server console.
 */
function simulateWhatsApp(to, messageBody) {
  const line = '─'.repeat(56);
  console.log(`\n${line}`);
  console.log('SIMULATED WHATSAPP (Cloud API credentials not set in .env)');
  console.log(line);
  console.log(`To: ${to}`);
  console.log('Message:');
  console.log(messageBody);
  console.log(line);
}

/**
 * Convert Saudi local format to international without +
 */
function formatSaudiPhone(phone) {
  if (phone.startsWith('+966')) return phone.slice(1);
  if (phone.startsWith('0')) return '966' + phone.slice(1);
  return phone;
}

/**
 * Deliver a plain-text message to the store owner.
 *
 * This is the ONE place that decides between a real send and the console
 * simulation: the moment the three credentials exist in .env the simulation
 * stops and real WhatsApp messages start going out - no other change needed.
 * Every owner notification (new order, customer message, ...) goes through
 * here.
 * @param {string} messageBody
 */
export async function sendWhatsAppMessage(messageBody) {
  // Simulation mode - credentials missing
  if (!isWhatsAppConfigured()) {
    simulateWhatsApp(OWNER_PHONE || '(owner phone not set)', messageBody);
    return { success: true, simulated: true };
  }

  try {
    const formatted = formatSaudiPhone(OWNER_PHONE);
    const url = `https://graph.facebook.com/${WA_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;

    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      preview_url: false,
      recipient_type: 'individual',
      to: formatted,
      type: 'text',
      text: {
        body: messageBody
      }
    }, {
      headers: {
        'Authorization': `Bearer ${WA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    return { success: true, messageId: response.data?.messages?.[0]?.id };
  } catch (err) {
    console.error('WhatsApp notification error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send a WhatsApp message to the store owner with order details.
 * Uses the Official Meta WhatsApp Cloud API, or simulates the message
 * in the console when the credentials are not configured yet.
 * @param {object} order - The order object
 */
export async function sendWhatsAppNotification(order) {
  // Build the message body (shared by real send and simulation)
  const itemsList = (order.items || [])
    .map((item, i) => `${i + 1}. ${item.name} ×${item.quantity}، ${item.price} رس`)
    .join('\n');

  const messageBody = [
    `طلب جديد!`,
    ``,
    `رقم الطلب: ${order.orderId}`,
    `العميل: ${order.customerName}`,
    `الهاتف: ${order.customerPhone}`,
    `العنوان: ${order.customerAddress}`,
    ``,
    `المنتجات:`,
    itemsList,
    ``,
    `المجموع: ${order.total} رس`,
    `طريقة الدفع: ${order.paymentMethod === 'card' ? 'بطاقة ائتمانية' : 'الدفع عند الاستلام'}`
  ].join('\n');

  return sendWhatsAppMessage(messageBody);
}

/**
 * Build the owner's notice for a «تواصل معنا» customer message.
 * @param {{ name: string, phone: string, topic?: string, message: string }} msg
 * @returns {string}
 */
export function buildContactMessageBody(msg) {
  return [
    `رسالة جديدة من عميل!`,
    ``,
    `الاسم: ${msg.name}`,
    `رقم الجوال: ${msg.phone}`,
    msg.topic ? `الموضوع: ${msg.topic}` : null,
    ``,
    `الرسالة:`,
    msg.message
  ]
    .filter((line) => line !== null)
    .join('\n');
}
