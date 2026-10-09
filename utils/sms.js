import axios from 'axios';

const YAMAMAH_URL = process.env.YAMAMAH_API_URL || 'http://api.yamamah.com/SendSMS';
const YAMAMAH_USERNAME = process.env.YAMAMAH_USERNAME;
const YAMAMAH_PASSWORD = process.env.YAMAMAH_PASSWORD;
const YAMAMAH_SENDER = process.env.YAMAMAH_SENDER;

/**
 * Check whether the Yamamah credentials are present in the environment.
 * If they are, real SMS messages are sent; otherwise messages are simulated
 * in the server console so the app stays testable without credentials.
 */
export function isSmsConfigured() {
  return Boolean(YAMAMAH_USERNAME && YAMAMAH_PASSWORD && YAMAMAH_SENDER);
}

/**
 * Print a simulated SMS to the server console.
 */
function simulateSMS(to, message) {
  const line = '─'.repeat(56);
  console.log(`\n${line}`);
  console.log('SIMULATED SMS (Yamamah credentials not set in .env)');
  console.log(line);
  console.log(`To: ${to}`);
  console.log('Message:');
  console.log(`  ${message}`);
  console.log(line);
}

/**
 * Convert Saudi local format (05XXXXXXXX) to international (9665XXXXXXXX)
 */
function formatSaudiPhone(phone) {
  if (phone.startsWith('+966')) return phone.slice(1);
  if (phone.startsWith('0')) return '966' + phone.slice(1);
  return phone;
}

/**
 * Send an SMS via Yamamah REST API, or simulate it in the console
 * when the credentials are not configured yet.
 * @param {string} to - Recipient phone number (e.g. "05XXXXXXXX")
 * @param {string} message - Message body
 */
export async function sendSMS(to, message) {
  const formatted = formatSaudiPhone(to);

  // Simulation mode — credentials missing
  if (!isSmsConfigured()) {
    simulateSMS(formatted, message);
    return { success: true, simulated: true };
  }

  try {
    const payload = {
      username: YAMAMAH_USERNAME,
      password: YAMAMAH_PASSWORD,
      sender: YAMAMAH_SENDER,
      RecepientNumber: formatted,
      Message: message
    };

    const response = await axios.post(YAMAMAH_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    // Yamamah returns { SendSMSResult: { ... } } or similar
    if (response.data && response.data.SendSMSResult) {
      return { success: true, messageId: response.data.SendSMSResult.MessageId };
    }

    return { success: true, raw: response.data };
  } catch (err) {
    console.error('SMS send error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send an OTP verification code via SMS.
 * @param {string} phone - Recipient phone number
 * @param {string} code - 6-digit OTP code
 */
export async function sendOTP(phone, code) {
  const message = `كود التحقق الخاص بك هو: ${code}\nهذا الكود صالح لمدة 15 دقيقة فقط.`;
  return sendSMS(phone, message);
}
