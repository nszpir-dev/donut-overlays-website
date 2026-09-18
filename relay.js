/**
 * Donut Overlays — relay hub
 * ---------------------------------------------------------------
 * The game still runs on the streamer's own PC, exactly as before, so
 * a payment still hits their screen in about a tenth of a second. This
 * file is only the pipe in the middle:
 *
 *   launcher (their PC)  --uplink-->  us  --fan out-->  overlay pages
 *
 * Why bother routing through here at all, when the old version served
 * the overlay straight off their machine?
 *
 *   1. Their OBS / LIVE Studio link never changes. The old cloudflared
 *      tunnel handed out a new random address every single run.
 *   2. Cancelling actually cancels. The overlay page is served by us,
 *      so when a subscription lapses the page simply stops loading.
 *      When it was served from their PC there was no way to stop them.
 *
 * Viewers are strictly read-only, mirroring the isLocal() rule in the
 * original local relay: an overlay page can watch, never command.
 */
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { User } = require('./models');

const GAMES = ['board', 'auction', 'money', 'lastcall', 'wheel'];

/* The four that existed when "all overlays, forever" first went on sale.
   Anyone whose outright purchase covers all of these bought the whole set
   as it stood, and owns what has been added since — see permOf. */
const CORE = ['board', 'auction', 'money', 'lastcall'];

/* past_due gets in: their card failed but Stripe is still retrying, and
   cutting a live stream dead over a temporary billing hiccup would be a
   worse experience than a few days of grace. */
function entitled(user) {
  return user && ['trialing', 'active', 'past_due'].includes(user.status);
}

/* What each thing you can buy covers. One table, read by the website, the
   server and the relay, so they can never disagree about how many
   overlays a purchase is worth. */
const OPTIONS = {
  /* picks: null means the option covers every overlay, so there is
     nothing to choose and nothing to carry in the checkout metadata. */
  perm1:   { picks: 1,    usd: 12, once: true,  label: 'One overlay, forever' },
  /* The $25 option used to cover every overlay there was. It now covers
     three of your choosing. Everyone who bought it under the old terms
     keeps what they paid for — see permOf below, which is where that is
     actually enforced rather than merely intended. */
  permall: { picks: 3,    usd: 25, once: true,  label: 'Three overlays, forever' },
  sub:     { picks: null, usd: 5,  once: false, label: 'Everything, monthly' },
};

/* Which overlays a completed purchase should grant. An option with no
   picks covers the lot, so it does not depend on the browser having sent
   a list — a missing metadata field would otherwise grant nothing to
   somebody who just paid $25. */
function gamesFor(option, picked) {
  const spec = OPTIONS[option];
  if (!spec) return [];
  if (spec.picks == null) return GAMES.slice();

  const out = [];
  for (const g of (picked || [])) {
    if (GAMES.includes(g) && !out.includes(g) && out.length < spec.picks) out.push(g);
  }

  /* Never hand back fewer overlays than were paid for.
  
     This used to be safe by accident: the $25 option covered everything,
     so it ignored the list entirely and a lost or truncated metadata
     field could not cost anybody anything. Now that it is pick-three,
     an empty list would mean somebody pays $25 and is granted nothing —
     the single worst outcome this code has, and one that would only
     surface as an angry message hours later.
  
     Stripe metadata is a string map with size limits and it travels
     through a webhook that can be replayed, so "the list will always be
     there" is an assumption, not a fact. When it is short, top it up in
     the order the site lists them. Over-granting by a game is a mistake
     anybody can live with; under-granting a paying customer is not.
     Either way the picks are validated at checkout, so this is a last
     resort rather than a normal path. */
  for (const g of GAMES) {
    if (out.length >= spec.picks) break;
    if (!out.includes(g)) out.push(g);
  }
  return GAMES.filter(g => out.includes(g));
}

/* Overlays somebody owns outright. Deliberately does NOT look at their
   subscription status: a cancelled card must never take away a thing
   that was already paid for. */
/* When the $25 option stopped meaning "every overlay". Anything granted
   on or after this is a pick-three bundle; anything before it, or with no
   date recorded at all, predates the change. Undated counts as old on
   purpose: permSince was added after some grants had already happened,
   and the only accounts with gaps in it are older than this date by
   definition. */
const BUNDLE_CHANGED = Date.parse('2026-09-16T00:00:00Z');

function ownedAllBefore(user, when) {
  const since = (user && user.permSince) || {};
  return CORE.every(g => {
    const t = Date.parse(since[g]);
    return !Number.isFinite(t) || t < when;
  });
}

function permOf(user) {
  const out = [];
  for (const g of (user.perm || [])) {
    if (GAMES.includes(g) && !out.includes(g)) out.push(g);
  }
  /* Somebody who paid $25 for every overlay there was owns the ones
     added since. Without this, two people who paid the same $25 for the
     same thing end up owning different things depending on which side of
     a release they bought on — which is not a rule anyone would agree to
     out loud, and is the sort of thing customers find out about from
     each other rather than from you.
     
     The date matters now. While $25 meant "all of them", owning all four
     core overlays could only mean you had bought that, so the test was
     simply "owns all four". Since $25 became "pick three", the same four
     can be assembled from a bundle plus a single — and letting THAT
     collect every future overlay free would be giving away, for $37, a
     thing that is not for sale at any price. So the grandfather clause is
     pinned to the people it was written for: those who already owned the
     set before the change. */
  if (CORE.every(g => out.includes(g)) && ownedAllBefore(user, BUNDLE_CHANGED)) return GAMES.slice();
  return out;
}

/* Overlays their SUBSCRIPTION covers, if it is currently live. The old
   two-tier plans are still honoured: 'single' accounts made before the
   change keep the ones they chose, everything else gets the lot. */
function subGames(user) {
  if (!entitled(user)) return [];
  if (user.plan === 'single') {
    const raw = Array.isArray(user.overlayChoices) && user.overlayChoices.length
      ? user.overlayChoices : [user.overlayChoice];
    const out = [];
    for (const g of raw) if (GAMES.includes(g) && !out.includes(g)) out.push(g);
    return out.length ? out.slice(0, 2) : ['board'];
  }
  return GAMES.slice();
}

function allowedGames(user) {
  if (!user) return [];
  const out = permOf(user);
  for (const g of subGames(user)) if (!out.includes(g)) out.push(g);
  /* Order them the way the site lists them, so somebody who bought two
     overlays a month apart does not see them in a random order. */
  return GAMES.filter(g => out.includes(g));
}

/* The control panel port a running launcher reported for one game, or
   null if none is connected. The website falls back to the standard port
   when this is null, which is right: with nothing running there is
   nothing to correct, and the usual number is the best guess. */
function panelPort(userId, game) {
  const h = hubs.get(String(userId));
  const p = h && h.ports ? h.ports.get(game) : null;
  return p || null;
}

/* Does this account have anything at all? Used to decide whether to show
   the setup panel. Owning one overlay outright counts, even with no
   subscription and never having had one. */
function hasAnything(user) {
  return allowedGames(user).length > 0;
}
/* Same function under a short local name, so every gate in this file
   reads the same and nobody has to remember which one is correct. */
const relayHasAnything = hasAnything;

/**
 * One hub per streamer. Holds their launcher connection, everyone
 * currently watching, and the last state we saw so a browser source
 * that opens mid-round paints immediately instead of sitting blank.
 */
/* One connection per GAME, not per account.
 *
 * It used to be one per account, and the newest always won. That was
 * right when every overlay read the same Minecraft chat and running two
 * at once was a mistake worth stopping. The Follow Reel reads TikTok
 * instead, so running it alongside a board is an ordinary thing to want —
 * and under the old rule the second launcher silently knocked the first
 * one's hosted link offline.
 *
 * Still exactly one launcher per game, though. Two windows both pushing
 * the board would have the overlay flicking between two different rounds,
 * so for a single game the newest still wins.
 */
const hubs = new Map(); // userId -> { links:Set<ws>, owners:Map<game,ws>, viewers:Set, last:Map<game,string> }

function hubFor(userId) {
  let h = hubs.get(userId);
  if (!h) {
    h = { links: new Set(), owners: new Map(), viewers: new Set(), last: new Map(), ports: new Map() };
    hubs.set(userId, h);
  }
  return h;
}

function dropHubIfEmpty(userId) {
  const h = hubs.get(userId);
  if (h && h.links.size === 0 && h.viewers.size === 0) hubs.delete(userId);
}

function setup(server, { jwtSecret }) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return socket.destroy(); }

    const path = url.pathname;
    if (path !== '/relay' && path !== '/view') return socket.destroy();

    try {
      if (path === '/relay') {
        // The launcher on the streamer's PC, proving who it is with the
        // same login token the website issues.
        const token = url.searchParams.get('token');
        if (!token) return socket.destroy();
        let payload;
        try { payload = jwt.verify(token, jwtSecret); }
        catch { return socket.destroy(); }

        const user = await User.findById(payload.uid);
        /* hasAnything, not entitled: somebody who bought an overlay
           outright has no subscription at all, and gating the launcher on
           one meant their software could never connect — the overlay page
           worked and the thing feeding it did not. */
        if (!relayHasAnything(user)) return socket.destroy();

        wss.handleUpgrade(req, socket, head, ws => {
          attachUplink(ws, user);
        });
        return;
      }

      // A browser source. Identified only by the token in its URL, and
      // never trusted to send anything.
      const t = url.searchParams.get('t');
      const game = url.searchParams.get('g') || 'board';
      if (!t) return socket.destroy();
      const user = await User.findOne({ overlayToken: t });
      if (!user || !allowedGames(user).includes(game)) return socket.destroy();

      wss.handleUpgrade(req, socket, head, ws => {
        attachViewer(ws, user, game);
      });
    } catch (err) {
      console.error('[relay] upgrade failed', err.message);
      try { socket.destroy(); } catch {}
    }
  });

  // A lapsed subscription should not keep streaming just because the
  // connection was opened while it was still valid.
  setInterval(recheckLive, 5 * 60 * 1000).unref();
}

function attachUplink(ws, user) {
  const id = user._id.toString();
  const h = hubFor(id);
  /* Which game this launcher is running is not known yet — it arrives
     with the first push — so nothing is claimed here. */
  h.links.add(ws);
  ws._userId = id;
  ws._games = new Set();
  console.log(`[relay] launcher connected for ${user.email}`);

  /* Each game broadcasts a differently shaped message — the board sends
     {s}, the auction {a,s}, the money game {m,s,payout,yourCut}. Rather
     than teach this hub all three, the launcher sends the exact object
     its own overlay expects and we pass it straight through. */
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t !== 'up' || !m.game || !m.payload) return;

    /* The launcher tells us which port it actually ended up on. It is
       normally the standard one, but if something else on that PC had
       taken it the launcher moved — and the account page was still
       printing the old number, which answers somebody else's error page.
       Range-checked because it arrives over the wire. */
    const p = Number(m.port);
    if (Number.isInteger(p) && p > 0 && p < 65536) h.ports.set(m.game, p);
    if (!allowedGames(user).includes(m.game)) return;

    /* Claim this game on the first push. Whoever pushed it last owns it,
       so a launcher that crashed and was restarted takes its own game
       back — while a launcher running a DIFFERENT game carries on
       untouched, which is the whole point of the change. */
    const owner = h.owners.get(m.game);
    if (owner && owner !== ws) {
      try { owner.close(4000, 'replaced by a newer launcher'); } catch {}
    }
    if (owner !== ws) {
      h.owners.set(m.game, ws);
      ws._games.add(m.game);
      console.log(`[relay] ${user.email} is now pushing ${m.game}`);
    }

    let text;
    try { text = JSON.stringify(m.payload); } catch { return; }
    h.last.set(m.game, text);
    for (const v of h.viewers) {
      if (v.readyState === 1 && v._game === m.game) v.send(text);
    }
  });

  ws.on('close', () => {
    h.links.delete(ws);
    /* Only give up the games this socket actually held. Deleting by value
       rather than clearing the map matters: another launcher may be
       holding a different game on the same account right now. */
    for (const [game, owner] of h.owners) if (owner === ws) h.owners.delete(game);
    console.log(`[relay] launcher disconnected for ${user.email}`);
    dropHubIfEmpty(id);
  });
}

function attachViewer(ws, user, game) {
  const id = user._id.toString();
  const h = hubFor(id);
  ws._game = game;
  ws._userId = id;
  h.viewers.add(ws);

  // Paint straight away if a round is already in progress.
  const last = h.last.get(game);
  if (last) ws.send(last);

  // Viewers are watchers. Anything they send is dropped on the floor —
  // the same rule the local relay enforced with isLocal().
  ws.on('message', () => {});
  ws.on('close', () => {
    h.viewers.delete(ws);
    dropHubIfEmpty(id);
  });
}

/* Every few minutes, hang up on anyone who has nothing left. Without
   this a stream started during a trial would keep running for as long as
   the browser stayed open.

   Checked against everything they have, not just the subscription — an
   owned overlay must survive a cancellation, and cutting somebody off
   mid-stream over a subscription they never had would be the worst
   version of this bug. */
async function recheckLive() {
  if (hubs.size === 0) return;
  for (const [userId, h] of hubs) {
    try {
      const user = await User.findById(userId);
      if (relayHasAnything(user)) continue;
      console.log('[relay] cutting off, nothing left on this account', userId);
      for (const l of h.links) try { l.close(4001, 'nothing active on this account'); } catch {}
      for (const v of h.viewers) try { v.close(4001, 'nothing active on this account'); } catch {}
      hubs.delete(userId);
    } catch (err) {
      console.error('[relay] recheck failed', err.message);
    }
  }
}

module.exports = { setup, entitled, ownedAllBefore, BUNDLE_CHANGED, allowedGames, permOf, subGames, hasAnything, gamesFor, panelPort, OPTIONS, GAMES, CORE };
