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

  /* Overlays bought outright. These do NOT expire and are never removed
     by a cancelled or failed subscription — somebody who paid once owns
     the thing, and taking it back because a later card failed would be
     the single worst bug this site could have. */
  perm: { type: [String], default: [] },

  /* When each of those was granted, keyed by game id. Kept alongside the
     list rather than replacing it, so every existing account and every
     line of code that reads `perm` as a plain list keeps working — an
     entry with no date here simply shows as an unknown age. */
  permSince: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

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

/* Every completed purchase, one row each. The admin page used to work
   this out by looking at who currently had a subscription, which meant a
   one-time payment was invisible and a cancelled customer erased their
   own history. Money that came in is a fact; it gets its own record. */
const purchaseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  email: { type: String, default: '' },
  /* 'perm1' | 'perm3' | 'sub' */
  kind: { type: String, required: true },
  games: { type: [String], default: [] },
  /* Whole US dollars, stored as charged rather than looked up later —
     a price change must never rewrite what somebody actually paid. */
  amountUsd: { type: Number, default: 0 },
  /* Stripe's session id, unique so a webhook Stripe retries three times
     cannot record the same payment three times. */
  stripeSessionId: { type: String, unique: true, sparse: true },
  createdAt: { type: Date, default: Date.now, index: true },
});

module.exports = {
  Purchase: mongoose.model('Purchase', purchaseSchema),
  User: mongoose.model('User', userSchema),
  Review: mongoose.model('Review', reviewSchema),
  Visitor: mongoose.model('Visitor', visitorSchema),
  DayStat: mongoose.model('DayStat', dayStatSchema),
};
