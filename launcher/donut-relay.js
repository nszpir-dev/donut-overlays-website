#!/usr/bin/env node
/**
 * Donut Royale — game server + relay
 * -------------------------------------------------------------
 * The round actually RUNS here, not in the browser. That matters:
 * a minimised browser window gets throttled by Chrome and your
 * eliminations would drift or stall. Node timers never throttle.
 *
 * This process:
 *   1. serves the overlay on http://localhost:8090
 *   2. runs the game (lobby -> lock -> eliminations -> winner)
 *   3. pushes state to every open overlay ~50x/sec over WebSocket
 *   4. watches your Minecraft log so /pay turns into entries by itself
 *
 * Setup:  npm init -y && npm i ws
 * Run:    node donut-relay.js
 *         node donut-relay.js --learn          (find your pay message)
 *         node donut-relay.js --test "line"    (check a pattern)
 *
 * TikTok LIVE Studio -> Link source:
 *   http://localhost:8090/?role=display&bg=transparent
 * Your control panel -> any browser:
 *   http://localhost:8090/
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = 8090;

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

/* ================= game state ================= */
const S = {
  phase: 'idle',            // idle | open | locked | unlocked | done
  paused: false,
  cardEveryEntry: true,     // big face for every entry lost, not just knockouts
  pausedLeft: 0,
  pausedElim: 0,
  entryPrice: 1000000,
  lobbySec: 600,
  fastElimSec: 3,          // >10 entries: one every 3s, no countdown
  finalElimSec: 15,        // last 10: 15s countdown, then a 3s pick
  finalStageAt: 10,        // entries left when the slow finish begins
  elimPerRound: 1,         // how many go out each time the clock fires
  rolling: false,
  winSec: 120,
  unlockPrice: 5000000,
  unlockMult: 1.5,
  unlockStep: 5000000,      // unlock price climbs by this much; 0 = use the × instead
  gross: 0,                 // every payment taken this round
  spend: 0,                 // what the round costs you (prize etc)
  ign: process.env.DONUT_IGN || 'mrchicken75',
  vouches: 6,
  endsAt: 0,
  nextElimAt: 0,
  entries: [],              // {id, name}
  players: {},              // name -> {name, paid, alive}
  pot: 0,
  highlight: null,
  doomed: null,
  dying: null,
  modal: null,              // {kind, name, pct, paid}
  unlockedBy: null,
  held: [],                 // payments that landed while locked
};
let seq = 1, history = [], rolling = false, dirty = true, rollStart = 0;
let pending = [];   // payments that landed mid-pick, replayed the moment it ends
let epoch = 0, rollEpoch = 0;   // bumped on reset so old timers can't fire into a new round
let batchLeft = 0, batchStart = 0;   // eliminations still owed in this round

const now = () => Date.now();
const mark = () => { dirty = true; };
const say = t => console.log(`  ${new Date().toLocaleTimeString([], {hour12:false})}  ${t}`);
function money(n){
  if(n >= 1e9) return '$' + +(n/1e9).toFixed(2) + 'B';
  if(n >= 1e6) return '$' + +(n/1e6).toFixed(2) + 'M';
  if(n >= 1e3) return '$' + +(n/1e3).toFixed(1) + 'K';
  return '$' + n;
}
const aliveCount = () => Object.values(S.players).filter(p => p.alive).length;
/* Total money on screen = what the players still in the round have paid,
   so it drops the moment someone is knocked out. */
function recalcPot(){
  S.pot = Object.values(S.players).filter(p => p.alive).reduce((a, p) => a + p.paid, 0);
}

/* ---------- entries ---------- */
function addPayment(name, amount){
  name = String(name || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  amount = Math.floor(Number(amount) || 0);
  if(!name || amount <= 0) return;

  /* Never drop money that arrives during the 3s pick — hold it and
     replay it as soon as the elimination finishes. */
  if(rolling){
    pending.push({ name, amount });
    say(`queued  ${name} ${money(amount)} (arrived mid-pick)`);
    return;
  }

  if(S.phase === 'locked'){
    if(amount >= S.unlockPrice){
      /* opens the board AND still counts as entries — they pay once, get both */
      buyUnlock(name, false);
      say(`${name} paid ${money(amount)} — board open, entries below`);
      /* falls through to the entry maths */
    } else {
      S.held.push({ name, amount, at: now() });
      say(`HELD  ${name} sent ${money(amount)} while locked — refund or carry over`);
      return mark();
    }
  }
  if(S.phase === 'done'){ S.held.push({ name, amount, at: now() }); return mark(); }

  const count = Math.floor(amount / S.entryPrice);
  if(count < 1){
    S.held.push({ name, amount, at: now() });
    say(`${name} sent ${money(amount)} — under entry price`);
    return mark();
  }

  if(!S.players[name]) S.players[name] = { name, paid: 0, alive: true };
  const p = S.players[name];
  p.alive = true;
  p.paid += amount;

  S.gross += amount;        // profit tracking counts everything, even after knockouts
  const ids = [];
  for(let i = 0; i < count; i++){
    const id = seq++;
    const at = Math.floor(Math.random() * (S.entries.length + 1));   // scattered across the board
    S.entries.splice(at, 0, { id, name });
    ids.push(id);
  }
  recalcPot();
  history.push({ name, ids, amount });
  say(`+${count} ${count === 1 ? 'entry' : 'entries'}  ${name}  ${money(amount)}`);
  if(S.phase === 'idle') openEntries();
  mark();
}
function undoLast(){
  const h = history.pop(); if(!h) return;
  S.entries = S.entries.filter(e => !h.ids.includes(e.id));
  const p = S.players[h.name];
  if(p){ p.paid -= h.amount; if(p.paid <= 0) delete S.players[h.name]; }
  S.gross -= h.amount;
  recalcPot();
  say(`undo  ${h.name}`); mark();
}
function removeOne(name){
  const i = S.entries.findIndex(e => e.name === name);
  if(i < 0) return;
  S.entries.splice(i, 1);
  if(!S.entries.some(e => e.name === name) && S.players[name]) S.players[name].alive = false;
  recalcPot();
  mark();
}

/* ---------- phases ---------- */
function openEntries(sec){
  S.phase = 'open';
  S.endsAt = now() + (sec || S.lobbySec) * 1000;
  S.modal = null; S.unlockedBy = null;
  say('entries open'); mark();
}
function lockBoard(){
  if(S.entries.length < 2){ say('need at least 2 entries to lock'); S.endsAt = now() + 30000; return mark(); }
  /* Every entry belonging to one person means they have already won —
     locking would eliminate once, crown them, and freeze on the winner
     card with no way back except a reset. Refuse, and say why. */
  if(new Set(S.entries.map(e => e.name)).size < 2){
    say('need at least 2 DIFFERENT players to lock — every entry is ' + S.entries[0].name);
    S.endsAt = now() + 30000;
    return mark();
  }
  S.phase = 'locked';
  S.endsAt = 0;
  S.nextElimAt = now() + (isFinalStage() ? S.finalElimSec * 1000 : 1500);
  say(`board locked · ${S.entries.length} entries · ${aliveCount()} players`);
  mark();
}
function buyUnlock(by, credit = true){
  if(rolling) return;
  S.phase = 'unlocked';
  S.unlockedBy = by || null;
  if(by && credit){
    if(!S.players[by]) S.players[by] = { name: by, paid: 0, alive: true };
    S.players[by].paid += S.unlockPrice;
    recalcPot();
  }
  S.endsAt = now() + S.winSec * 1000;
  S.unlockPrice = S.unlockStep > 0
    ? S.unlockPrice + S.unlockStep                                  // flat climb, e.g. +5M
    : Math.round(S.unlockPrice * S.unlockMult / 100000) * 100000;   // or a multiplier
  say(`board unlocked${by ? ' by ' + by : ''} · next unlock ${money(S.unlockPrice)}`);
  mark();
}
/* pause freezes the clock properly: remember what was left, put it back on resume */
function togglePause(){
  S.paused = !S.paused;
  if(S.paused){
    S.pausedLeft = S.endsAt ? Math.max(0, S.endsAt - now()) : 0;
    S.pausedElim = S.nextElimAt ? Math.max(0, S.nextElimAt - now()) : 0;
    S.endsAt = 0;
  } else {
    if(S.pausedLeft) S.endsAt = now() + S.pausedLeft;
    if(S.pausedElim) S.nextElimAt = now() + S.pausedElim;
    S.pausedLeft = S.pausedElim = 0;
  }
  say(S.paused ? 'paused' : 'resumed'); mark();
}
function resetRound(){
  S.entries = []; S.players = {}; S.pot = 0; S.gross = 0; S.spend = 0;
  S.modal = null; S.phase = 'idle';
  S.highlight = S.doomed = S.dying = null; S.unlockedBy = null; S.endsAt = 0;
  S.held = []; history = []; rolling = false; S.rolling = false; S.paused = false;
  batchLeft = 0; pending = [];
  S.pausedLeft = S.pausedElim = 0; S.nextElimAt = 0;
  epoch++;
  say('round reset'); mark();
}

/* ---------- elimination ---------- */
const isFinalStage = () => S.entries.length <= S.finalStageAt;

/* dur = how long the skipping/highlighting lasts before it lands.
   3000ms for the last ten, ~1100ms while the board is still big. */
/* Put the round back in a state where the loop can carry on. Anything
   that abandons a spin has to call this, or the round is stuck for good. */
function clearRoll(){
  rolling = false; S.rolling = false;
  S.highlight = null; S.doomed = null; S.dying = null;
  batchLeft = 0;
  mark();
}
function startRoll(dur){
  if(rolling || S.entries.length < 2) return;
  rollEpoch = epoch;
  rolling = true; S.rolling = true; rollStart = now();
  const slow = isFinalStage();
  const target = S.entries[Math.floor(Math.random() * S.entries.length)];
  const pool = S.entries.map(e => e.id);
  const t0 = now();
  const step = () => {
    if(!rolling || rollEpoch !== epoch) return;
    const p = (now() - t0) / dur;
    if(p >= 1) return land(target, slow);
    let id = pool[Math.floor(Math.random() * pool.length)];
    if(pool.length > 1) while(id === S.highlight) id = pool[Math.floor(Math.random() * pool.length)];
    S.highlight = id; mark();
    setTimeout(step, 55 + 300 * Math.pow(p, 2.4));   // fast, then dragging
  };
  step();
}
function land(target, slow){
  if(rollEpoch !== epoch) return clearRoll();
  S.highlight = null; S.doomed = target.id; mark();
  setTimeout(() => kill(target), slow ? 850 : 320);
}

/* One pick, then everyone owed this round goes at once.
   The picked player is the face on the card; the rest are "and N others". */
function kill(target){
  if(rollEpoch !== epoch) return clearRoll();
  const name = target.name;
  const totalBefore = S.entries.length;
  const mine = S.entries.filter(e => e.name === name).length;
  const pct = (mine / totalBefore) * 100;

  /* never take the last entry — there has to be a winner */
  const wipe = Math.max(1, Math.min(batchLeft || 1, S.entries.length - 1));
  const rest = S.entries.filter(e => e.id !== target.id);
  for(let i = rest.length - 1; i > 0; i--){        // shuffle
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const victims = [target, ...rest.slice(0, wipe - 1)];
  const doomedIds = new Set(victims.map(v => v.id));

  S.doomed = null; S.dying = target.id; mark();

  setTimeout(() => {
    if(rollEpoch !== epoch) return clearRoll();
    S.entries = S.entries.filter(e => !doomedIds.has(e.id));
    S.dying = null;

    const stillIn = new Set(S.entries.map(e => e.name));
    let knockedOut = 0;
    for(const v of victims){
      if(!stillIn.has(v.name) && S.players[v.name] && S.players[v.name].alive){
        S.players[v.name].alive = false;
        knockedOut++;
      }
    }
    recalcPot();

    const slow = isFinalStage();
    const others = victims.length - 1;
    const out = !stillIn.has(name);

    if(others > 0){
      /* a handful of the other faces for the strip on the card */
      const seen = new Set([name]);
      const faces = [];
      for(const v of victims){
        if(seen.has(v.name)) continue;
        seen.add(v.name); faces.push(v.name);
        if(faces.length >= 9) break;
      }
      showModal({ kind: 'mass', name, pct, others, out, faces }, slow ? 3400 : 2600);
      say(`WIPED  ${name} and ${others} others  (${knockedOut} player${knockedOut === 1 ? '' : 's'} out)`);
    } else if(out){
      showModal({ kind: 'elim', name, pct }, slow ? 3400 : 2400);
      say(`ELIMINATED  ${name}  (${pct.toFixed(1)}%)`);
    } else if(S.cardEveryEntry){
      showModal({ kind: 'lost', name, pct, left: S.entries.filter(e => e.name === name).length },
                slow ? 1700 : 1000);
    }

    const names = new Set(S.entries.map(e => e.name));
    if(names.size === 1){
      const w = [...names][0];
      setTimeout(() => {
        S.phase = 'done';
        S.highlight = S.doomed = null;
        showModal({ kind: 'winner', name: w, pct: 100, paid: S.players[w] ? S.players[w].paid : 0 }, 1e9);
        say(`WINNER  ${w}`);
      }, 3400);
    }

    rolling = false; S.rolling = false;
    batchLeft = 0;
    S.nextElimAt = slow ? now() + S.finalElimSec * 1000
                        : batchStart + S.fastElimSec * 1000;
    mark();

    if(pending.length){
      const q = pending; pending = [];
      setTimeout(() => q.forEach(x => addPayment(x.name, x.amount)), 0);
    }
  }, 480);
}
let modalTimer = null;
function showModal(m, ms){
  ms = ms || 3400;
  clearTimeout(modalTimer);
  S.modal = m; mark();
  if(ms < 1e9) modalTimer = setTimeout(() => { S.modal = null; mark(); }, ms);
}

/* ---------- the loop ---------- */
setInterval(() => {
  if(S.paused) return;
  /* A spin should take about a second, four at the very most. If one is
     still going after fifteen, something dropped it — unstick the round
     rather than leaving a frozen board on someone's stream. */
  if(rolling && now() - rollStart > 15000){
    say('a spin got stuck — clearing it so the round can carry on');
    clearRoll();
    S.nextElimAt = now() + 1000;
  }
  if((S.phase === 'open' || S.phase === 'unlocked') && S.endsAt && now() >= S.endsAt) lockBoard();
  if(S.phase === 'locked' && !rolling && !S.modal && batchLeft === 0
     && now() >= S.nextElimAt && S.entries.length > 1){
    batchLeft = Math.max(1, Math.min(S.elimPerRound, S.entries.length - 1));
    batchStart = now();
    startRoll(isFinalStage() ? 3000 : 1100);
  }
}, 50);

/* ================= commands from the panel ================= */
function handleCmd(c){
  const a = c.args || {};
  switch(c.name){
    case 'open':      openEntries(a.sec); break;
    case 'lock':      lockBoard(); break;
    case 'unlock':    { const price = S.unlockPrice;
                        if(a.by){ buyUnlock(a.by, false); addPayment(a.by, price); }
                        else buyUnlock(null, false);
                      } break;
    case 'skip':      if(S.phase === 'locked' && !rolling && S.entries.length > 1){
                        batchLeft = Math.max(1, Math.min(S.elimPerRound, S.entries.length - 1));
                        batchStart = now();
                        startRoll(isFinalStage() ? 3000 : 1100);
                      } break;
    case 'pause':     togglePause(); break;
    case 'reset':     resetRound(); break;
    case 'timer':     if(a.sec != null){
                        if(S.phase === 'idle' || S.phase === 'done') S.phase = 'open';
                        S.endsAt = now() + Number(a.sec) * 1000;
                        say(`timer set to ${a.sec}s`); mark();
                      } break;
    case 'addTime':   if(S.endsAt){ S.endsAt += Number(a.sec) * 1000; mark(); } break;
    case 'add':       addPayment(a.name, a.amount); break;
    case 'undo':      undoLast(); break;
    case 'removeOne': removeOne(a.name); break;
    case 'clearHeld': S.held = []; mark(); break;
    case 'config':    for(const k of Object.keys(a)) if(k in S) S[k] = a[k];
                      if(a.ign) paylog.setIgn(S.ign);
                      say('settings updated'); mark(); break;

  }
}

/* ================= http + websocket ================= */
const FILE = path.join(__dirname, 'donut-royale.html');
const server = http.createServer((req, res) => {
  if(!fs.existsSync(FILE)){ res.writeHead(404); return res.end('donut-royale.html must sit next to this script'); }
  /* anyone coming in from outside your network only ever gets the board */
  if(!isLocal(req) && !/^\/(display|overlay)/i.test(req.url || '')){
    res.writeHead(302, { Location: '/display' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(FILE).pipe(res);
});
const wss = new WebSocketServer({ server });
const clients = new Set();

/* If you expose this through a tunnel so TikTok can reach it, the whole
   internet can reach it too. Only connections from this PC or your own
   wifi are allowed to send commands — everyone else just watches. */
function isLocal(req){
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return /^(::1|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

wss.on('connection', (ws, req) => {
  const trusted = isLocal(req);
  clients.add(ws);
  ws.send(JSON.stringify({ t: 'state', s: S }));
  ws.on('close', () => clients.delete(ws));
  ws.on('message', raw => {
    if(!trusted) return;                 // watchers can look, not touch
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if(m.t === 'cmd') handleCmd(m);
    if(m.t === 'payment') addPayment(m.player, m.amount);
  });
  say(`overlay connected (${clients.size} open)${trusted ? '' : ' — view only, outside your network'}`);
});

/* push state the moment anything changes — worst case 20ms behind */
setInterval(() => {
  if(!dirty || clients.size === 0) return;
  dirty = false;
  const s = JSON.stringify({ t: 'state', s: S });
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
  Donut Royale is running   (leave this window open — minimising is fine)

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

  paylog.setIgn(S.ign);
  paylog.startTail({ onPayment: addPayment, say, learn: LEARN });
  if(LEARN) say('learn mode on — every money-ish log line prints below. Pay yourself, copy the line, add a pattern.');
}

server.on('listening', announce);
server.listen(PORT);

/* ================= Donut Overlays uplink =================
   Mirrors this board up to donutoverlays.com so the streamer's
   permanent overlay link shows it. The game itself is untouched and
   still runs entirely on this PC — if the uplink is missing or the
   site is unreachable, everything above carries on exactly as before. */
try {
  const uplink = require('./uplink');
  const up = uplink.attach({ getPort: () => livePort, game: 'board', getPayload: () => ({ t: 'state', s: S }) });
  setInterval(() => up.push(), 50).unref();
} catch (e) {
  say('uplink unavailable (' + e.message + ') — running locally only');
}
