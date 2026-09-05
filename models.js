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

  /* Which overlays a "single" plan customer picked. The plan used to cover
     exactly one, so every existing account has overlayChoice set and this
     array empty. allowedGames() reads the array first and falls back to the
     old field, which means nobody's link breaks on deploy and the array
     fills itself in the first time they touch the picker. */
  overlayChoice: { type: String, default: 'board' },
  overlayChoices: { type: [String], default: [] },

  /* Password reset. Only the HASH of the token is stored, so a leaked
     database still cannot be used to take over an account — same reasoning
     as never storing the password itself. */
  resetTokenHash: { type: String, default: null },
  resetExpires: { type: Date, default: null },

  /* The record that this person accepted the terms: when, which version,
     and where they were standing when they did it. Kept as its own fields
     rather than a bare boolean, because "they agreed" is worth nothing
     without "to what, and when". */
  terms: {
    acceptedAt: { type: Date, default: null },
    version: { type: String, default: null },
    where: { type: String, default: null },   // 'signup' | 'prompt'
  },

  /* Emails we have already sent, so a webhook that fires twice (Stripe
     retries) does not mail the customer twice. */
  sent: {
    welcome: { type: Boolean, default: false },
    trialEnding: { type: Boolean, default: false },
  },

  /* How their overlays look on stream. Set on the website, read by the
     hosted overlay page. Shape: { board:{accent,scale,bgImage,bgOpacity},
     auction:{accent,scale}, money:{accent,scale}, lastcall:{accent,scale} } */
  look: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
});

const reviewSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  ign: { type: String, default: 'anonymous' },
  stars: { type: Number, min: 1, max: 5, default: 5 },
  text: { type: String, required: true },
  approved: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

/* One document per browser that has ever loaded the site.
   The id is a random string the browser generated and kept for itself —
   there is no IP address and nothing here that identifies a person. It
   exists so "how many people" can mean people rather than page loads. */
const visitorSchema = new mongoose.Schema({
  _id: String,
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now, index: true },
  lastDay: { type: String, default: null },   // 'YYYY-MM-DD', to count days once
  views: { type: Number, default: 0 },
  email: { type: String, default: null },     // filled in if they were signed in
}, { versionKey: false });

/* One document per day. Small, permanent, and cheap to chart. */
const dayStatSchema = new mongoose.Schema({
  _id: String,                                 // 'YYYY-MM-DD' (UTC)
  views: { type: Number, default: 0 },         // page loads
  visitors: { type: Number, default: 0 },      // distinct browsers that day
  newVisitors: { type: Number, default: 0 },   // never seen before that day
}, { versionKey: false });

module.exports = {
  User: mongoose.model('User', userSchema),
  Review: mongoose.model('Review', reviewSchema),
  Visitor: mongoose.model('Visitor', visitorSchema),
  DayStat: mongoose.model('DayStat', dayStatSchema),
};
