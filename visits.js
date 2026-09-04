/**
 * Donut Overlays — who is on the site
 * ---------------------------------------------------------------
 * Two different questions, answered two different ways:
 *
 *   "who is on my site RIGHT NOW"  -> this file, in memory. It is a live
 *      number, it does not need to survive a restart, and writing every
 *      heartbeat to the database would be a waste of the free tier.
 *
 *   "how many people have EVER been on my site" -> the Visitor and DayStat
 *      collections in models.js, written once per page load.
 *
 * No IP addresses are stored anywhere. A visitor is identified by a random
 * id their own browser makes up and keeps — it says "this is the same
 * browser as before" and nothing else about the person.
 */

/* The browser sends a heartbeat every 25s. Allowing ~3 misses before we
   call someone gone means a slow phone or a tab that got throttled in the
   background does not flicker in and out of the list. */
const ONLINE_MS = 80 * 1000;

/* A hard ceiling so a flood — or somebody hammering /api/hit by hand —
   cannot grow this map until the server runs out of memory. Well past any
   plausible real audience for a Minecraft overlay site. */
const MAX_TRACKED = 5000;

const live = new Map();

function prune(now) {
  for (const [id, v] of live) {
    if (now - v.lastSeen > ONLINE_MS) live.delete(id);
  }
}

/**
 * Record that a browser is still here.
 * @param {string} id     the browser's own random id
 * @param {{path?:string, email?:string|null, first?:boolean}} info
 */
function touch(id, info = {}) {
  const now = Date.now();
  prune(now);
  const seen = live.get(id);
  if (!seen && live.size >= MAX_TRACKED) return;   // full: ignore newcomers
  live.set(id, {
    id,
    firstSeen: seen ? seen.firstSeen : now,
    lastSeen: now,
    path: info.path || (seen && seen.path) || '/',
    /* Only ever upgrade signed-out to signed-in. A page opened in a second
       tab before logging in should not blank out the email we already know. */
    email: info.email || (seen && seen.email) || null,
    views: (seen ? seen.views : 0) + (info.first ? 1 : 0),
  });
}

/** Everyone currently on the site, most recently arrived first. */
function online() {
  const now = Date.now();
  prune(now);
  return [...live.values()]
    .sort((a, b) => b.firstSeen - a.firstSeen)
    .map(v => ({
      email: v.email,
      path: v.path,
      views: v.views,
      forMs: now - v.firstSeen,
      idleMs: now - v.lastSeen,
    }));
}

function count() {
  prune(Date.now());
  return live.size;
}

/** Only for tests. */
function _reset() { live.clear(); }

module.exports = { touch, online, count, ONLINE_MS, MAX_TRACKED, _reset };
