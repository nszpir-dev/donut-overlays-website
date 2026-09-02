const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },

  stripeCustomerId: { type: String, default: null },
  stripeSubscriptionId: { type: String, default: null },

  // 'single' | 'all' | null
  plan: { type: String, default: null },

  // 'none' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid'
  status: { type: String, default: 'none' },

  trialStart: { type: Date, default: null },
  trialEnd: { type: Date, default: null },
  currentPeriodEnd: { type: Date, default: null },

  // The unguessable id that appears in their OBS / LIVE Studio link.
  // Stays the same for the life of the account so they paste it once.
  overlayToken: { type: String, unique: true, sparse: true, index: true },

  // Which single overlay a "single" plan customer picked.
  overlayChoice: { type: String, default: 'board' },
});

const reviewSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  ign: { type: String, default: 'anonymous' },
  stars: { type: Number, min: 1, max: 5, default: 5 },
  text: { type: String, required: true },
  approved: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

module.exports = {
  User: mongoose.model('User', userSchema),
  Review: mongoose.model('Review', reviewSchema),
};
