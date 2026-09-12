#!/usr/bin/env node
/**
 * Donut Auction — standalone server
 * -------------------------------------------------------------
 * Its own program, its own folder, its own port (8091). Nothing
 * here touches the elimination board, so you can only ever run
 * one game against your Minecraft chat at a time.
 *
 * The auction runs HERE, not in the browser — a minimised browser
 * window gets throttled by Windows and the clock would drift.
 *
 * Setup:  npm init -y && npm i ws        (the .bat does this for you)
 * Run:    node donut-auction-relay.js
 *         node donut-auction-relay.js --learn         (find your pay message)
 *         node donut-auction-relay.js --test "line"   (check a pattern)
 *
 * TikTok LIVE Studio -> Link source:
 *   http://localhost:8091/display
 * Your control panel -> any browser:
 *   http://localhost:8091/
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = 8091;

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

/* ================= the auction ================= */
const A = {
  phase: 'idle',          // idle | live | sold
  item: '',
  minBid: 1000000,
  endsAt: 0,
  /* How long this lot was given, so the overlay's bar knows what "full"
     means. It used to be worked out on the overlay from the form field,
     which meant an OBS window that connected halfway through a lot drew
     the bar as if the lot had only just started. */
  lotMs: 60000,
  delaySec: 5,            // keeps taking bids this long after 0:00
  inDelay: false,
  delayEndsAt: 0,
  paused: false,
  pausedLeft: 0,
  high: null,             // { name, amount }
  bids: [],               // accepted bids, newest first
  rejected: [],           // paid but not a valid bid — refund these
  vouches: 6,
  uiScale: 1.15,          // Text size dropdown — the overlay reads this
  layout: 'compact',      // compact = only item, bid and clock
  cardW: 19,              // card width in rem; 100 = full width
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

function aOpen(item, minBid, sec){
  if(item) A.item = item;
  if(minBid != null) A.minBid = minBid;   // 0 is a real minimum
  A.phase = 'live';
  A.high = null; A.bids = []; A.rejected = [];
  A.inDelay = false; A.delayEndsAt = 0; A.paused = false;
  A.lotMs = (sec || 60) * 1000;
  A.endsAt = now() + A.lotMs;
  say(`auction open: ${A.item || '(no item)'} · min ${money(A.minBid)} · ${sec || 60}s`);
  mark();
}

/* Bids never stack. 5M then 10M from the same person is a 10M bid,
   not 15M — anything that doesn't beat the leader gets refunded. */
function aBid(name, amount){
  name = String(name || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  amount = Math.floor(Number(amount) || 0);
  if(!name || amount <= 0) return;

  if(A.phase !== 'live'){
    A.rejected.push({ name, amount, why: 'auction not running' });
    say(`REFUND  ${name} ${money(amount)} — auction not running`);
    return mark();
  }
  if(amount < A.minBid){
    A.rejected.push({ name, amount, why: 'under minimum' });
    say(`REFUND  ${name} ${money(amount)} — under the ${money(A.minBid)} minimum`);
    return mark();
  }
  if(A.high && amount <= A.high.amount){
    A.rejected.push({ name, amount, why: `under ${A.high.name}'s ${money(A.high.amount)}` });
    say(`REFUND  ${name} ${money(amount)} — does not beat ${money(A.high.amount)}`);
    return mark();
  }
  A.high = { name, amount, at: now() };
  A.bids.unshift({ name, amount, at: now() });
  if(A.bids.length > 12) A.bids.pop();
  say(`BID  ${name}  ${money(amount)}`);
  mark();
}
function aClose(){
  A.phase = 'sold'; A.inDelay = false; A.endsAt = 0;
  say(A.high ? `SOLD to ${A.high.name} for ${money(A.high.amount)}` : 'ended with no bids');
  mark();
}
function aReset(){
  A.phase = 'idle'; A.item = ''; A.high = null; A.bids = []; A.rejected = [];
  A.endsAt = 0; A.inDelay = false; A.delayEndsAt = 0; A.paused = false; A.pausedLeft = 0;
  say('auction cleared'); mark();
}
function aTogglePause(){
  A.paused = !A.paused;
  if(A.paused){
    /* Freeze whichever clock is actually running. Pausing inside the
       live-delay window used to read endsAt, which by then is in the
       past, save nothing, and zero it — after which the tick below could
       never fire again and the auction sat there, unclosable, until it
       was reset. */
    const until = A.inDelay ? A.delayEndsAt : A.endsAt;
    A.pausedLeft = until ? Math.max(0, until - now()) : 0;
    A.endsAt = 0; A.delayEndsAt = 0;
  } else if(A.pausedLeft){
    /* Coming back inside the delay window, endsAt has to be put back as
       well as delayEndsAt — it is the thing the tick checks first. */
    if(A.inDelay){ A.endsAt = now(); A.delayEndsAt = now() + A.pausedLeft; }
    else A.endsAt = now() + A.pausedLeft;
    A.pausedLeft = 0;
  }
  say(A.paused ? 'paused' : 'resumed'); mark();
}
const addPayment = (name, amount) => aBid(name, amount);   // chat money = a bid

/* the clock: at zero it either sells, or keeps taking bids through
   the live-delay window so stream-lag bids still count */
setInterval(() => {
  if(A.phase !== 'live' || A.paused) return;
  if(A.endsAt && now() >= A.endsAt){
    if(A.delaySec > 0 && !A.inDelay){
      A.inDelay = true;
      A.delayEndsAt = now() + A.delaySec * 1000;
      say(`clock hit zero — still taking bids for ${A.delaySec}s (live delay)`);
      mark();
    } else if(!A.inDelay || now() >= A.delayEndsAt){
      aClose();
    }
  }
}, 50);

/* ================= commands from the panel ================= */
function handleCmd(c){
  const a = c.args || {};
  switch(c.name){
    case 'a.open':          aOpen(a.item, a.minBid, a.sec); break;
    case 'a.bid':           aBid(a.name, a.amount); break;
    case 'a.close':         aClose(); break;
    case 'a.reset':         aReset(); break;
    case 'a.pause':         aTogglePause(); break;
    /* Both of these move the finish line, so both have to move what the
       bar measures against — otherwise adding thirty seconds leaves the
       bar pinned full, and cutting the clock short leaves it barely
       moving. Grown, never shrunk, so time added mid-lot refills the bar
       rather than overflowing it. */
    case 'a.addTime':       if(A.endsAt){ A.endsAt = Math.max(now(), A.endsAt + Number(a.sec) * 1000);
                              A.lotMs = Math.max(A.lotMs, A.endsAt - now()); mark(); } break;
    case 'a.time':          if(a.sec != null){ A.endsAt = now() + Number(a.sec) * 1000;
                              A.lotMs = Math.max(1000, Number(a.sec) * 1000);
                              A.inDelay = false; A.delayEndsAt = 0; mark(); } break;
    case 'a.undo':          { const b = A.bids.shift();
                              if(b){ A.high = A.bids[0] || null; say(`undid ${b.name}'s bid`); mark(); } } break;
    case 'a.clearRejected': A.rejected = []; mark(); break;
    case 'a.config':        for(const k of Object.keys(a)) if(k in A) A[k] = a[k];
                            say('settings updated'); mark(); break;
    case 'config':          if(a.ign){ ign = a.ign; paylog.setIgn(ign); mark(); } break;
  }
}

/* ================= http + websocket ================= */
const PAGE = path.join(__dirname, 'donut-auction.html');

/* a tunnel link is public, so only this PC and your own wifi get to
   press buttons — everyone else just watches */
function isLocal(req){
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return /^(::1|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

const server = http.createServer((req, res) => {
  if(!fs.existsSync(PAGE)){
    res.writeHead(404);
    return res.end('donut-auction.html must sit next to this script');
  }
  if(!isLocal(req) && !/^\/(display|overlay|auction-display)/i.test(req.url || '')){
    res.writeHead(302, { Location: '/display' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(PAGE).pipe(res);
});

const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws, req) => {
  const trusted = isLocal(req);
  clients.add(ws);
  ws.send(JSON.stringify({ t: 'state', a: A, s: { ign } }));
  ws.on('close', () => clients.delete(ws));
  ws.on('message', raw => {
    if(!trusted) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if(m.t === 'cmd') handleCmd(m);
    if(m.t === 'payment') aBid(m.player, m.amount);
  });
  say(`overlay connected (${clients.size} open)${trusted ? '' : ' — view only'}`);
});

setInterval(() => {
  if(!dirty || clients.size === 0) return;
  dirty = false;
  const s = JSON.stringify({ t: 'state', a: A, s: { ign } });
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
/* your PC's address on the wifi, so you can run the panel from your phone */
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
  Donut Auction is running   (leave this window open — minimising is fine)

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
  const up = uplink.attach({ getPort: () => livePort, game: 'auction', getPayload: () => ({ t: 'state', a: A, s: { ign } }) });
  setInterval(() => up.push(), 50).unref();
} catch (e) {
  console.log('  uplink unavailable (' + e.message + ') — running locally only');
}
