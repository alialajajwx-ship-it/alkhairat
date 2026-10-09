// Chatbot usage limit — a rolling «40 messages / 24 hours» window per user.
//
// Every read prunes the timestamps that fell out of the window, so a user who
// sent 40 messages yesterday is not punished again today, and one who sent 39
// in the last hour still has 1 left.

import ChatUsage from '../models/ChatUsage.js';

export const CHAT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
export const CHAT_LIMIT = 40;                      // messages per window

/**
 * Current usage for a user.
 * @returns {Promise<{ used: number, remaining: number, limit: number,
 *                     resetsAt: Date|null }>}
 */
export async function getChatUsage(userId) {
  const since = new Date(Date.now() - CHAT_WINDOW_MS);
  const doc = await ChatUsage.findOne({ userId });

  const recent = (doc?.messages || []).filter((d) => new Date(d).getTime() > since.getTime());
  const used = recent.length;
  const oldest = used ? recent.reduce((a, b) => (new Date(a) < new Date(b) ? a : b)) : null;

  return {
    used,
    remaining: Math.max(0, CHAT_LIMIT - used),
    limit: CHAT_LIMIT,
    // When the oldest message leaves the window, one slot frees up
    resetsAt: oldest ? new Date(new Date(oldest).getTime() + CHAT_WINDOW_MS) : null
  };
}

/**
 * Record one chatbot message for a user and return the new usage.
 * The stored list is pruned to the window on every write, so it never grows
 * without bound.
 * @returns {Promise<{ used: number, remaining: number, limit: number,
 *                     resetsAt: Date|null }>}
 */
export async function recordChatMessage(userId) {
  const since = new Date(Date.now() - CHAT_WINDOW_MS);

  const doc = await ChatUsage.findOneAndUpdate(
    { userId },
    { userId },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

  const recent = (doc.messages || []).filter((d) => new Date(d).getTime() > since.getTime());
  recent.push(new Date());
  doc.messages = recent;
  await doc.save();

  const oldest = recent.reduce((a, b) => (new Date(a) < new Date(b) ? a : b));
  return {
    used: recent.length,
    remaining: Math.max(0, CHAT_LIMIT - recent.length),
    limit: CHAT_LIMIT,
    resetsAt: new Date(new Date(oldest).getTime() + CHAT_WINDOW_MS)
  };
}
