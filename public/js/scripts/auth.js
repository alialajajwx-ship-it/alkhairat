// Login / signup page script
// Handles switching between login, registration, forgot-password (OTP reset),
// and redirects

const FINGERPRINT_KEY = 'alkhairat_device_fingerprint';

let deviceFingerprint = null;
let pendingPhone = '';
// Which flow the OTP step is currently serving: 'register' | 'reset'
let otpFlow = 'register';
// The reset code after it has been verified — needed by /api/reset-password
let verifiedResetCode = '';
let resendTimerInterval = null;
let resendSecondsLeft = 0;

// The fingerprint loads in the background (it may hit the CDN). Handlers that
// send it await this promise first, so a fast submit never sends a null id.
let fingerprintReadyPromise = null;

const OTP_RESEND_SECONDS = 15 * 60; // same as the OTP validity window

/**
 * Convert Arabic-Indic digits (٠-٩ ۰-۹) to Latin digits (0-9) so users can
 * type their phone number with either keyboard layout.
 */
function normalizeDigits(value) {
  return String(value)
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

/**
 * Read a phone input, normalize Arabic digits, and write the Latin digits
 * back into the field so the user sees exactly what will be sent.
 */
function getPhoneValue(inputId) {
  const input = document.getElementById(inputId);
  const normalized = normalizeDigits(input.value).replace(/[^0-9]/g, '');
  input.value = normalized;
  return normalized.trim();
}

// ─── Redirect Target ────────────────────────────────────────

/**
 * Where to go after a successful auth action. Pages can pass
 * ?redirect=checkout so the user returns to what they were doing
 * (e.g. checkout redirects guests here with redirect=checkout).
 */
function getRedirectTarget() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('redirect') === 'checkout') return '/checkout';
  return '/';
}

// ─── Init ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Open a specific form directly when coming from another page
  // (?mode=register from checkout, ?mode=forgot from the checkout modal).
  // This runs FIRST and synchronously — before the fingerprint (CDN) load —
  // so the correct panel is on screen immediately. The server also renders
  // the requested panel visible; this is just the JS-side guarantee.
  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'register') {
    showSection('page-register');
  } else if (params.get('mode') === 'forgot') {
    showSection('page-forgot');
  }

  // Wire up every form right away — no awaits before the listeners exist
  setupLoginForm();
  setupRegisterForm();
  setupForgotForm();
  setupResetForm();
  setupPasswordToggles();
  setupOTPInputs();
  setupOTPButtons();

  // The fingerprint only decorates API calls, so it loads in the background;
  // submit handlers await the promise before using the value.
  fingerprintReadyPromise = initFingerprint();
});

// ─── Fingerprint ─────────────────────────────────────────────

async function initFingerprint() {
  // Reuse the cached fingerprint from the checkout modal when available
  const cached = localStorage.getItem(FINGERPRINT_KEY);
  if (cached) {
    deviceFingerprint = cached;
  }

  try {
    if (window.FingerprintJS) {
      const fp = await window.FingerprintJS.load();
      const result = await fp.get();
      deviceFingerprint = result.visitorId;
      localStorage.setItem(FINGERPRINT_KEY, deviceFingerprint);
    }
  } catch {
    if (!deviceFingerprint) {
      deviceFingerprint = 'fp-' + Math.random().toString(36).slice(2);
    }
  }
}

// ─── Section Switching ───────────────────────────────────────

function showSection(id) {
  ['page-login', 'page-register', 'page-forgot', 'page-otp', 'page-reset', 'page-success'].forEach((sectionId) => {
    const el = document.getElementById(sectionId);
    if (el) el.style.display = sectionId === id ? '' : 'none';
  });

  // The register form is tall: clicking "التالي" at the bottom leaves the
  // window scrolled down, and the OTP step then opens below the fold.
  // Jump back to the top whenever a new step (like التحقق) is shown.
  window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
}

function setupLoginForm() {
  const switchBtn = document.getElementById('switch-to-register');
  const backSwitchBtn = document.getElementById('switch-to-login');
  const form = document.getElementById('page-login-form');

  if (switchBtn) {
    switchBtn.addEventListener('click', () => showSection('page-register'));
  }
  if (backSwitchBtn) {
    backSwitchBtn.addEventListener('click', () => showSection('page-login'));
  }

  form.addEventListener('submit', handleLogin);
}

function setupRegisterForm() {
  document.getElementById('page-register-form').addEventListener('submit', handleRegister);
}

// ─── Forgot / Reset Password ───────────────────────────────

function setupForgotForm() {
  const forgotLink = document.getElementById('forgot-link');
  if (forgotLink) {
    forgotLink.addEventListener('click', () => showSection('page-forgot'));
  }

  const backLink = document.getElementById('forgot-to-login');
  if (backLink) {
    backLink.addEventListener('click', () => showSection('page-login'));
  }

  document.getElementById('page-forgot-form').addEventListener('submit', handleForgotPassword);
}

function setupResetForm() {
  document.getElementById('page-reset-form').addEventListener('submit', handleResetPassword);
}

// ─── Password Eye Toggles ───────────────────────────────────

function setupPasswordToggles() {
  document.querySelectorAll('.password-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;

      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.querySelector('.material-symbols-outlined').textContent = show ? 'visibility_off' : 'visibility';
      btn.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
    });
  });
}

// ─── Forgot Password (request a reset code) ─────────────

async function handleForgotPassword(e) {
  e.preventDefault();

  const phone = getPhoneValue('page-forgot-phone');
  const errorEl = document.getElementById('page-forgot-error');
  const submitBtn = document.getElementById('page-forgot-submit');

  if (!/^05\d{8}$/.test(phone)) {
    errorEl.textContent = 'رقم الهاتف يجب أن يبدأ بـ 05 ويكون 10 أرقام';
    return;
  }

  errorEl.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'جاري الارسال...';

  try {
    if (fingerprintReadyPromise) await fingerprintReadyPromise;
    const res = await fetch('/api/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, deviceFingerprint })
    });

    const data = await res.json();

    if (!res.ok) {
      // 429 with codePending means a code is already on its way — go
      // straight to the OTP step instead of blocking the user
      if (data.codePending) {
        pendingPhone = phone;
        otpFlow = 'reset';
        enterOtpSection();
        startResendCountdown();
        return;
      }

      errorEl.textContent = data.error || 'حدث خطأ. حاول مرة أخرى';
      return;
    }

    // Move to the OTP step — the same message shows whether or not the
    // number is registered, so the user always advances
    pendingPhone = phone;
    otpFlow = 'reset';
    enterOtpSection();
    startResendCountdown();
  } catch {
    errorEl.textContent = 'خطأ في الاتصال بالخادم';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'إرسال الكود';
  }
}

/**
 * Prepare the shared OTP section for the active flow (register or reset)
 * and show it.
 */
function enterOtpSection() {
  const title = document.getElementById('otp-title');
  const subtitle = document.getElementById('otp-subtitle');

  if (otpFlow === 'reset') {
    if (title) title.textContent = 'تحقق من رقم هاتفك';
    if (subtitle) subtitle.textContent = 'أدخل الكود المرسل إلى هاتفك لإعادة تعيين كلمة المرور';
  } else {
    if (title) title.textContent = 'تحقق من رقم هاتفك';
    if (subtitle) subtitle.textContent = 'أدخل الكود المرسل إلى هاتفك';
  }

  showSection('page-otp');

  const firstOtp = document.querySelector('#page-otp .otp-digit');
  if (firstOtp) firstOtp.focus();
}

// ─── Reset Password (new password after code verified) ──

async function handleResetPassword(e) {
  e.preventDefault();

  const password = document.getElementById('page-reset-password').value;
  const confirmPassword = document.getElementById('page-reset-confirm').value;
  const errorEl = document.getElementById('page-reset-error');
  const submitBtn = document.getElementById('page-reset-submit');

  if (password.length < 6) {
    errorEl.textContent = 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
    return;
  }

  if (password !== confirmPassword) {
    errorEl.textContent = 'كلمتا المرور غير متطابقتين';
    return;
  }

  errorEl.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'جاري الحفظ...';    try {
    const res = await fetch('/api/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: pendingPhone, code: verifiedResetCode, password })
    });

    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'حدث خطأ أثناء تغيير كلمة المرور';
      return;
    }

    // Password changed and the user is logged in — merge the account cart
    try {
      const cartModule = await import('../data/cart.js');
      await cartModule.mergeServerCart();
    } catch {}

    showSection('page-success');
    const title = document.getElementById('success-title');
    if (title) title.textContent = 'تم تغيير كلمة المرور بنجاح!';
    setTimeout(() => (window.location.href = getRedirectTarget()), 1200);
  } catch {
    errorEl.textContent = 'خطأ في الاتصال بالخادم';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'تغيير كلمة المرور';
  }
}

// ─── Login ───────────────────────────────────────────────────

async function handleLogin(e) {
  e.preventDefault();

  const phone = getPhoneValue('page-login-phone');
  const password = document.getElementById('page-login-password').value;
  const errorEl = document.getElementById('page-login-error');
  const submitBtn = document.getElementById('page-login-submit');

  if (!/^05\d{8}$/.test(phone)) {
    errorEl.textContent = 'رقم الهاتف يجب أن يبدأ بـ 05 ويكون 10 أرقام';
    return;
  }

  errorEl.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'جاري تسجيل الدخول...';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password })
    });

    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'رقم الهاتف أو كلمة المرور غير صحيحة';
      return;
    }

    showSection('page-success');

    // Load the cart saved on the account before navigating away
    try {
      const cartModule = await import('../data/cart.js');
      await cartModule.mergeServerCart();
    } catch {}

    setTimeout(() => (window.location.href = getRedirectTarget()), 1200);
  } catch {
    errorEl.textContent = 'خطأ في الاتصال بالخادم';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'تسجيل الدخول';
  }
}

// ─── Register (send OTP) ─────────────────────────────────────

async function handleRegister(e) {
  e.preventDefault();

  const name = document.getElementById('page-reg-name').value.trim();
  const phone = getPhoneValue('page-reg-phone');
  const password = document.getElementById('page-reg-password').value;
  const confirmPassword = document.getElementById('page-reg-confirm').value;
  const terms = document.getElementById('page-reg-terms').checked;
  const privacy = document.getElementById('page-reg-privacy')?.checked ?? true;
  const errorEl = document.getElementById('page-reg-error');
  const submitBtn = document.getElementById('page-reg-submit');

  if (name.length < 2) {
    errorEl.textContent = 'اختر اسماً لك (حرفان على الأقل)';
    return;
  }

  if (!/^05\d{8}$/.test(phone)) {
    errorEl.textContent = 'رقم الهاتف يجب أن يبدأ بـ 05 ويكون 10 أرقام';
    return;
  }

  if (password.length < 6) {
    errorEl.textContent = 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
    return;
  }

  if (password !== confirmPassword) {
    errorEl.textContent = 'كلمتا المرور غير متطابقتين';
    return;
  }

  if (!terms || !privacy) {
    errorEl.textContent = 'يجب الموافقة على الشروط والأحكام وسياسة الخصوصية';
    return;
  }

  errorEl.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'جاري الارسال...';

  try {
    if (fingerprintReadyPromise) await fingerprintReadyPromise;
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        phone,
        password,
        confirmPassword,
        termsAccepted: 'true',
        privacyAccepted: 'true',
        deviceFingerprint
      })
    });

    const data = await res.json();

    if (!res.ok) {
      // 429 with codePending means a code is already on its way — let the
      // user go straight to the OTP step instead of blocking them
      if (data.codePending) {
        pendingPhone = phone;
        errorEl.textContent = '';
        showSection('page-otp');
        startResendCountdown();
        return;
      }

      errorEl.textContent = data.error || 'حدث خطأ أثناء التسجيل';
      return;
    }

    // Success — show OTP step (code is valid for 15 minutes)
    pendingPhone = phone;
    otpFlow = 'register';
    enterOtpSection();
    startResendCountdown();
  } catch {
    errorEl.textContent = 'خطأ في الاتصال بالخادم';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'التالي';
  }
}

// ─── OTP Verification ────────────────────────────────────────

async function handleVerifyOTP() {
  const digits = document.querySelectorAll('#page-otp .otp-digit');
  const code = Array.from(digits).map((d) => d.value).join('');
  const errorEl = document.getElementById('page-otp-error');
  const verifyBtn = document.getElementById('page-otp-verify');

  if (code.length !== 6) {
    errorEl.textContent = 'أدخل الكود كاملاً (6 أرقام)';
    return;
  }

  errorEl.textContent = '';
  verifyBtn.disabled = true;
  verifyBtn.textContent = 'جاري التحقق...';

  try {
    if (otpFlow === 'reset') {
      await verifyResetCode(code, errorEl, verifyBtn);
    } else {
      await verifyRegisterCode(code, errorEl, verifyBtn);
    }
  } catch {
    errorEl.textContent = 'خطأ في الاتصال بالخادم';
  } finally {
    verifyBtn.disabled = false;
    verifyBtn.textContent = 'تحقق';
  }
}

/**
 * Verify a REGISTER-purpose code — completes signup, logs the user in.
 */
async function verifyRegisterCode(code, errorEl, verifyBtn) {
  const res = await fetch('/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: pendingPhone, code })
  });

  const data = await res.json();

  if (!res.ok) {
    errorEl.textContent = data.error || 'كود التحقق غير صحيح';
    if (data.attemptsLeft !== undefined) {
      errorEl.textContent += ` (${data.attemptsLeft} محاولات متبقية)`;
    }
    return;
  }

  // Registered and logged in
  stopResendTimer();
  showSection('page-success');

  // Push the guest cart to the new account so it is saved
  try {
    const cartModule = await import('../data/cart.js');
    await cartModule.syncCartToServer();
  } catch {}

  setTimeout(() => (window.location.href = getRedirectTarget()), 1200);
}

/**
 * Verify a RESET-purpose code — does NOT log in or change anything yet.
 * The code is kept in memory and sent with the new password in the final
 * step, so the code proves ownership right before the password changes.
 */
async function verifyResetCode(code, errorEl, verifyBtn) {
  const res = await fetch('/api/reset-password/verify-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: pendingPhone, code })
  });

  const data = await res.json();

  if (!res.ok) {
    errorEl.textContent = data.error || 'كود التحقق غير صحيح';
    if (data.attemptsLeft !== undefined) {
      errorEl.textContent += ` (${data.attemptsLeft} محاولات متبقية)`;
    }
    return;
  }

  // Code verified — move to the "new password" step
  stopResendTimer();
  verifiedResetCode = code;
  showSection('page-reset');

  const firstPassword = document.getElementById('page-reset-password');
  if (firstPassword) firstPassword.focus();
}

// ─── Resend Countdown ────────────────────────────────────────

function startResendCountdown() {
  stopResendTimer();
  resendSecondsLeft = OTP_RESEND_SECONDS;

  const wrap = document.getElementById('page-resend-wrap');
  const btn = document.getElementById('page-otp-resend');
  const timerEl = document.getElementById('page-resend-timer');
  if (!wrap || !btn || !timerEl) return;

  btn.disabled = true;
  wrap.style.display = '';
  updateResendTimerText();

  resendTimerInterval = setInterval(() => {
    resendSecondsLeft -= 1;
    updateResendTimerText();
    if (resendSecondsLeft <= 0) {
      stopResendTimer();
    }
  }, 1000);
}

function updateResendTimerText() {
  const timerEl = document.getElementById('page-resend-timer');
  const btn = document.getElementById('page-otp-resend');
  if (!timerEl || !btn) return;

  const minutes = String(Math.floor(resendSecondsLeft / 60)).padStart(2, '0');
  const seconds = String(resendSecondsLeft % 60).padStart(2, '0');
  timerEl.textContent = `يمكنك طلب كود جديد بعد ${minutes}:${seconds}`;
  btn.disabled = true;
}

function stopResendTimer() {
  if (resendTimerInterval) {
    clearInterval(resendTimerInterval);
    resendTimerInterval = null;
  }
  const timerEl = document.getElementById('page-resend-timer');
  const btn = document.getElementById('page-otp-resend');
  if (btn) btn.disabled = false;
  if (timerEl) timerEl.textContent = '';
}

async function handleResendOTP() {
  const resendBtn = document.getElementById('page-otp-resend');
  resendBtn.disabled = true;
  resendBtn.textContent = 'جاري الارسال...';

  try {
    if (otpFlow === 'reset') {
      await resendResetCode(resendBtn);
    } else {
      await resendRegisterCode(resendBtn);
    }
  } catch {
    resendBtn.textContent = 'خطأ في الاتصال';
  } finally {
    setTimeout(() => {
      resendBtn.textContent = 'إعادة إرسال الكود';
    }, 2500);
  }
}

async function resendRegisterCode(resendBtn) {
  // Send the same registration data again — the password and name come
  // from the register form still present in the DOM, so the pending
  // registration keeps the real values
  const name = document.getElementById('page-reg-name')?.value || 'مستخدم';
  const password = document.getElementById('page-reg-password')?.value;

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      phone: pendingPhone,
      password,
      confirmPassword: password,
      termsAccepted: 'true',
      privacyAccepted: 'true',
      deviceFingerprint
    })
  });

  const data = await res.json().catch(() => ({}));

  if (res.ok) {
    resendBtn.textContent = 'تم الارسال!';
    startResendCountdown();
  } else {
    resendBtn.textContent = data.error || 'خطأ. حاول مرة أخرى';
  }
}

async function resendResetCode(resendBtn) {
  const res = await fetch('/api/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: pendingPhone, deviceFingerprint })
  });

  const data = await res.json().catch(() => ({}));

  if (res.ok) {
    resendBtn.textContent = 'تم الارسال!';
    startResendCountdown();
  } else if (data.codePending) {
    // The server still has a live code for this number — resume the countdown
    startResendCountdown();
  } else {
    resendBtn.textContent = data.error || 'خطأ. حاول مرة أخرى';
  }
}

// ─── OTP Inputs ──────────────────────────────────────────────

function setupOTPButtons() {
  document.getElementById('page-otp-verify').addEventListener('click', handleVerifyOTP);
  document.getElementById('page-otp-resend').addEventListener('click', handleResendOTP);

  // Go back and change the phone number — this is the only way to get a new
  // code before the current one expires
  document.getElementById('page-otp-back').addEventListener('click', () => {
    stopResendTimer();
    pendingPhone = '';
    verifiedResetCode = '';
    otpFlow = 'register';
    document.querySelectorAll('#page-otp .otp-digit').forEach((d) => (d.value = ''));
    document.getElementById('page-otp-error').textContent = '';
    showSection('page-register');
  });
}

function setupOTPInputs() {
  const digits = document.querySelectorAll('#page-otp .otp-digit');

  digits.forEach((input, index) => {
    input.addEventListener('input', (e) => {
      const val = e.target.value.replace(/[^0-9]/g, '');
      e.target.value = val;

      if (val && index < digits.length - 1) {
        digits[index + 1].focus();
      }

      // No auto-verify — the code is only checked when the user clicks تحقق
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && index > 0) {
        digits[index - 1].focus();
      }

      // Arrow keys follow the visual LTR digit order
      if (e.key === 'ArrowRight' && index < digits.length - 1) {
        e.preventDefault();
        digits[index + 1].focus();
      }
      if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault();
        digits[index - 1].focus();
      }
    });

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');

      for (let i = 0; i < Math.min(pasted.length, digits.length); i++) {
        digits[i].value = pasted[i];
      }

      const focusIndex = Math.min(pasted.length, digits.length - 1);
      digits[focusIndex].focus();
      // No auto-verify — the code is only checked when the user clicks تحقق
    });
  });
}
