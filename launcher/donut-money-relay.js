#!/usr/bin/env node
/**
 * Money Game — standalone server
 * -------------------------------------------------------------
 * Everyone pays in. Highest single payment when the clock stops
 * takes the whole pot, minus your cut. Losing payments stay in
 * the pot, so the loser's money is what the winner wins.
 *
 * Payments never stack: bid 1M, someone bids 3M, you now need 4M —
 * and your 1M stays in the pot either way.
 *
 * Late payments (after the clock) can't win. They're logged
 * separately and you keep them.
 *
 * Setup:  npm init -y && npm i ws       (the .bat does this for you)
 * Run:    node donut-money-relay.js
 *         node donut-money-relay.js --learn        (find your pay message)
 *         node donut-money-relay.js --test "line"  (check a pattern)
 *
 * LIVE Studio link source:  http://localhost:8092/display
 * Control panel:            http://localhost:8092/
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = 8092;

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

/* ================= the money game ================= */
const M = {
  phase: 'idle',          // idle | live | done
  seed: 1000000,          // what you put in to start the pot
  minBid: 0,              // 0 = any amount counts
  cutPct: 10,             // your slice, rolls into the next round
  endsAt: 0,
  paused: false,
  pausedLeft: 0,
  pot: 0,                 // seed + every qualifying payment
  leader: null,           // { name, amount }
  bids: [],               // newest first
  late: [],               // arrived after the clock — you keep these
  kept: 0,                // total of the late ones
  rejected: [],           // under the minimum
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
/* what the winner walks away with */
const payout = () => Math.floor(M.pot * (100 - M.cutPct) / 100);
/* your slice of this round, plus anything that turned up late */
const yourCut = () => M.pot - payout() + M.kept;

function mOpen(seed, minBid, sec){
  if(seed != null) M.seed = seed;
  if(minBid != null) M.minBid = minBid;
  M.phase = 'live';
  M.pot = M.seed;
  M.leader = null; M.bids = []; M.late = []; M.kept = 0; M.rejected = [];
  M.paused = false; M.pausedLeft = 0;
  M.endsAt = now() + (sec || 60) * 1000;
  say(`round open · pot starts at ${money(M.seed)} · ${sec || 60}s`);
  mark();
}

function mPay(name, amount){
  name = String(name || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  amount = Math.floor(Number(amount) || 0);
  if(!name || amount <= 0) return;

  /* after the clock: can't win, but it's yours */
  if(M.phase !== 'live'){
    M.late.push({ name, amount, at: now() });
    M.kept += amount;
    say(`LATE  ${name} ${money(amount)} — too late to win, you keep it`);
    return mark();
  }
  if(M.minBid > 0 && amount < M.minBid){
    M.rejected.push({ name, amount, why: 'under minimum' });
    say(`REFUND  ${name} ${money(amount)} — under the ${money(M.minBid)} minimum`);
    return mark();
  }

  /* every qualifying payment swells the pot, winning or not */
  M.pot += amount;
  M.bids.unshift({ name, amount, at: now() });
  if(M.bids.length > 15) M.bids.pop();

  if(!M.leader || amount > M.leader.amount){
    M.leader = { name, amount, at: now() };
    say(`LEAD  ${name} ${money(amount)}  ·  pot ${money(M.pot)}  ·  winning ${money(payout())}`);
  } else {
    say(`IN    ${name} ${money(amount)} — does not beat ${money(M.leader.amount)}, stays in the pot`);
  }
  mark();
}

function mEnd(){
  M.phase = 'done';
  M.endsAt = 0;
  if(M.leader) say(`WINNER  ${M.leader.name} takes ${money(payout())} (you keep ${money(yourCut())})`);
  else say('round ended with nobody paying in');
  mark();
}
function mReset(){
  M.phase = 'idle'; M.pot = 0; M.leader = null; M.bids = []; M.late = [];
  M.kept = 0; M.rejected = []; M.endsAt = 0; M.paused = false; M.pausedLeft = 0;
  say('round cleared'); mark();
}
function mTogglePause(){
  M.paused = !M.paused;
  if(M.paused){ M.pausedLeft = M.endsAt ? Math.max(0, M.endsAt - now()) : 0; M.endsAt = 0; }
  else if(M.pausedLeft){ M.endsAt = now() + M.pausedLeft; M.pausedLeft = 0; }
  say(M.paused ? 'paused' : 'resumed'); mark();
}
const addPayment = (name, amount) => mPay(name, amount);

setInterval(() => {
  if(M.phase !== 'live' || M.paused) return;
  if(M.endsAt && now() >= M.endsAt) mEnd();
}, 50);

/* ================= commands from the panel ================= */
function handleCmd(c){
  const a = c.args || {};
  switch(c.name){
    case 'm.open':          mOpen(a.seed, a.minBid, a.sec); break;
    case 'm.pay':           mPay(a.name, a.amount); break;
    case 'm.end':           mEnd(); break;
    case 'm.reset':         mReset(); break;
    case 'm.pause':         mTogglePause(); break;
    case 'm.addTime':       if(M.endsAt){ M.endsAt = Math.max(now(), M.endsAt + Number(a.sec) * 1000); mark(); } break;
    case 'm.undo':          { const b = M.bids.shift();
                              if(b){
                                M.pot -= b.amount;
                                M.leader = M.bids.reduce((best, x) => !best || x.amount > best.amount ? x : best, null);
                                say(`undid ${b.name}'s ${money(b.amount)}`); mark();
                              } } break;
    case 'm.clearRejected': M.rejected = []; mark(); break;
    case 'm.config':        for(const k of Object.keys(a)) if(k in M) M[k] = a[k];
                            say('settings updated'); mark(); break;
    case 'config':          if(a.ign){ ign = a.ign; paylog.setIgn(ign); mark(); } break;
  }
}

/* ================= http + websocket ================= */
const PAGE = path.join(__dirname, 'donut-money.html');

function isLocal(req){
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return /^(::1|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

const server = http.createServer((req, res) => {
  if(!fs.existsSync(PAGE)){
    res.writeHead(404);
    return res.end('donut-money.html must sit next to this script');
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
  t: 'state', m: M, s: { ign }, payout: payout(), yourCut: yourCut()
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
    if(m.t === 'payment') mPay(m.player, m.amount);
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
  Money Game is running   (leave this window open — minimising is fine)

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
  const up = uplink.attach({ getPort: () => livePort, game: 'money', getPayload: () => ({ t: 'state', m: M, s: { ign }, payout: payout(), yourCut: yourCut() }) });
  setInterval(() => up.push(), 50).unref();
} catch (e) {
  console.log('  uplink unavailable (' + e.message + ') — running locally only');
}
