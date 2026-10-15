// «رسائل العملاء» page script (owner only).
// Loads every message sent from the «تواصل معنا» page and renders it. The
// message text is customer input, so it is written with textContent - never
// with innerHTML - so nothing the customer typed can run in the owner session.

import { formatOrderDateTime } from '../data/orders.js';

const list = document.getElementById('messages-list');
const loading = document.getElementById('messages-loading');
const empty = document.getElementById('messages-empty');
const countEl = document.getElementById('messages-count');
const searchInput = document.getElementById('messages-search-input');

let messages = [];

/** Turn a Saudi local number into the wa.me international form */
function whatsappNumber(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits.slice(1);
  if (digits.startsWith('966')) return digits;
  if (digits.startsWith('0')) return '966' + digits.slice(1);
  return digits;
}

function buildCard(msg) {
  const card = document.createElement('article');
  card.className = 'message-card';

  const head = document.createElement('div');
  head.className = 'message-card-head';

  const who = document.createElement('div');
  who.className = 'message-who';

  const avatar = document.createElement('span');
  avatar.className = 'message-avatar material-symbols-outlined';
  avatar.textContent = 'person';
  who.appendChild(avatar);

  const identity = document.createElement('div');
  const name = document.createElement('strong');
  name.className = 'message-name';
  name.textContent = msg.name || 'عميل';
  const phone = document.createElement('span');
  phone.className = 'message-phone';
  phone.dir = 'ltr';
  phone.textContent = msg.phone || '';
  identity.appendChild(name);
  identity.appendChild(phone);
  who.appendChild(identity);
  head.appendChild(who);

  const date = document.createElement('span');
  date.className = 'message-date';
  date.textContent = formatOrderDateTime(msg.createdAt);
  head.appendChild(date);

  card.appendChild(head);

  if (msg.topic) {
    const topic = document.createElement('span');
    topic.className = 'message-topic';
    topic.textContent = msg.topic;
    card.appendChild(topic);
  }

  const body = document.createElement('p');
  body.className = 'message-body';
  body.textContent = msg.message || '';
  card.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'message-actions';

  const wa = document.createElement('a');
  wa.className = 'message-wa';
  wa.href = 'https://wa.me/' + whatsappNumber(msg.phone);
  wa.target = '_blank';
  wa.rel = 'noopener noreferrer';
  const waIcon = document.createElement('span');
  waIcon.className = 'material-symbols-outlined';
  waIcon.textContent = 'chat';
  wa.appendChild(waIcon);
  wa.appendChild(document.createTextNode('مراسلة واتساب'));
  actions.appendChild(wa);

  card.appendChild(actions);
  return card;
}

function render() {
  const term = (searchInput ? searchInput.value : '').trim().toLowerCase();
  const visible = messages.filter((m) => {
    if (!term) return true;
    return [m.name, m.phone, m.topic, m.message]
      .some((field) => String(field || '').toLowerCase().includes(term));
  });

  list.innerHTML = '';
  visible.forEach((m) => list.appendChild(buildCard(m)));

  if (countEl) {
    countEl.textContent = visible.length === messages.length
      ? `${messages.length} رسالة`
      : `عرض ${visible.length} من ${messages.length} رسالة`;
  }

  empty.style.display = messages.length ? 'none' : 'block';
  list.style.display = messages.length ? '' : 'none';
}

async function load() {
  try {
    const res = await fetch('/api/owner/contact-messages');
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    messages = Array.isArray(data.messages) ? data.messages : [];
  } catch {
    messages = [];
  } finally {
    loading.style.display = 'none';
    render();
  }
}

if (searchInput) searchInput.addEventListener('input', render);

load();
