/**
 * Donut Overlays — uplink
 * ---------------------------------------------------------------
 * Bolt-on for the existing game relays. It does not touch how the game
 * runs: the round still plays out here on this PC, so a payment still
 * reaches the screen in about a tenth of a second.
 *
 * All this adds is an outbound connection to donutoverlays.com that
 * mirrors the game state up, so the streamer's permanent overlay link
 * shows what is happening on this machine.
 *
 * Outbound only — nothing has to be opened on the customer's router,
 * and there is no tunnel handing out a new address every run.
 *
 * Usage from inside a relay:
 *     const uplink = require('./uplink');
 *     const up = uplink.start({ game: 'board', getState: () => S });
 *     ...  up.push();      // whenever state changed
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
/* The real `ws` if it is installed, otherwise the small built-in one —
   see ws-lite.js. A missing npm should never stop a stream. */
let WebSocket;
try { WebSocket = require('ws'); }
catch { ({ WebSocket } = require('./ws-lite')); }

const SITE = process.env.DONUT_SITE || 'https://donutoverlays.com';
const CONF = path.join(os.homedir(), '.donut-overlays.json');

const say = t => console.log(`  ${new Date().toLocaleTimeString([], { hour12: false })}  ${t}`);

/* ---------------- saved login ---------------- */
function readConf() {
  try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { return {}; }
}
function writeConf(o) {
  try {
    fs.writeFileSync(CONF, JSON.stringify(o, null, 2), { mode: 0o600 });
  } catch (e) {
    say('could not save your login: ' + e.message);
  }
}

/* One readline interface for the whole sign-in. Creating a fresh one per
   question, and hand-rolling the masking with an extra stdin listener,
   ate the Enter key and then left input in a state that accepted nothing.
   Overriding readline's own echo is the supported way to hide a password. */
function prompt(rl, question, hidden) {
  return new Promise(resolve => {
    if (!hidden) return rl.question(question, a => resolve(a.trim()));

    const original = rl._writeToOutput;
    /* Redraw the line as asterisks on every keystroke. Hiding the typing
       completely looks identical to a frozen prompt, which is worse than
       useless — you need to see that the keyboard is doing something.
       Redrawing from rl.line (rather than appending a star per key) means
       backspace behaves properly too. */
    rl._writeToOutput = function () {
      readline.cursorTo(rl.output, 0);
      readline.clearLine(rl.output, 0);
      original.call(rl, question + '*'.repeat(rl.line.length));
    };
    rl.question(question, a => {
      rl._writeToOutput = original;
      rl.output.write('\n');
      resolve(a.trim());
    });
  });
}

async function api(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(SITE + pathname, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `server said ${res.status}`);
  return data;
}

/* ---------------- sign in ---------------- */
async function signIn() {
  const conf = readConf();

  if (conf.token) {
    try {
      const links = await api('/api/links', { token: conf.token });
      if (links.active) return { token: conf.token, links };
      say('that account has no active plan right now.');
    } catch (e) {
      say('saved login no longer works (' + e.message + ')');
    }
  }

  console.log('');
  console.log('  Sign in with your Donut Overlays account.');
  console.log('  (the same email and password you use on ' + SITE + ')');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const email = await prompt(rl, '  Email:    ');
      const password = await prompt(rl, '  Password: ', true);

      if (!email || !password) {
        say('both boxes are needed — try again.');
        console.log('');
        continue;
      }

      try {
        const me = await api('/api/login', { method: 'POST', body: { email, password } });
        const links = await api('/api/links', { token: me.token });
        writeConf({ token: me.token, email: me.email });
        if (!links.active) {
          console.log('');
          say('signed in, but there is no active plan on this account.');
          say('start a free trial at ' + SITE + ' and run this again.');
          return null;
        }
        return { token: me.token, links };
      } catch (e) {
        say(e.message);
        console.log('');
      }
    }
  } finally {
    rl.close();
  }
  return null;
}

/* ---------------- the uplink itself ----------------
   Signing in has to finish BEFORE the game server starts, or the relay's
   startup banner prints straight over the "Email:" prompt and it looks
   like the launcher has hung. So it is split in two: begin() asks the
   questions while nothing else is writing to the screen, then attach()
   is called later by the relay and never prompts. */
let session = null;   // { token, links } once signed in

function useSession(s){ session = s; }

async function begin(game, already) {
  const signedIn = already || await signIn();
  if (!signedIn) {
    console.log('');
    say('running locally only — your permanent overlay link will not update.');
    return false;
  }
  session = signedIn;

  const mine = signedIn.links.links.find(l => l.game === game);
  console.log('');
  if (!mine) {
    say(`your plan does not include the ${game} overlay.`);
    say('pick which one you want at ' + SITE);
    session = null;
    return false;
  }
  console.log('  ------------------------------------------------------------');
  console.log('  Your permanent overlay link — paste this into');
  console.log('  TikTok LIVE Studio or OBS once and never again:');
  console.log('');
  console.log('      ' + mine.url);
  console.log('');
  console.log('  It is the same link every stream. Keep this window open.');
  console.log('  ------------------------------------------------------------');
  console.log('');
  return true;
}

function attach({ game, getPayload, getPort, onCut }) {
  const state = { ws: null, token: session && session.token, stop: false, lastSent: '' };

  if (!state.token) {
    // Started without signing in (running donut-relay.js directly).
    // Everything local still works; only the hosted link is missing.
    return { push() {} };
  }

  function connect() {
    if (state.stop) return;
    const url = SITE.replace(/^http/, 'ws') + '/relay?token=' + encodeURIComponent(state.token);
    let ws;
    try { ws = new WebSocket(url); } catch { return retry(); }
    state.ws = ws;

    ws.on('open', () => say('connected to donutoverlays.com — your overlay link is live'));
    ws.on('close', (code, reason) => {
      state.ws = null;
      if (code === 4001) {
        say('your subscription is no longer active — the overlay link has stopped.');
        state.stop = true;
        if (onCut) onCut();
        return;
      }
      if (code === 4000) {
        say('another launcher took over this account — closing this one.');
        state.stop = true;
        return;
      }
      say('lost connection to the site, retrying…' + (reason ? ' (' + reason + ')' : ''));
      retry();
    });
    ws.on('error', () => {});
  }

  function retry() {
    if (state.stop) return;
    setTimeout(connect, 3000);
  }

  /* Called by the relay whenever the game state changed. Identical
     payloads are dropped so an idle board costs nothing. */
  function push() {
    if (!state.ws || state.ws.readyState !== 1) return;
    let text;
    /* The port this launcher actually ended up on. It is usually the
       standard one, but if something else on the PC had taken it we moved
       — and without telling the site, the account page would keep printing
       an address that answers somebody else's 404. */
    let port = null;
    try { port = typeof getPort === 'function' ? getPort() : null; } catch { port = null; }
    try { text = JSON.stringify({ t: 'up', game, port, payload: getPayload() }); } catch { return; }
    /* The port is part of the message, so a payload that has not changed
       still needs to go out once if the port has. Comparing the whole
       string handles that on its own. */
    if (text === state.lastSent) return;
    state.lastSent = text;
    state.ws.send(text);
  }

  connect();
  return { push };
}

module.exports = { begin, attach, signIn, useSession, SITE };
