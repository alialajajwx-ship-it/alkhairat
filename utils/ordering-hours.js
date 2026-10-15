// Weekly ordering hours - the owner picks, for each day of the week, whether
// ordering is open from the website and between which times.
//
// Stored in data/settings.json under `orderingHours` and enforced by the server
// on every ordering endpoint, so the browser can never order outside the window
// even with a hand-written request.
//
// All times are the STORE's wall clock (Saudi Arabia, UTC+3, no DST): the
// owner's «from 4 PM to 8 PM» means 4 PM in the store, no matter which
// timezone the server or the customer's browser runs in.
//
// The module is pure - no I/O, no Express, no Mongoose - so the rules can be
// unit tested and reused anywhere.

/** Day names, indexed the same way as Date#getDay (0 = Sunday … 6 = Saturday) */
export const DAY_NAMES_AR = [
  'الأحد',
  'الاثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
  'السبت'
];

/** Store timezone offset in minutes (Saudi Arabia is a fixed UTC+3) */
export const STORE_OFFSET_MINUTES = 3 * 60;

/** The window a brand-new schedule starts with. */
export const DEFAULT_FROM = '16:00';
export const DEFAULT_TO = '20:00';

/**
 * A full, disabled schedule: every day closed, times pre-filled with the
 * default window so the owner only has to tick the days.
 */
export function defaultOrderingHours() {
  return {
    enabled: false,
    days: DAY_NAMES_AR.map((_, day) => ({ day, open: false, from: DEFAULT_FROM, to: DEFAULT_TO }))
  };
}

/** «9:5» / «9» / «09:30» → «HH:MM», or null when the value is not a time. */
export function normalizeTime(value) {
  const match = String(value == null ? '' : value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return null;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** «HH:MM» → minutes since midnight, or null when unparseable. */
function toMinutes(value) {
  const time = normalizeTime(value);
  if (!time) return null;
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Fill in a complete, always-usable schedule from whatever is on disk.
 * Anything missing or malformed falls back to the default, so a hand-edited
 * settings.json can never crash the ordering endpoints.
 * @param {object} [raw]
 * @returns {{ enabled: boolean, days: Array<{day:number, open:boolean, from:string, to:string}> }}
 */
export function normalizeOrderingHours(raw) {
  const schedule = defaultOrderingHours();
  if (!raw || typeof raw !== 'object') return schedule;

  schedule.enabled = raw.enabled === true;

  const saved = new Map();
  (Array.isArray(raw.days) ? raw.days : []).forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const day = Number(entry.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) return;
    saved.set(day, entry);
  });

  schedule.days = schedule.days.map((day) => {
    const entry = saved.get(day.day);
    if (!entry) return day;
    return {
      day: day.day,
      open: entry.open === true,
      from: normalizeTime(entry.from) || DEFAULT_FROM,
      to: normalizeTime(entry.to) || DEFAULT_TO
    };
  });

  return schedule;
}

/**
 * Validate an owner-submitted schedule.
 * @returns {string|null} an Arabic error message, or null when the payload is ok
 */
export function validateOrderingHours(raw) {
  if (!raw || typeof raw !== 'object') return 'صيغة غير صحيحة';
  if (typeof raw.enabled !== 'boolean') return 'قيمة غير صحيحة لحالة جدول الطلبات';
  if (!Array.isArray(raw.days)) return 'قائمة أيام الأسبوع مطلوبة';

  for (const entry of raw.days) {
    if (!entry || typeof entry !== 'object') return 'صيغة غير صحيحة لأحد الأيام';
    const day = Number(entry.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) return 'يوم غير صحيح في الجدول';
    if (typeof entry.open !== 'boolean') return 'قيمة غير صحيحة لحالة اليوم';
    if (!entry.open) continue;

    const from = normalizeTime(entry.from);
    const to = normalizeTime(entry.to);
    if (!from || !to) return `وقت غير صحيح في ${DAY_NAMES_AR[day]}. استخدم صيغة 24 ساعة مثل 16:00`;
    if (from === to) return `وقت البداية والنهاية متطابقان في ${DAY_NAMES_AR[day]}`;
  }

  return null;
}

/**
 * The store's current day and minute-of-day.
 * Saudi Arabia has no daylight saving, so a fixed +3h offset is exact -
 * no Intl/timezone data needed (and it works the same on every Node build).
 * @param {Date} [date]
 * @returns {{ day: number, minutes: number }}
 */
export function storeClock(date = new Date()) {
  const shifted = new Date(date.getTime() + STORE_OFFSET_MINUTES * 60 * 1000);
  return {
    day: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  };
}

/** Is `minutes` inside this day's window? Handles windows that cross midnight. */
function withinWindow(entry, minutes) {
  if (!entry.open) return false;
  const from = toMinutes(entry.from);
  const to = toMinutes(entry.to);
  if (from == null || to == null || from === to) return false;
  if (from < to) return minutes >= from && minutes < to;
  // e.g. 22:00 → 02:00: open in the evening and in the early morning
  return minutes >= from || minutes < to;
}

/**
 * The window the store is inside right now, or null.
 *
 * Besides today's own window this checks ONE more case: a window on YESTERDAY
 * that crosses midnight (22:00 → 02:00) is still running in the early morning,
 * even when today itself is marked closed.
 */
function ongoingWindow(schedule, day, minutes) {
  const today = schedule.days[day];
  if (withinWindow(today, minutes)) return today;

  const yesterday = schedule.days[(day + 6) % 7];
  if (!yesterday.open) return null;
  const from = toMinutes(yesterday.from);
  const to = toMinutes(yesterday.to);
  if (from == null || to == null || from <= to) return null;
  return minutes < to ? yesterday : null;
}

/** «16:00» → «٤:٠٠ م» for the customer-facing message */
export function formatTimeAr(value) {
  const minutes = toMinutes(value);
  if (minutes == null) return String(value || '');
  const hours24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hours24 < 12 ? 'ص' : 'م';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(mins).padStart(2, '0')} ${period}`;
}

/**
 * The schedule's state right now.
 *
 * @param {object} raw - the stored schedule (any shape; it is normalized)
 * @param {Date} [date]
 * @returns {{
 *   enabled: boolean,
 *   open: boolean,
 *   schedule: object,
 *   message: string,
 *   nextOpen: { dayLabel: string, from: string, fromLabel: string, toLabel: string }|null
 * }}
 */
export function orderingStatus(raw, date = new Date()) {
  const schedule = normalizeOrderingHours(raw);
  if (!schedule.enabled) {
    return { enabled: false, open: true, schedule, message: '', nextOpen: null };
  }

  const { day, minutes } = storeClock(date);
  const current = ongoingWindow(schedule, day, minutes);
  if (current) {
    return {
      enabled: true,
      open: true,
      schedule,
      message: `الطلبات متاحة الآن حتى ${formatTimeAr(current.to)}`,
      nextOpen: null
    };
  }

  // Closed: find the next window that opens, scanning a full week. The first
  // candidate that is still ahead of us wins.
  for (let offset = 0; offset <= 7; offset += 1) {
    const entry = schedule.days[(day + offset) % 7];
    if (!entry.open) continue;

    const from = toMinutes(entry.from);
    if (from == null) continue;
    // Today only counts while its start time is still ahead (a window that
    // already ended today belongs to a later day, which the loop reaches).
    if (offset === 0 && minutes >= from) continue;

    const dayLabel = offset === 0 ? 'اليوم' : offset === 1 ? 'غداً' : DAY_NAMES_AR[entry.day];
    return {
      enabled: true,
      open: false,
      schedule,
      message: `الطلب من الموقع متاح ${dayLabel} من ${formatTimeAr(entry.from)} إلى ${formatTimeAr(entry.to)}`,
      nextOpen: {
        dayLabel,
        from: entry.from,
        fromLabel: formatTimeAr(entry.from),
        toLabel: formatTimeAr(entry.to)
      }
    };
  }

  // Enabled, but every day is closed: ordering is off until the owner opens a day.
  return {
    enabled: true,
    open: false,
    schedule,
    message: 'الطلب من الموقع متوقف حالياً. يرجى المحاولة لاحقاً.',
    nextOpen: null
  };
}
