import mongoose from 'mongoose';

/**
 * A message a signed-in customer sent from the «تواصل معنا» page.
 *
 * The owner reads every message on the «رسائل العملاء» page and also gets a
 * WhatsApp notice the moment one arrives. The customer may send at most three
 * messages per hour (enforced in the route by counting recent documents).
 */
const contactMessageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    // Optional subject the customer can add above the message body
    topic: { type: String, default: '', trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 2000 }
  },
  { timestamps: true }
);

// Newest first is the only order the owner page uses
contactMessageSchema.index({ createdAt: -1 });

const ContactMessage = mongoose.model('ContactMessage', contactMessageSchema);

export default ContactMessage;
