/**
 * Donut Overlays — Discord roles
 * ---------------------------------------------------------------
 * Gives a customer a role in the Discord server the moment they buy
 * something, and takes it back when they stop paying.
 *
 * WHY THERE IS NO BOT LIBRARY HERE
 * --------------------------------
 * The obvious way to do this is discord.js, which opens a permanent
 * websocket to Discord's gateway and keeps it open forever. That buys
 * you the ability to react to things happening IN the server — messages,
 * joins, commands — and none of that is wanted here. What is wanted is
 * "add this role", "remove that role", a few times a day, triggered by
 * Stripe rather than by Discord.
 *
 * For that, two ordinary HTTPS requests do the whole job. No dependency,
 * no gateway connection to keep alive on a server that is already
 * running a website, no library to break when Discord changes its
 * internals, and nothing extra to pay for or deploy. The bot account
 * exists purely to hold the permission.
 *
 * WHO IS WHO
 * ----------
 * The hard part of this is never the role, it is knowing which Discord
 * account belongs to which customer. Asking people to type their email
 * at a bot means anyone can type somebody else's. So the link is made
 * through Discord's own sign-in: the customer clicks a button on their
 * account page, Discord asks them to approve, and Discord tells us who
 * they are. Nobody can claim a purchase that is not theirs.
 *
 * WHAT IT NEEDS (all optional — with none of it set, everything else on
 * the site carries on exactly as before and this file does nothing):
 *
 *   DISCORD_CLIENT_ID       the application's id
 *   DISCORD_CLIENT_SECRET   the application's secret
 *   DISCORD_BOT_TOKEN       the bot's token
 *   DISCORD_GUILD_ID        your server's id
 *   DISCORD_ROLE_SUB        role for anyone currently paying
 *   DISCORD_ROLE_OWNER      role for anyone who bought an overlay outright
 */
const API = 'https://discord.com/api/v10';

const CFG = {
  clientId:     process.env.DISCORD_CLIENT_ID || '',
  clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  botToken:     process.env.DISCORD_BOT_TOKEN || '',
  guildId:      process.env.DISCORD_GUILD_ID || '',
  /* One role for "is a paying customer", which is what most servers
     actually want. Set this and the two below can be left empty. */
  roleCustomer: process.env.DISCORD_ROLE_CUSTOMER || '',
  /* And the finer split, for a server that wants to tell a live
     subscriber apart from somebody who bought an overlay outright.
     Optional; most people will never set these. */
  roleSub:      process.env.DISCORD_ROLE_SUB || '',
  roleOwner:    process.env.DISCORD_ROLE_OWNER || '',
};

/* Linking can work without any roles configured — some people will want
   the Discord name on the admin page and nothing more. Roles need the
   bot. Reported separately so the site can say which half is on. */
const canLink  = () => !!(CFG.clientId && CFG.clientSecret);
const canRole  = () => !!(CFG.botToken && CFG.guildId
  && (CFG.roleCustomer || CFG.roleSub || CFG.roleOwner));

/* Every call to Discord goes through here: one timeout, one place that
   knows a 429 is not an error worth shouting about, and one place that
   makes sure a Discord outage can never take the website down with it. */
async function call(path, opts = {}, ms = 8000) {
  const stop = new AbortController();
  const t = setTimeout(() => stop.abort(), ms);
  if (t.unref) t.unref();
  try {
    const res = await fetch(API + path, {
      ...opts,
      signal: stop.signal,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    return res;
  } finally { clearTimeout(t); }
}

const botHeaders = () => ({ Authorization: 'Bot ' + CFG.botToken });

/* ---------------- the sign-in half ---------------- */

/* Where to send somebody who clicked "Link Discord". `state` is signed by
   the caller and handed back by Discord untouched, which is what ties the
   answer to the account that started it — without it, anyone could call
   the callback with their own code and attach themselves to somebody
   else's account. */
function authUrl(redirectUri, state) {
  const q = new URLSearchParams({
    client_id: CFG.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'none',
  });
  return 'https://discord.com/oauth2/authorize?' + q;
}

/* Swap the one-time code for the account it belongs to. Returns
   { id, username } or { error }. */
async function whoIs(code, redirectUri) {
  if (!canLink()) return { error: 'Discord linking is not set up on this server' };
  try {
    const body = new URLSearchParams({
      client_id: CFG.clientId,
      client_secret: CFG.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const res = await call('/oauth2/token', {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!res.ok) return { error: 'Discord would not accept that sign-in (' + res.status + ')' };
    const tok = await res.json();

    const me = await call('/users/@me', { headers: { Authorization: 'Bearer ' + tok.access_token } });
    if (!me.ok) return { error: 'Discord would not say who that is (' + me.status + ')' };
    const u = await me.json();
    return { id: u.id, username: u.global_name || u.username || u.id };
  } catch (err) {
    return { error: 'could not reach Discord (' + err.message + ')' };
  }
}

/* ---------------- the roles half ---------------- */

async function setRole(discordId, roleId, on) {
  if (!discordId || !roleId) return { skipped: true };
  const path = `/guilds/${CFG.guildId}/members/${discordId}/roles/${roleId}`;
  try {
    const res = await call(path, { method: on ? 'PUT' : 'DELETE', headers: botHeaders() });
    if (res.status === 204 || res.status === 201) return { ok: true };
    /* 404 on a remove is the desired state already: they are not in the
       server, or never had the role. Not a failure. */
    if (res.status === 404 && !on) return { ok: true };
    if (res.status === 404) return { error: 'they are not in the Discord server' };
    if (res.status === 403) return { error: 'the bot cannot manage that role — move the bot\'s role above it' };
    if (res.status === 429) return { error: 'Discord is rate limiting; it will be retried on the next change' };
    return { error: 'Discord said ' + res.status };
  } catch (err) {
    return { error: 'could not reach Discord (' + err.message + ')' };
  }
}

/**
 * Make somebody's roles match what they have actually paid for.
 *
 * Called after anything that could change the answer: a purchase, a
 * cancellation, a failed card, a link. Safe to call as often as you
 * like — setting a role somebody already has is a no-op at Discord's
 * end, so there is no state to keep in step here.
 *
 * Never throws. A Discord outage must not stop a purchase being
 * recorded, and a role is the least important thing happening at that
 * moment.
 */
async function sync(user, relay) {
  if (!canRole() || !user || !user.discordId) return { skipped: true };

  /* Three rules, and any of them can point at the same role id.
  
     That last part is why this is a map rather than three calls in a
     row. Somebody setting up a single "Customer" role by putting the
     same id in two of the settings is doing an obvious thing, and
     applying the rules one after another would have the second undo the
     first: a live subscriber who owns nothing outright would be given
     the role by one rule and have it taken straight back by the next,
     ending up without it. Deciding per ROLE rather than per rule makes
     every combination safe, including the ones nobody thought of. */
  const want = new Map();
  const rule = (roleId, yes) => {
    if (!roleId) return;
    want.set(roleId, (want.get(roleId) || false) || yes);
  };
  rule(CFG.roleCustomer, relay.hasAnything(user));
  rule(CFG.roleSub,      relay.entitled(user));
  rule(CFG.roleOwner,    relay.permOf(user).length > 0);

  const out = {};
  try {
    for (const [roleId, yes] of want) out[roleId] = await setRole(user.discordId, roleId, yes);
  } catch (err) {
    return { error: err.message };
  }
  return out;
}

module.exports = { authUrl, whoIs, setRole, sync, canLink, canRole, CFG };
