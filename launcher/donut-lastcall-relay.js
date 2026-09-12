#!/usr/bin/env node
/**
 * Last Call — standalone server
 * -------------------------------------------------------------
 * Everyone pays into one pot. Whoever is HOLDING it when the room goes
 * quiet takes it. Taking it off the current holder costs more than they
 * paid, and doing so snaps the countdown back to full — so the round
 * ends only when nobody is willing to top the last number, and the
 * bigger the pot gets, the more people pile in, which is precisely
 * what stops anyone winning.
 *
 * A payment that does not beat the holder still goes into the pot. It
 * buys nothing: no crown, and no clock reset. If a small payment reset
 * the clock, a stream of $1 payments could hold a round open forever.
 *
 * Payments after the clock stops cannot win. They are listed
 * separately so you can refund them or keep them.
 *
 * Run:    node donut-lastcall-relay.js
 *         node donut-lastcall-relay.js --learn        (find your pay message)
 *         node donut-lastcall-relay.js --test "line"  (check a pattern)
 *
 * LIVE Studio link source:  http://localhost:8093/display
 * Control panel:            http://localhost:8093/
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = 8093;

/* ================= pay-message parsing =================
   Lives in paylog.js now, shared by all three games. It used to be
   copy-pasted into each of them, which meant fixing a pay-message
   pattern for one game quietly left the other two broken. */
const paylog = require('./paylog');
const { clean, parseAmount, parseLine, looksLikePayment } = paylog;

/* ---------- one-off modes ---------- */
const argTest = process.argv.indexOf('--test');
if(argTest > -1){
  console.log(parseLine(process.argv[argTest + 1] || '') || 'no match — add a pattern for this line');
  process.exit(0);
}
const LEARN = process.argv.includes('--learn');

let WebSocketServer;
/* The real `ws` if it is installed, otherwise the small built-in one.
   Installing a package needs npm to exist, work, and reach the internet —
   which has already failed on real customers' PCs, and there is no reason
   for a stream to go down over it. */
try { ({ WebSocketServer } = require('ws')); }
catch { ({ WebSocketServer } = require('./ws-lite')); }

/* ================= Last Call =================
   Same payment stream as the money game, two rules changed.

   1. The winner is whoever is HOLDING it when the clock stops, not
      whoever paid most over the round.
   2. To take it off the current holder you have to pay MORE than they
      did. Anything less lands in the pot and buys nothing — no crown,
      and crucially no clock reset, or a stream of $1 payments could keep
      a round alive forever for nothing.

   Together those mean the price of the crown only ever climbs, and the
   round ends when the room finally goes quiet — which is exactly what
   stops it ending. */
const L = {
  phase: 'idle',          // idle | live | done
  seed: 1000000,          // what you put in to start the pot
  minPay: 0,              // 0 = any amount counts and resets the clock
  cutPct: 0,              // your slice. 0 by default: the point is the winner takes it
  openSec: 30,            // how long the FIRST countdown runs
  resetSec: 10,           // what every payment snaps the clock back to
  endsAt: 0,
  paused: false,
  pausedLeft: 0,
  pot: 0,
  leader: null,           // { name, amount, at } — whoever is holding it
  bids: [],               // newest first; each carries took:true if it won the crown
  toBeat: 0,              // what the next payment has to exceed. 0 = anything
  late: [],               // arrived after the clock stopped — you keep these
  kept: 0,
  rejected: [],           // under the minimum
  short: [],              // paid, but not enough to take the crown — stays in the pot
  saves: 0,               // how many times the clock has been snatched back
  vouches: 6,
  uiScale: 1.15,
  layout: 'compact',
  cardW: 19,
};
/* The name from the website, handed over by the launcher. Only falls back
   to the old hardcoded default when the game is run on its own. */
let ign = process.env.DONUT_IGN || 'mrchicken75';
let dirty = true;

const now = () => Date.now();
const mark = () => { dirty = true; };
const say = t => console.log(`  ${new Date().toLocaleTimeString([], {hour12:false})}  ${t}`);
function money(n){
  if(n >= 1e9) return '$' + +(n/1e9).toFixed(2) + 'B';
  if(n >= 1e6) return '$' + +(n/1e6).toFixed(2) + 'M';
  if(n >= 1e3) return '$' + +(n/1e3).toFixed(1) + 'K';
  return '$' + n;
}
const payout = () => Math.floor(L.pot * (100 - L.cutPct) / 100);
const yourCut = () => L.pot - payout() + L.kept;
const msLeft = () => L.paused ? (L.pausedLeft || 0) : (L.endsAt ? Math.max(0, L.endsAt - now()) : 0);

function lOpen(seed, minPay, openSec, resetSec){
  if(seed != null) L.seed = seed;
  if(minPay != null) L.minPay = minPay;
  if(openSec) L.openSec = openSec;
  if(resetSec) L.resetSec = resetSec;
  L.phase = 'live';
  L.pot = L.seed;
  L.leader = null; L.bids = []; L.late = []; L.kept = 0; L.rejected = [];
  L.short = []; L.toBeat = 0; L.saves = 0;
  L.paused = false; L.pausedLeft = 0;
  L.endsAt = now() + L.openSec * 1000;
  say(`round open · pot ${money(L.seed)} · ${L.openSec}s to start · every payment resets to ${L.resetSec}s`);
  mark();
}

function lPay(name, amount){
  name = String(name || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  amount = Math.floor(Number(amount) || 0);
  if(!name || amount <= 0) return;

  /* After the clock stops nobody can take it back — the round is decided.
     The money is still yours, and it is listed so you can refund it if
     you would rather. */
  if(L.phase !== 'live'){
    L.late.push({ name, amount, at: now() });
    L.kept += amount;
    say(`LATE  ${name} ${money(amount)} — the round was already over`);
    return mark();
  }
  if(L.minPay > 0 && amount < L.minPay){
    L.rejected.push({ name, amount, why: 'under minimum' });
    say(`TOO SMALL  ${name} ${money(amount)} — under the ${money(L.minPay)} minimum, clock not reset`);
    return mark();
  }

  const wasLeft = msLeft();
  /* Every counted payment goes into the pot, whether or not it wins the
     crown. That is the rule the board states, so it has to be true even
     for the payments that achieve nothing else. */
  L.pot += amount;

  /* You only take it off the holder by paying MORE than they did. Equal
     is not more: letting a tie steal it would mean the person who matched
     you wins by being later, and nobody would understand why. */
  const bar = L.leader ? L.leader.amount : 0;
  const took = amount > bar;
  L.bids.unshift({ name, amount, at: now(), took });
  if(L.bids.length > 25) L.bids.pop();

  if(!took){
    L.short.unshift({ name, amount, needed: bar + 1, at: now() });
    if(L.short.length > 20) L.short.pop();
    say(`SHORT  ${name} ${money(amount)} — into the pot, but ${money(bar)} is holding it` +
        `  ·  pot ${money(L.pot)}  ·  clock untouched`);
    return mark();
  }

  const stolen = L.leader && L.leader.name !== name;
  L.leader = { name, amount, at: now() };
  L.toBeat = amount;
  L.saves++;

  /* The whole game: the clock goes back to full when the crown changes
     hands. Never DOWN though — paying while the opening clock still has
     25 seconds on it should not chop it to ten. A payment can only ever
     buy time, which is the only version of this rule that is not
     baffling to the person who just paid. */
  L.paused = false; L.pausedLeft = 0;
  L.endsAt = Math.max(L.endsAt, now() + L.resetSec * 1000);

  say(`${stolen ? 'STOLEN' : 'LEAD  '}  ${name} ${money(amount)} with ${(wasLeft/1000).toFixed(1)}s left` +
      `  ·  pot ${money(L.pot)}  ·  winning ${money(payout())}` +
      `  ·  next has to beat ${money(amount)}`);
  mark();
}

/* Undo removes the newest payment, which can hand the crown back to
   somebody. Rather than trying to unwind the state step by step, work the
   holder out again from what is left: under the beat-it rule the holder
   is always whoever paid the largest amount, and on a tie it is whoever
   got there first, because a matching payment never takes it. */
function recomputeLeader(){
  let best = null;
  for(const b of L.bids){
    if(!best || b.amount > best.amount || (b.amount === best.amount && b.at < best.at)) best = b;
  }
  L.leader = best ? { name: best.name, amount: best.amount, at: best.at } : null;
  L.toBeat = best ? best.amount : 0;
  /* took has to be recalculated too, or the chips would still show a
     beaten player as the one who took it. */
  L.saves = 0;
  const order = L.bids.slice().sort((x, y) => x.at - y.at);
  let bar = 0;
  for(const b of order){
    b.took = b.amount > bar;
    if(b.took){ bar = b.amount; L.saves++; }
  }
  L.short = order.filter(b => !b.took).reverse()
    .map(b => ({ name: b.name, amount: b.amount, needed: 0, at: b.at }));
}

function lEnd(){
  L.phase = 'done';
  L.endsAt = 0; L.paused = false; L.pausedLeft = 0;
  if(L.leader) say(`WINNER  ${L.leader.name} takes ${money(payout())}${L.cutPct ? ` (you keep ${money(yourCut())})` : ''}`);
  else say('the clock ran out with nobody paying');
  mark();
}
function lReset(){
  L.phase = 'idle'; L.pot = 0; L.leader = null; L.bids = []; L.late = [];
  L.kept = 0; L.rejected = []; L.short = []; L.toBeat = 0;
  L.endsAt = 0; L.paused = false; L.pausedLeft = 0; L.saves = 0;
  say('round cleared'); mark();
}
function lTogglePause(){
  L.paused = !L.paused;
  if(L.paused){ L.pausedLeft = L.endsAt ? Math.max(0, L.endsAt - now()) : 0; L.endsAt = 0; }
  else if(L.pausedLeft){ L.endsAt = now() + L.pausedLeft; L.pausedLeft = 0; }
  say(L.paused ? 'paused' : 'resumed'); mark();
}
const addPayment = (name, amount) => lPay(name, amount);

setInterval(() => {
  if(L.phase !== 'live' || L.paused) return;
  if(L.endsAt && now() >= L.endsAt) lEnd();
}, 50);

/* ================= commands from the panel ================= */
function handleCmd(c){
  const a = c.args || {};
  switch(c.name){
    case 'l.open':          lOpen(a.seed, a.minPay, a.openSec, a.resetSec); break;
    case 'l.pay':           lPay(a.name, a.amount); break;
    case 'l.end':           lEnd(); break;
    case 'l.reset':         lReset(); break;
    case 'l.pause':         lTogglePause(); break;
    case 'l.addTime':       if(L.endsAt){ L.endsAt = Math.max(now(), L.endsAt + Number(a.sec) * 1000); mark(); } break;
    case 'l.undo':          { const b = L.bids.shift();
                              if(b){
                                L.pot -= b.amount;
                                recomputeLeader();
                                say(`undid ${b.name}'s ${money(b.amount)}` +
                                    (L.leader ? ` — ${L.leader.name} is holding it again` : ''));
                                mark();
                              } } break;
    case 'l.clearRejected': L.rejected = []; mark(); break;
    case 'l.config':        for(const k of Object.keys(a)) if(k in L) L[k] = a[k];
                            say('settings updated'); mark(); break;
    case 'config':          if(a.ign){ ign = a.ign; paylog.setIgn(ign); mark(); } break;
  }
}

/* ================= http + websocket ================= */
const PAGE = path.join(__dirname, 'donut-lastcall.html');

function isLocal(req){
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return /^(::1|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

const server = http.createServer((req, res) => {
  if(!fs.existsSync(PAGE)){
    res.writeHead(404);
    return res.end('donut-lastcall.html must sit next to this script');
  }
  if(!isLocal(req) && !/^\/(display|overlay)/i.test(req.url || '')){
    res.writeHead(302, { Location: '/display' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(PAGE).pipe(res);
});

const wss = new WebSocketServer({ server });
const clients = new Set();
const snapshot = () => JSON.stringify({
  t: 'state', m: L, s: { ign }, payout: payout(), yourCut: yourCut()
});

wss.on('connection', (ws, req) => {
  const trusted = isLocal(req);
  clients.add(ws);
  ws.send(snapshot());
  ws.on('close', () => clients.delete(ws));
  ws.on('message', raw => {
    if(!trusted) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if(m.t === 'cmd') handleCmd(m);
    if(m.t === 'payment') lPay(m.player, m.amount);
  });
  say(`overlay connected (${clients.size} open)${trusted ? '' : ' — view only'}`);
});

setInterval(() => {
  if(!dirty || clients.size === 0) return;
  dirty = false;
  const s = snapshot();
  for(const c of clients) if(c.readyState === 1) c.send(s);
}, 20);

/* ================= minecraft log watcher =================
   Also paylog.js. Finding the right log is most of the work: hardly
   anyone plays through the vanilla launcher, and the old code only ever
   looked in .minecraft. */
/* your PC's address on the wifi, so you can drive the panel from your phone */
function lanIP(){
  for(const list of Object.values(os.networkInterfaces()))
    for(const n of list || [])
      if(n.family === 'IPv4' && !n.internal) return n.address;
  return null;
}
function lanIP(){
  for(const list of Object.values(os.networkInterfaces()))
    for(const n of list || [])
      if(n.family === 'IPv4' && !n.internal) return n.address;
  return null;
}

/* Almost always means Donut Overlays is already open in another window.
   Node's own message for this is a twenty-line stack trace ending in
   EADDRINUSE, which tells a streamer nothing and looks like the software
   is broken. Say what actually happened instead. */
/* Something else on the PC can be sitting on our port — another Donut
   Overlays window, or some unrelated program that happened to pick the
   same number. Rather than stopping dead and asking a streamer to hunt
   through Task Manager, take the next free port and say so.

   The standard port is always tried first, so in the normal case the
   address the website advertises is the right one. */
const PORT_TRIES = [PORT, PORT + 10, PORT + 20, PORT + 30, PORT + 100];
let portAt = 0;
let livePort = PORT;

server.on('error', err => {
  if (err && err.code === 'EADDRINUSE' && portAt + 1 < PORT_TRIES.length) {
    const busy = PORT_TRIES[portAt];
    portAt += 1;
    livePort = PORT_TRIES[portAt];
    console.log(`  port ${busy} is being used by something else — trying ${livePort}`);
    /* No callback here. server.listen(port, cb) registers cb as a
       'listening' listener every time it is called, so passing it again
       on the retry left TWO registered — the banner printed twice and,
       far worse, the log watcher started twice and would have counted
       every payment twice. */
    return server.listen(livePort);
  }
  if (err && err.code === 'EADDRINUSE') {
    console.log(`
  Donut Overlays could not find a free port.

    Every port it tried (${PORT_TRIES.join(', ')}) is already being used on
    this PC. Usually that means Donut Overlays is already open in another
    window.

  What to do:

    1. Look along your taskbar for another black Donut Overlays window
       and close it. Then start this one again.

    2. If you cannot find one, an old copy may still be running in the
       background. Press Ctrl+Shift+Esc, click the Details tab, and end
       every  node.exe  in the list. Then start this one again.

  Nothing is broken and nothing has been lost.
`);
  } else {
    console.log('\n  Could not start: ' + (err && err.message ? err.message : err) + '\n');
  }
  process.exitCode = 1;
  /* Give the message a moment to reach the window before the process
     goes, otherwise the batch file clears it away. */
  setTimeout(() => process.exit(1), 50);
});

/* Open the control panel in the default browser. Nobody should ever have
   to read a port number off a console window and type it in — that is how
   a streamer ends up on the wrong port looking at somebody else's 404 and
   concluding the software is broken. Set DONUT_NO_OPEN=1 to stop it. */
function openPanel(url) {
  if (process.env.DONUT_NO_OPEN) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  try {
    require('child_process').exec(cmd, () => {});   // failure is fine, the address is printed too
  } catch { /* no browser here — the printed address still works */ }
}

let announced = false;
function announce() {
  /* Belt and braces: whatever happens with retries, the watcher starts
     once and only once. */
  if (announced) return;
  announced = true;
  const lan = lanIP();
  console.log(`
  Last Call is running   (leave this window open — minimising is fine)

    LIVE Studio link source   http://localhost:${livePort}/display
    ...or if it rejects that  http://127.0.0.1:${livePort}/display${lan ? `
    ...or this one            http://${lan}:${livePort}/display` : ''}
    control panel on this PC  http://localhost:${livePort}/
${lan ? `    control panel on your phone  http://${lan}:${livePort}/   (same wifi)` : ''}
`);
  console.log(`  >>> YOUR CONTROLS:  http://localhost:${livePort}/   <<<
      (opening it for you now — if it does not appear, type that address
       into your browser. Use THIS number, not one from the website.)
`);
  openPanel(`http://localhost:${livePort}/`);

  paylog.setIgn(ign);
  paylog.startTail({ onPayment: addPayment, say, learn: LEARN });
  if(LEARN) say('learn mode on — every money-ish log line prints below.');
}

server.on('listening', announce);
server.listen(PORT);


/* ================= Donut Overlays uplink =================
   Mirrors this game up to donutoverlays.com so the streamer's permanent
   overlay link shows it. The game still runs entirely on this PC; if the
   site is unreachable everything above carries on exactly as before. */
try {
  const uplink = require('./uplink');
  const up = uplink.attach({ getPort: () => livePort, game: 'lastcall', getPayload: () => ({ t: 'state', m: L, s: { ign }, payout: payout(), yourCut: yourCut() }) });
  setInterval(() => up.push(), 50).unref();
} catch (e) {
  console.log('  uplink unavailable (' + e.message + ') — running locally only');
}
