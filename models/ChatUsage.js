import mongoose from 'mongoose';

/**
 * Chatbot usage per user — powers the rolling «40 رسائل / 24 ساعة» limit.
 *
 * One document per user holding the timestamps of the messages sent in the
 * window. Old timestamps are pruned on every read, so the window is a true
 * rolling 24 hours rather than a fixed calendar bucket.
 */
const chatUsageSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },
  // Timestamps of the chatbot messages inside the rolling window
  messages: {
    type: [Date],
    default: []
  }
}, {
  timestamps: true
});

const ChatUsage = mongoose.model('ChatUsage', chatUsageSchema);

export default ChatUsage;
