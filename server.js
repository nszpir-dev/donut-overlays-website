require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');

const { User, Review } = require('./models');
const relay = require('./relay');

const {
  PORT = 8080,
  MONGODB_URI,
  JWT_SECRET,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_SINGLE,
  STRIPE_PRICE_ALL,
  PUBLIC_URL = 'http://localhost:8080',
  DISCORD_INVITE = '',
  DISCORD_NOTIFY_WEBHOOK_URL = '',
  ADMIN_USER = 'admin',
  ADMIN_PASSWORD,
} = process.env;

// ---- sanity checks (fail loud at boot rather than acting broken later) ----
const required = { MONGODB_URI, JWT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_SINGLE, STRIPE_PRICE_ALL, ADMIN_PASSWORD };
for (const [k, v] of Object.entries(required)) {
  if (!v) console.warn(`[startup] Warning: ${k} is not set. That feature will not work until it is.`);
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const PRICE_IDS = { single: STRIPE_PRICE_SINGLE, all: STRIPE_PRICE_ALL };
const TRIAL_DAYS = 7;

const app = express();
app.set('trust proxy', 1);

// ---------------------------------------------------------------------
// Stripe webhook needs the RAW body to verify the signature, so this
// route is registered BEFORE express.json() touches the request body.
// ---------------------------------------------------------------------
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).send('stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature verification failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.client_reference_id;
        if (!userId) break;
        const user = await User.findById(userId);
        if (!user) break;
        user.stripeCustomerId = session.customer;
        user.stripeSubscriptionId = session.subscription;
        user.plan = session.metadata && session.metadata.plan ? session.metadata.plan : user.plan;
        await user.save();
        // subscription.created (below) fills in status/trialEnd; but in case it
        // races, pull it directly here too.
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          await applySubscriptionToUser(user, sub);
          await notifyNewTrial(user, sub);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = await User.findOne({ stripeCustomerId: sub.customer });
        if (!user) break;
        const wasTrialing = user.status === 'trialing';
        await applySubscriptionToUser(user, sub);
        if (!wasTrialing && sub.status === 'trialing') {
          await notifyNewTrial(user, sub);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user = await User.findOne({ stripeCustomerId: sub.customer });
        if (!user) break;
        user.status = 'canceled';
        await user.save();
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('[webhook] handler error', err);
    // Still 200 back to Stripe once we've logged it — retries won't fix a bug in our code.
  }

  res.json({ received: true });
});

/* Stripe moved current_period_end off the subscription and onto each
   subscription item in the 2025 API versions. Webhook events arrive using
   whatever API version the endpoint is on, so read both shapes. */
function periodEndOf(sub) {
  if (sub.current_period_end) return sub.current_period_end;
  const item = sub.items && sub.items.data && sub.items.data[0];
  return item && item.current_period_end ? item.current_period_end : null;
}

async function applySubscriptionToUser(user, sub) {
  user.status = sub.status; // trialing | active | past_due | canceled | unpaid ...
  user.trialStart = sub.trial_start ? new Date(sub.trial_start * 1000) : user.trialStart;
  user.trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : user.trialEnd;
  const periodEnd = periodEndOf(sub);
  user.currentPeriodEnd = periodEnd ? new Date(periodEnd * 1000) : user.currentPeriodEnd;
  await user.save();
}

async function notifyNewTrial(user, sub) {
  if (!DISCORD_NOTIFY_WEBHOOK_URL) return;
  const ends = user.trialEnd ? user.trialEnd.toDateString() : 'unknown';
  const body = {
    content: `🍩 **New free trial started**\n**${user.email}** — plan: \`${user.plan}\`\nStarted: ${new Date().toDateString()}\nEnds: ${ends}`,
  };
  try {
    await fetch(DISCORD_NOTIFY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[discord notify] failed', err.message);
  }
}

// ---------------------------------------------------------------------
// Everything else is normal JSON.
// ---------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function signToken(user) {
  return jwt.sign({ uid: user._id.toString() }, JWT_SECRET, { expiresIn: '30d' });
}

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'log in first' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(payload.uid);
    if (!user) return res.status(401).json({ error: 'log in first' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'that login has expired, log in again' });
  }
}

// ---- public config (lets the front end pick up settings without a redeploy) ----
app.get('/api/config', (req, res) => {
  res.json({ discordInvite: DISCORD_INVITE });
});

// ---- accounts ----
app.post('/api/signup', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'password needs at least 8 characters' });

    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: 'an account with that email already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, passwordHash });
    const token = signToken(user);
    res.json({ email: user.email, token });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'an account with that email already exists' });
    console.error('[signup] error', err);
    res.status(500).json({ error: 'something went wrong creating that account' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'no account with that email' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'wrong password' });
    const token = signToken(user);
    res.json({ email: user.email, token });
  } catch (err) {
    console.error('[login] error', err);
    res.status(500).json({ error: 'something went wrong logging in' });
  }
});

app.get('/api/me', auth, (req, res) => {
  const u = req.user;
  res.json({
    email: u.email,
    plan: u.plan,
    status: u.status,
    trialEnd: u.trialEnd,
    currentPeriodEnd: u.currentPeriodEnd,
  });
});

// ---- checkout ----
app.post('/api/checkout', auth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'checkout is not set up on the server yet' });
  const plan = req.body.plan;
  const priceId = PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: 'unknown plan' });

  try {
    const user = req.user;

    // Someone who already has (or has already used) a subscription on this
    // account does not get a second free trial.
    const alreadyUsedTrial = !!user.stripeSubscriptionId;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: user.stripeCustomerId ? undefined : user.email,
      customer: user.stripeCustomerId || undefined,
      client_reference_id: user._id.toString(),
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: alreadyUsedTrial ? undefined : { trial_period_days: TRIAL_DAYS },
      metadata: { plan, userId: user._id.toString() },
      allow_promotion_codes: true,
      success_url: `${PUBLIC_URL}/?checkout=success`,
      cancel_url: `${PUBLIC_URL}/?checkout=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout] error', err);
    res.status(500).json({ error: 'could not start checkout' });
  }
});

// ---------------------------------------------------------------------
// Overlays: the permanent links, and the pages themselves.
// ---------------------------------------------------------------------
const GAME_FILES = { board: 'board.html', auction: 'auction.html', money: 'money.html' };
const GAME_NAMES = { board: 'Elimination board', auction: 'Live auction', money: 'Money game' };
/* Each game's relay listens on its own port, so the control panel address
   differs per game. Showing one fixed port sent anyone running the auction
   or money game to a dead page. */
const GAME_PORTS = { board: 8090, auction: 8091, money: 8092 };

/* Made once and never changed, so a link pasted into OBS keeps working
   for the life of the account. */
async function ensureOverlayToken(user) {
  if (user.overlayToken) return user.overlayToken;
  user.overlayToken = crypto.randomBytes(8).toString('hex');
  await user.save();
  return user.overlayToken;
}

app.get('/api/links', auth, async (req, res) => {
  const user = req.user;
  const games = relay.allowedGames(user);
  if (!games.length) {
    return res.json({ active: false, games: [], links: [], panel: null });
  }
  const token = await ensureOverlayToken(user);
  res.json({
    active: true,
    plan: user.plan,
    games,
    choice: user.overlayChoice,
    /* role=display strips the operator controls, bg=transparent drops the
       background so it sits over gameplay. Both are flags the overlay
       already understands — the local version got them from its /display
       path, which the token in ours pushes out of the way. */
    links: games.map(g => ({
      game: g,
      name: GAME_NAMES[g],
      url: `${PUBLIC_URL}/o/${token}/${g}?role=display&bg=transparent`,
      panel: `http://localhost:${GAME_PORTS[g]}/`,
    })),
    download: `${PUBLIC_URL}/download/${token}/donut-overlays-launcher.zip`,
  });
});

/* The launcher download. Gated on the same token as the overlay links so
   a plain <a href> works — a browser download cannot carry an auth header,
   and a subscription that has lapsed should not still be handing out the
   software. */
app.get('/download/:token/donut-overlays-launcher.zip', async (req, res) => {
  const user = await User.findOne({ overlayToken: req.params.token });
  if (!user) return res.status(404).send(notice('That download link is not recognised.'));
  if (!relay.entitled(user)) {
    return res.status(402).send(notice(
      'This subscription is not active.',
      'Start it again at ' + PUBLIC_URL + ' and the download will work straight away.'
    ));
  }
  const file = path.join(__dirname, 'launcher', 'donut-overlays-launcher.zip');
  if (!fs.existsSync(file)) {
    return res.status(500).send(notice('The launcher has not been uploaded to the server yet.'));
  }
  res.download(file, 'donut-overlays-launcher.zip');
});

/* Someone on the single-overlay plan swapping which one they use. */
app.post('/api/choose-overlay', auth, async (req, res) => {
  const game = String(req.body.game || '');
  if (!relay.GAMES.includes(game)) return res.status(400).json({ error: 'unknown overlay' });
  if (req.user.plan !== 'single') {
    return res.status(400).json({ error: 'your plan already includes every overlay' });
  }
  req.user.overlayChoice = game;
  await req.user.save();
  res.json({ ok: true, choice: game });
});

/* The page OBS / LIVE Studio actually loads. This is the whole reason
   the relay routes through us: if the subscription has lapsed, this
   returns a notice instead of the overlay, and there is nothing on the
   customer's machine that can serve it instead. */
app.get('/o/:token/:game', async (req, res) => {
  const { token, game } = req.params;
  if (!relay.GAMES.includes(game)) return res.status(404).send(notice('That overlay does not exist.'));

  const user = await User.findOne({ overlayToken: token });
  if (!user) return res.status(404).send(notice('This overlay link is not recognised.'));

  if (!relay.entitled(user)) {
    return res.status(402).send(notice(
      'This subscription is not active.',
      'Start it again at ' + PUBLIC_URL + ' and this link will start working immediately — it never changes.'
    ));
  }
  if (!relay.allowedGames(user).includes(game)) {
    return res.status(403).send(notice(
      'Your plan does not include this overlay.',
      'The single-overlay plan covers one game at a time. Switch which one, or move to the all-three plan, on the website.'
    ));
  }

  const file = path.join(__dirname, 'overlays', GAME_FILES[game]);
  if (!fs.existsSync(file)) {
    return res.status(500).send(notice('That overlay has not been uploaded to the server yet.'));
  }

  /* The overlay works out its own WebSocket address from location.origin,
     which would point at the bare domain with no idea whose board to show.
     Handing it an explicit address keeps that file otherwise untouched. */
  const wsBase = PUBLIC_URL.replace(/^http/, 'ws');
  const inject = `<script>window.__OVERLAY_WS=${JSON.stringify(`${wsBase}/view?t=${token}&g=${game}`)};</script>`;
  let html = fs.readFileSync(file, 'utf8');
  html = html.includes('</head>')
    ? html.replace('</head>', inject + '</head>')
    : inject + html;

  res.set('Cache-Control', 'no-store');
  res.send(html);
});

function notice(title, detail) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Donut Overlays</title>
  <style>body{margin:0;height:100vh;display:grid;place-items:center;background:#060912;color:#eaf1ff;
  font:16px/1.6 system-ui,sans-serif;text-align:center;padding:2rem}
  .box{max-width:34rem}h1{font-size:1.4rem;margin:0 0 .6rem}p{color:#93a6c4;margin:0}</style></head>
  <body><div class="box"><h1>${esc(title)}</h1>${detail ? `<p>${esc(detail)}</p>` : ''}</div></body></html>`;
}

// ---- billing portal ----
// Stripe's own hosted page. Customers change card, switch plan or cancel
// there, and the resulting subscription.updated / .deleted webhook keeps
// our copy of their status in step. Saves us building any of that.
app.post('/api/portal', auth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'billing is not set up on the server yet' });
  const user = req.user;
  if (!user.stripeCustomerId) {
    return res.status(400).json({ error: 'there is no subscription on this account yet' });
  }
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: PUBLIC_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[portal] error', err);
    res.status(500).json({
      error: err.message && /configuration/i.test(err.message)
        ? 'the Stripe customer portal has not been switched on yet'
        : 'could not open the billing page',
    });
  }
});

// ---- reviews ----
app.get('/api/reviews', async (req, res) => {
  const reviews = await Review.find({ approved: true }).sort({ createdAt: -1 }).limit(20).lean();
  res.json({ reviews: reviews.map(r => ({ ign: r.ign, stars: r.stars, text: r.text })) });
});

app.post('/api/reviews', auth, async (req, res) => {
  const text = String(req.body.text || '').trim();
  const ign = String(req.body.ign || 'anonymous').trim().slice(0, 24) || 'anonymous';
  const stars = Math.min(5, Math.max(1, Number(req.body.stars) || 5));
  if (text.length < 10) return res.status(400).json({ error: 'say a bit more than that' });
  await Review.create({ userId: req.user._id, ign, stars, text: text.slice(0, 600) });
  res.json({ ok: true, pending: true });
});

// ---------------------------------------------------------------------
// Admin — simple HTTP Basic Auth in front of a couple of server-rendered
// pages. No separate login system; just one shared password.
// ---------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASSWORD && ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="donut overlays admin"');
  return res.status(401).send('Auth required');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(d) {
  return d ? new Date(d).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC' : '—';
}

app.get('/admin', requireAdmin, async (req, res) => {
  const users = await User.find({}).sort({ createdAt: -1 }).lean();

  const count = s => users.filter(u => u.status === s).length;
  const trialing = count('trialing');
  const active = count('active');
  const canceled = count('canceled');
  const problem = count('past_due') + count('unpaid');
  const noPlan = users.filter(u => !u.status || u.status === 'none').length;

  // What the active subscriptions are worth per month, at list price.
  // Trials are not counted — nobody has paid for those yet.
  const PRICE = { single: 8, all: 12 };
  const mrr = users
    .filter(u => u.status === 'active')
    .reduce((sum, u) => sum + (PRICE[u.plan] || 0), 0);
  const trialValue = users
    .filter(u => u.status === 'trialing')
    .reduce((sum, u) => sum + (PRICE[u.plan] || 0), 0);

  const tile = (label, value, cls, sub) => `
    <div class="tile ${cls || ''}">
      <div class="tile-n">${value}</div>
      <div class="tile-l">${label}</div>
      ${sub ? `<div class="tile-s">${sub}</div>` : ''}
    </div>`;

  const rows = users.map(u => `
    <tr>
      <td>${esc(u.email)}</td>
      <td><span class="pill ${esc(u.status)}">${esc(u.status || 'none')}</span></td>
      <td>${esc(u.plan || '—')}</td>
      <td>${fmtDate(u.trialStart)}</td>
      <td>${fmtDate(u.trialEnd)}</td>
      <td>${fmtDate(u.currentPeriodEnd)}</td>
      <td>${fmtDate(u.createdAt)}</td>
    </tr>`).join('');

  res.send(adminLayout('Users & trials', `
    <div class="tiles">
      ${tile('On free trial', trialing, 'gold', trialValue ? '$' + trialValue + '/mo if they all convert' : '')}
      ${tile('Paying now', active, 'green', '$' + mrr + '/mo')}
      ${tile('Cancelled', canceled, 'red')}
      ${tile('Payment problems', problem, problem ? 'red' : '')}
      ${tile('Signed up, no plan', noPlan)}
      ${tile('Accounts total', users.length)}
    </div>
    <p class="muted">Every date below comes straight from Stripe, not from our own guesswork.</p>
    <table>
      <thead><tr><th>Email</th><th>Status</th><th>Plan</th><th>Trial started</th><th>Trial ends</th><th>Renews / ended</th><th>Signed up</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">No accounts yet.</td></tr>'}</tbody>
    </table>
  `));
});

app.get('/admin/reviews', requireAdmin, async (req, res) => {
  const pending = await Review.find({ approved: false }).sort({ createdAt: -1 }).lean();
  const approved = await Review.find({ approved: true }).sort({ createdAt: -1 }).limit(20).lean();
  const row = (r, showApprove) => `
    <tr>
      <td>${esc(r.ign)}</td>
      <td>${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</td>
      <td>${esc(r.text)}</td>
      <td>${fmtDate(r.createdAt)}</td>
      <td>
        ${showApprove ? `<form method="post" action="/admin/reviews/${r._id}/approve" style="display:inline"><button>Approve</button></form>` : ''}
        <form method="post" action="/admin/reviews/${r._id}/delete" style="display:inline"><button>Delete</button></form>
      </td>
    </tr>`;
  res.send(adminLayout('Reviews', `
    <h3>Pending (${pending.length})</h3>
    <table><thead><tr><th>Name</th><th>Stars</th><th>Text</th><th>Sent</th><th></th></tr></thead>
    <tbody>${pending.map(r => row(r, true)).join('') || '<tr><td colspan="5" class="muted">Nothing waiting.</td></tr>'}</tbody></table>
    <h3 style="margin-top:2rem">Live on the site</h3>
    <table><thead><tr><th>Name</th><th>Stars</th><th>Text</th><th>Sent</th><th></th></tr></thead>
    <tbody>${approved.map(r => row(r, false)).join('') || '<tr><td colspan="5" class="muted">None yet.</td></tr>'}</tbody></table>
  `));
});

app.post('/admin/reviews/:id/approve', requireAdmin, async (req, res) => {
  await Review.findByIdAndUpdate(req.params.id, { approved: true });
  res.redirect('/admin/reviews');
});
app.post('/admin/reviews/:id/delete', requireAdmin, async (req, res) => {
  await Review.findByIdAndDelete(req.params.id);
  res.redirect('/admin/reviews');
});

function adminLayout(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — Donut Overlays admin</title>
  <style>
    body{background:#0b0f18;color:#eaf1ff;font:15px/1.5 system-ui,sans-serif;margin:0;padding:2rem}
    a{color:#19e3c8}
    table{border-collapse:collapse;width:100%;margin-top:1rem}
    th,td{padding:.5rem .7rem;border-bottom:1px solid #22304a;text-align:left;vertical-align:top}
    th{color:#93a6c4;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
    .muted{color:#93a6c4}
    .pill{padding:.15rem .5rem;border-radius:1rem;font-size:.8rem;background:#182437}
    .pill.trialing{background:#3a3311;color:#ffc93c}
    .pill.active{background:#0f3320;color:#5be89a}
    .pill.canceled,.pill.past_due,.pill.unpaid{background:#3a1414;color:#ff8f8f}
    .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));gap:.8rem;margin:1.2rem 0 1.6rem}
    .tile{background:#111a2b;border:1px solid #22304a;border-radius:.6rem;padding:.9rem 1rem}
    .tile-n{font-size:2rem;font-weight:800;line-height:1.1}
    .tile-l{font-size:.78rem;color:#93a6c4;text-transform:uppercase;letter-spacing:.05em;margin-top:.15rem}
    .tile-s{font-size:.75rem;color:#6d7f9c;margin-top:.35rem}
    .tile.gold .tile-n{color:#ffc93c}
    .tile.green .tile-n{color:#5be89a}
    .tile.red .tile-n{color:#ff8f8f}
    nav{margin-bottom:1rem}
    nav a{margin-right:1.2rem;font-weight:700}
    button{background:#182437;color:#eaf1ff;border:1px solid #22304a;border-radius:.4rem;padding:.35rem .6rem;cursor:pointer}
    button:hover{border-color:#19e3c8}
    h1{font-size:1.4rem}
  </style></head><body>
  <nav><a href="/admin">Users &amp; trials</a><a href="/admin/reviews">Reviews</a><a href="/">← back to site</a></nav>
  <h1>${esc(title)}</h1>
  ${body}
  </body></html>`;
}

// ---- boot ----
async function main() {
  if (MONGODB_URI) {
    await mongoose.connect(MONGODB_URI);
    console.log('[startup] connected to MongoDB');
  } else {
    console.warn('[startup] no MONGODB_URI set — accounts/reviews will fail until it is.');
  }
  const server = http.createServer(app);
  relay.setup(server, { jwtSecret: JWT_SECRET });
  server.listen(PORT, () => console.log(`[startup] listening on :${PORT}`));
}
main();
