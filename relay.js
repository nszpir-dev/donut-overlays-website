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

const GAMES = ['board', 'auction', 'money'];

/* past_due gets in: their card failed but Stripe is still retrying, and
   cutting a live stream dead over a temporary billing hiccup would be a
   worse experience than a few days of grace. */
function entitled(user) {
  return user && ['trialing', 'active', 'past_due'].includes(user.status);
}

function allowedGames(user) {
  if (!entitled(user)) return [];
  if (user.plan === 'all') return GAMES.slice();
  if (user.plan === 'single') return [GAMES.includes(user.overlayChoice) ? user.overlayChoice : 'board'];
  return [];
}

/**
 * One hub per streamer. Holds their launcher connection, everyone
 * currently watching, and the last state we saw so a browser source
 * that opens mid-round paints immediately instead of sitting blank.
 */
const hubs = new Map(); // userId -> { uplink, viewers:Set, last:Map<game,string> }

function hubFor(userId) {
  let h = hubs.get(userId);
  if (!h) {
    h = { uplink: null, viewers: new Set(), last: new Map() };
    hubs.set(userId, h);
  }
  return h;
}

function dropHubIfEmpty(userId) {
  const h = hubs.get(userId);
  if (h && !h.uplink && h.viewers.size === 0) hubs.delete(userId);
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
        if (!entitled(user)) return socket.destroy();

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
  if (h.uplink && h.uplink !== ws) {
    // Second launcher for the same account — the newest wins, so a
    // crashed-and-restarted launcher takes over cleanly.
    try { h.uplink.close(4000, 'replaced by a newer launcher'); } catch {}
  }
  h.uplink = ws;
  ws._userId = id;
  console.log(`[relay] launcher connected for ${user.email}`);

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t !== 'state' || !m.game) return;
    if (!allowedGames(user).includes(m.game)) return;

    const text = JSON.stringify({ t: 'state', s: m.s });
    h.last.set(m.game, text);
    for (const v of h.viewers) {
      if (v.readyState === 1 && v._game === m.game) v.send(text);
    }
  });

  ws.on('close', () => {
    if (h.uplink === ws) h.uplink = null;
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

/* Every few minutes, hang up on anyone whose subscription has since
   lapsed. Without this a stream started during a trial would keep
   running for as long as the browser stayed open. */
async function recheckLive() {
  if (hubs.size === 0) return;
  for (const [userId, h] of hubs) {
    try {
      const user = await User.findById(userId);
      if (entitled(user)) continue;
      console.log('[relay] cutting off lapsed subscription', userId);
      if (h.uplink) try { h.uplink.close(4001, 'subscription is no longer active'); } catch {}
      for (const v of h.viewers) try { v.close(4001, 'subscription is no longer active'); } catch {}
      hubs.delete(userId);
    } catch (err) {
      console.error('[relay] recheck failed', err.message);
    }
  }
}

module.exports = { setup, entitled, allowedGames, GAMES };
