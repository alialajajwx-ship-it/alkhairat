// «تواصل معنا» page script.
// The customer types a message and the form posts it to /api/contact-messages.
// The server stores it, notifies the owner on WhatsApp, and keeps the
// customer's own history, which this script lists under the form.
//
// Message text is written with textContent - never innerHTML - so nothing the
// customer typed can ever be re-rendered as markup.

import { formatOrderDateTime } from '../data/orders.js';

const form = document.getElementById('contact-form');
const successBox = document.getElementById('contact-success');
const anotherBtn = document.getElementById('contact-another');
const submitBtn = document.getElementById('contact-submit');
const messageEl = document.getElementById('contact-message');
const counterEl = document.getElementById('contact-counter');

const nameEl = document.getElementById('contact-name');
const phoneEl = document.getElementById('contact-phone');
const topicEl = document.getElementById('contact-topic');

const historyList = document.getElementById('contact-history-list');
const historyLoading = document.getElementById('contact-history-loading');
const historyEmpty = document.getElementById('contact-history-empty');
const historyCount = document.getElementById('contact-history-count');

/** Live character counter under the textarea */
if (messageEl && counterEl) {
  const updateCounter = () => { counterEl.textContent = String(messageEl.value.length); };
  messageEl.addEventListener('input', updateCounter);
  updateCounter();
}

/** One row of the customer's own history */
function buildHistoryItem(msg) {
  const item = document.createElement('article');
  item.className = 'history-item';

  const head = document.createElement('div');
  head.className = 'history-item-head';

  if (msg.topic) {
    const topic = document.createElement('span');
    topic.className = 'history-topic';
    topic.textContent = msg.topic;
    head.appendChild(topic);
  } else {
    const label = document.createElement('span');
    label.className = 'history-label';
    label.textContent = 'رسالة';
    head.appendChild(label);
  }

  const date = document.createElement('span');
  date.className = 'history-date';
  date.textContent = formatOrderDateTime(msg.createdAt);
  head.appendChild(date);

  item.appendChild(head);

  const body = document.createElement('p');
  body.className = 'history-body';
  body.textContent = msg.message || '';
  item.appendChild(body);

  return item;
}

function renderHistory(messages) {
  historyList.innerHTML = '';
  messages.forEach((m) => historyList.appendChild(buildHistoryItem(m)));

  historyLoading.style.display = 'none';
  const hasMessages = messages.length > 0;
  historyList.style.display = hasMessages ? '' : 'none';
  historyEmpty.style.display = hasMessages ? 'none' : 'block';

  if (historyCount) {
    historyCount.textContent = hasMessages ? `${messages.length} رسالة` : '';
  }
}

/** Load the messages this account already sent (newest first) */
async function loadHistory() {
  try {
    const res = await fetch('/api/contact-messages');
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    renderHistory(Array.isArray(data.messages) ? data.messages : []);
  } catch {
    renderHistory([]);
  }
}

/** Reset back to a blank form after a successful send */
function resetForm() {
  form.reset();
  topicEl.value = '';
  messageEl.value = '';
  if (counterEl) counterEl.textContent = '0';
  form.style.display = '';
  successBox.style.display = 'none';
}

if (anotherBtn) {
  anotherBtn.addEventListener('click', () => {
    resetForm();
    if (!nameEl.value) nameEl.focus();
    else messageEl.focus();
  });
}

if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = nameEl.value.trim();
    const phone = phoneEl.value.trim();
    const topic = topicEl.value.trim();
    const message = messageEl.value.trim();

    if (name.length < 2) { alert('يرجى إدخال الاسم.'); nameEl.focus(); return; }
    if (phone.length < 6) { alert('يرجى إدخال رقم الجوال.'); phoneEl.focus(); return; }
    if (message.length < 5) { alert('يرجى كتابة الرسالة.'); messageEl.focus(); return; }

    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/contact-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, topic, message })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        alert(data.error || 'تعذر إرسال الرسالة. حاول مرة أخرى.');
        return;
      }

      form.style.display = 'none';
      successBox.style.display = 'block';

      // The history is the server's copy of the truth: reload it so the
      // message that was just sent shows up straight away.
      await loadHistory();
    } catch {
      alert('خطأ في الاتصال بالخادم. حاول مرة أخرى.');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

loadHistory();
