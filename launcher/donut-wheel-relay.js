#!/usr/bin/env node
/**
 * Follow Reel — standalone server
 * -------------------------------------------------------------
 * A strip of prize tiles runs right to left across the screen and slows
 * to a stop on one of them. Every new follower gets a run, automatically,
 * with their name on it.
 *
 * The three things that make this different from the other four overlays:
 *
 *   1. NOBODY DRIVES IT. There is no Spin button to miss. A follow comes
 *      in, the reel runs. Two follows land at once and the second waits
 *      in a queue rather than cutting the first one off mid-run.
 *
 *   2. THE ODDS ARE YOURS. Every tile has a weight. A tile with weight 1
 *      next to a tile with weight 9 comes up a tenth of the time. The
 *      panel shows the real percentage as you type, because "weight 3"
 *      means nothing to anyone.
 *
 *   3. IT REMEMBERS. Prizes survive a restart, and every win is written
 *      to a file — so the morning after a stream you can still find out
 *      who won the thing you now have to send them.
 *
 * Where follows come from, in order of how much can go wrong:
 *
 *   · POST /follow  {"name":"someone"}   — anything can call this. A
 *     bridge, a StreamElements webhook, curl, a phone. This is the
 *     dependable one and it is what everything else ends up using.
 *   · the built-in TikTok listener, if tiktok-follows.js finds a library
 *     it can use. Unofficial, and it breaks whenever TikTok changes
 *     something, which is why it is not the only way in.
 *   · the Test button in the panel.
 *
 * Run:    node donut-wheel-relay.js
 *
 * LIVE Studio link source:  http://localhost:8094/display
 * Control panel:            http://localhost:8094/
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = 8094;

let WebSocketServer;
/* The real `ws` if it is installed, otherwise the small built-in one.
   Installing a package needs npm to exist, work, and reach the internet —
   which has already failed on real customers' PCs, and there is no reason
   for a stream to go down over it. */
try { ({ WebSocketServer } = require('ws')); }
catch { ({ WebSocketServer } = require('./ws-lite')); }

const now = () => Date.now();
const say = t => console.log(`  ${new Date().toLocaleTimeString([], { hour12: false })}  ${t}`);

/* ================= what a prize looks like =================
   `weight` is a share, not a percentage: the chance of a tile is its
   weight over the total. Shares rather than percentages because they
   still add up after you add a tile, and because a streamer editing one
   number should never have to fix five others to make them total 100. */
const COLORS = ['#19e3c8', '#ffc93c', '#8b5cff', '#ff4d9d', '#35e0ff', '#7bf59f', '#ff8a3d', '#c77dff'];

const DEFAULT_TILES = [
  { label: 'Nothing',      weight: 30, color: '#5b6b86', img: '' },
  { label: '$1M',          weight: 24, color: '#19e3c8', img: '' },
  { label: 'Shoutout',     weight: 18, color: '#ffc93c', img: '' },
  { label: '$5M',          weight: 12, color: '#8b5cff', img: '' },
  { label: 'Netherite',    weight:  9, color: '#ff8a3d', img: '' },
  { label: 'Elytra',       weight:  5, color: '#ff4d9d', img: '' },
  { label: 'JACKPOT',      weight:  2, color: '#7bf59f', img: '' },
];

const W = {
  phase: 'idle',            // idle | spinning | won
  tiles: [],
  queue: [],                // names waiting their turn
  current: null,            // { name, index, label }
  introAt: 0,               // the donut is on screen from here
  startedAt: 0,
  endsAt: 0,
  holdUntil: 0,
  history: [],              // newest first, capped for the wire
  introMs: 1500,            // the donut, before the reel moves
  spinMs: 5200,             // how long a run takes
  holdMs: 4500,             // how long the result stays up
  title: 'FOLLOW REEL',
  sub: 'every follower gets a spin',
  uiScale: 1,
  follows: 0,               // how many have come in this session
  source: 'none',           // where follows are arriving from
  /* Held on screen on purpose, for the minute you spend dragging the
     browser source into place. The overlay is invisible between runs,
     which is right on stream and impossible in OBS: you cannot position
     something you cannot see. */
  pinned: false,
  /* Shown for this long when a browser source first loads, then gone.
     Without it there is no way to tell an overlay that is working and
     waiting from one that never loaded at all — both are a blank
     rectangle, and the second is what actually happens when the address
     is wrong. Set to 0 to turn it off. */
  helloMs: 8000,
};

let dirty = true;
const mark = () => { dirty = true; };

/* ---------------- prizes on disk ----------------
   A streamer sets these up once, with images, and should never be asked
   to do it again because they restarted the window. Written next to the
   script so it can also be edited by hand or copied to another PC. */
const TILES_FILE = path.join(__dirname, 'wheel-prizes.json');
const WINS_FILE  = path.join(__dirname, 'wheel-wins.json');

function cleanTile(t, i){
  const label = String(t && t.label || '').slice(0, 24);
  /* Weights are whole numbers and never zero-total: a set of tiles that
     all weigh nothing has no answer to "which one wins", and the honest
     failure there is to refuse the edit, not to pick silently. */
  const weight = Math.max(0, Math.min(1000, Math.round(Number(t && t.weight) || 0)));
  /* 'rainbow' is a colour like any other as far as everything here is
     concerned — it is the overlay that knows how to draw it. Kept as a
     plain word rather than a separate flag so old prize files still load
     and a tile only ever has one colour field to reason about. */
  const color = (t && t.color === 'rainbow') ? 'rainbow'
    : (/^#[0-9a-f]{6}$/i.test(t && t.color) ? t.color : COLORS[i % COLORS.length]);
  /* Only data: images. A tile pointing at a URL would mean the overlay
     fetching something mid-stream, and a slow or dead host would leave a
     hole on screen at the worst moment. The panel shrinks whatever is
     picked before it ever gets here. */
  const img = typeof (t && t.img) === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(t.img)
    ? t.img.slice(0, 400000) : '';
  return { label, weight, color, img };
}

function loadTiles(){
  try {
    const raw = JSON.parse(fs.readFileSync(TILES_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.tiles;
    if(Array.isArray(list) && list.length) return list.slice(0, 24).map(cleanTile);
  } catch { /* first run, or somebody edited it into nonsense */ }
  return DEFAULT_TILES.map(cleanTile);
}
function saveTiles(){
  try { fs.writeFileSync(TILES_FILE, JSON.stringify(W.tiles, null, 2)); }
  catch(e){ say('could not save prizes: ' + e.message); }
}
W.tiles = loadTiles();

/* Wins are appended, never rewritten, and kept separately from the list
   the overlay shows — that one is trimmed to stay small on the wire, and
   trimming the record of who won what would be losing the only thing
   here that a viewer is actually owed. */
function loadWins(){
  try {
    const raw = JSON.parse(fs.readFileSync(WINS_FILE, 'utf8'));
    if(Array.isArray(raw)) return raw;
  } catch { /* none yet */ }
  return [];
}
let allWins = loadWins();
W.history = allWins.slice(-40).reverse();

function recordWin(row){
  allWins.push(row);
  W.history.unshift(row);
  if(W.history.length > 40) W.history.pop();
  try { fs.writeFileSync(WINS_FILE, JSON.stringify(allWins, null, 2)); }
  catch(e){ say('could not save the win list: ' + e.message); }
}

/* ================= the draw =================
   Weighted, and deliberately not clever. One pass over the tiles with a
   running total is easier to reason about than anything faster, and with
   at most two dozen tiles the difference is unmeasurable. */
function totalWeight(){ return W.tiles.reduce((n, t) => n + t.weight, 0); }

function drawIndex(){
  const total = totalWeight();
  /* Every weight zero — or no tiles at all — has no honest answer. Fall
     back to an even chance rather than always landing on the first tile,
     which is what a naive loop does and looks rigged on stream. */
  if(!W.tiles.length) return -1;
  if(total <= 0) return Math.floor(Math.random() * W.tiles.length);
  let r = Math.random() * total;
  for(let i = 0; i < W.tiles.length; i++){
    r -= W.tiles[i].weight;
    if(r < 0) return i;
  }
  return W.tiles.length - 1;
}

/* ================= the queue =================
   Two people following within a second of each other is normal, and the
   wrong answer to it is to cut the first run short. They wait, in order,
   and the overlay says how many are waiting so nobody watching thinks it
   has stopped working. */
const NAME_MAX = 24;
function cleanName(n){
  return String(n == null ? '' : n)
    .replace(/^@+/, '')
    .replace(/[ -]/g, '')
    .trim()
    .slice(0, NAME_MAX);
}

function addFollow(rawName, where){
  const name = cleanName(rawName) || 'someone';
  /* The same follow arriving twice — the TikTok listener reconnecting and
     replaying, or a bridge retrying a POST — should not cost two spins.
     Same name inside four seconds is one follow. */
  const key = name.toLowerCase();
  const last = recentFollows.get(key);
  if(last && now() - last < 4000){
    say(`ignored a repeat follow from ${name}`);
    return false;
  }
  recentFollows.set(key, now());
  for(const [k, t] of recentFollows) if(now() - t > 20000) recentFollows.delete(k);

  if(W.queue.length >= 200){
    say('queue is full — dropping ' + name);
    return false;
  }
  W.queue.push(name);
  W.follows++;
  if(where && where !== W.source){ W.source = where; }
  say(`follow from ${name}` + (W.queue.length > 1 ? `  (${W.queue.length} waiting)` : ''));
  mark();
  pump();
  return true;
}
const recentFollows = new Map();

/* The one place a run starts. Called whenever something might have
   changed — a new follow, a run finishing, the hold expiring — and does
   nothing unless the reel is actually free. */
function pump(){
  if(W.phase !== 'idle') return;
  if(!W.queue.length) return;
  if(!W.tiles.length){
    say('a follow came in but there are no prizes set up — add some in the panel');
    return;
  }
  const name = W.queue.shift();
  const index = drawIndex();
  W.current = { name, index, label: W.tiles[index] ? W.tiles[index].label : '' };
  /* The donut first, then the reel. The overlay is off screen entirely
     between runs, so without this beat the strip would appear and be
     moving in the same frame — there would be nothing to cut to, and
     nothing for a viewer's eye to land on before it all starts. */
  W.phase = 'intro';
  W.introAt = now();
  W.startedAt = 0;
  W.endsAt = 0;
  say(`follow up: ${name}`);
  mark();
}

/* The clock that moves it along. Everything the overlay draws is worked
   out from startedAt and endsAt, so a window opened halfway through a run
   picks it up in the right place instead of starting the animation over. */
setInterval(() => {
  if(W.phase === 'intro' && now() >= W.introAt + W.introMs){
    W.phase = 'spinning';
    W.startedAt = now();
    W.endsAt = W.startedAt + W.spinMs;
    say(`spinning for ${W.current ? W.current.name : '?'}`);
    mark();
    return;
  }
  if(W.phase === 'spinning' && now() >= W.endsAt){
    W.phase = 'won';
    W.holdUntil = now() + W.holdMs;
    const t = W.tiles[W.current ? W.current.index : -1];
    if(W.current && t){
      recordWin({ name: W.current.name, label: t.label, at: new Date().toISOString() });
      say(`${W.current.name} won ${t.label}`);
    }
    mark();
    return;
  }
  if(W.phase === 'won' && now() >= W.holdUntil){
    W.phase = 'idle';
    W.current = null;
    W.introAt = 0; W.startedAt = 0; W.endsAt = 0; W.holdUntil = 0;
    mark();
    pump();
  }
}, 40);

/* ================= commands from the panel ================= */
function handleCmd(c){
  const a = c.args || {};
  switch(c.name){
    case 'w.follow':
      addFollow(a.name, 'panel');
      break;

    case 'w.tiles': {
      /* Replaces the lot in one go. Editing a list one row at a time over
         a socket means the panel and the relay can disagree about what
         row 3 is, and the way that shows up is a streamer's prize list
         quietly reordering itself. */
      if(!Array.isArray(a.tiles)) break;
      W.tiles = a.tiles.slice(0, 24).map(cleanTile).filter(t => t.label || t.img);
      saveTiles();
      say(`prizes updated (${W.tiles.length})`);
      mark();
      break;
    }

    case 'w.config': {
      if(a.introMs != null) W.introMs = Math.max(0, Math.min(8000, Number(a.introMs) || 0));
      if(a.spinMs != null) W.spinMs = Math.max(1500, Math.min(20000, Number(a.spinMs) || 5200));
      if(a.holdMs != null) W.holdMs = Math.max(1000, Math.min(20000, Number(a.holdMs) || 4500));
      if(a.title != null) W.title = String(a.title).slice(0, 28);
      if(a.sub != null) W.sub = String(a.sub).slice(0, 48);
      if(a.uiScale != null) W.uiScale = Math.max(0.6, Math.min(2, Number(a.uiScale) || 1));
      if(a.helloMs != null) W.helloMs = Math.max(0, Math.min(60000, Number(a.helloMs) || 0));
      say('settings updated');
      mark();
      break;
    }

    case 'w.skip':
      /* Ends the current run early and moves on. For the moment on stream
         where something has gone wrong and the answer is "next". */
      if(W.phase !== 'idle'){
        W.phase = 'idle'; W.current = null; W.introAt = 0; W.endsAt = 0; W.holdUntil = 0;
        say('skipped'); mark(); pump();
      }
      break;

    case 'w.pin':
      W.pinned = !W.pinned;
      say(W.pinned
        ? 'held on screen so you can position it — turn this off before you go live'
        : 'back to normal: on screen only when somebody follows');
      mark();
      break;

    case 'w.clearQueue':
      W.queue = []; say('queue cleared'); mark();
      break;

    case 'w.clearHistory':
      /* Only clears what is on screen. The file keeps every win, because
         the whole point of the file is that it is the thing you still
         have the morning after. */
      W.history = []; say('cleared the on-screen list (wheel-wins.json still has everything)'); mark();
      break;
  }
}

/* ================= http + websocket ================= */
const PAGE = path.join(__dirname, 'donut-wheel.html');

function isLocal(req){
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return /^(::1|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

function readBody(req, cb){
  let n = 0; const parts = [];
  req.on('data', d => {
    n += d.length;
    if(n > 64 * 1024){ req.destroy(); return; }
    parts.push(d);
  });
  req.on('end', () => cb(Buffer.concat(parts).toString('utf8')));
  req.on('error', () => cb(''));
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  /* The way in for anything that is not this program. Deliberately plain:
     a POST with a name on it. Kept to this PC and the local network,
     because a spin is a prize and the last thing a streamer needs is the
     open internet handing them out. */
  if(/^\/follow\b/i.test(url)){
    if(!isLocal(req)){
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('follows can only be sent from this PC or your own network\n');
    }
    const fire = raw => {
      let name = '';
      try { name = JSON.parse(raw).name || ''; } catch { /* not json */ }
      if(!name){
        const m = /[?&]name=([^&]+)/.exec(url) || /(?:^|&)name=([^&]+)/.exec(raw || '');
        if(m) name = decodeURIComponent(m[1].replace(/\+/g, ' '));
      }
      const ok = addFollow(name, 'http');
      res.writeHead(ok ? 200 : 429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, queued: W.queue.length }));
    };
    if(req.method === 'POST') return readBody(req, fire);
    return fire('');
  }

  if(!fs.existsSync(PAGE)){
    res.writeHead(404);
    return res.end('donut-wheel.html must sit next to this script');
  }
  if(!isLocal(req) && !/^\/(display|overlay)/i.test(url)){
    res.writeHead(302, { Location: '/display' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(PAGE).pipe(res);
});

const wss = new WebSocketServer({ server });
const clients = new Set();
const snapshot = () => JSON.stringify({ t: 'state', w: W, now: now() });

wss.on('connection', (ws, req) => {
  const trusted = isLocal(req);
  clients.add(ws);
  ws.send(snapshot());
  ws.on('close', () => clients.delete(ws));
  ws.on('message', raw => {
    if(!trusted) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if(m.t === 'cmd') handleCmd(m);
  });
  say(`overlay connected (${clients.size} open)${trusted ? '' : ' — view only'}`);
});

setInterval(() => {
  if(!dirty || clients.size === 0) return;
  dirty = false;
  const s = snapshot();
  for(const c of clients) if(c.readyState === 1) c.send(s);
}, 20);

/* your PC's address on the wifi, so you can drive the panel from your phone */
function lanIP(){
  for(const list of Object.values(os.networkInterfaces()))
    for(const n of list || [])
      if(n.family === 'IPv4' && !n.internal) return n.address;
  return null;
}

/* Something else on the PC can be sitting on our port — another Donut
   Overlays window, or some unrelated program that happened to pick the
   same number. Take the next free one and say so, rather than stopping
   dead and asking a streamer to hunt through Task Manager. */
const PORT_TRIES = [PORT, PORT + 10, PORT + 20, PORT + 30, PORT + 100];
let portAt = 0;
let livePort = PORT;

server.on('error', err => {
  if (err && err.code === 'EADDRINUSE' && portAt + 1 < PORT_TRIES.length) {
    const busy = PORT_TRIES[portAt];
    portAt += 1;
    livePort = PORT_TRIES[portAt];
    console.log(`  port ${busy} is being used by something else — trying ${livePort}`);
    /* No callback. server.listen(port, cb) registers cb as a 'listening'
       listener every time it is called, so passing it again on the retry
       would leave two registered and everything below would happen twice. */
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
  setTimeout(() => process.exit(1), 50);
});

function openPanel(url) {
  if (process.env.DONUT_NO_OPEN) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  try { require('child_process').exec(cmd, () => {}); } catch { /* the address is printed too */ }
}

let announced = false;
function announce(){
  if (announced) return;
  announced = true;
  const lan = lanIP();
  console.log(`
  Follow Reel is running   (leave this window open — minimising is fine)

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

  say(`${W.tiles.length} prizes loaded from ${path.basename(TILES_FILE)}`);
  if(allWins.length) say(`${allWins.length} wins on record in ${path.basename(WINS_FILE)}`);

  /* The TikTok listener is optional on purpose. It leans on an unofficial
     way into TikTok that breaks whenever they change something, and a
     stream should not go down with it — so if it is not there, or cannot
     connect, everything else carries on and follows can still be sent to
     /follow by anything at all. */
  startFollows();
}

function startFollows(){
  const user = (process.env.TIKTOK_USER || '').replace(/^@+/, '').trim();
  let bridge = null;
  try { bridge = require('./tiktok-follows'); }
  catch { /* file not there — fine */ }

  if(!bridge){
    say('follows: waiting on  POST /follow  (no TikTok listener installed)');
    W.source = 'http'; mark();
    return;
  }
  if(!user){
    say('follows: set TIKTOK_USER to your TikTok name to listen for follows automatically');
    say('         until then, anything can send one to  POST http://localhost:' + livePort + '/follow');
    W.source = 'http'; mark();
    return;
  }
  bridge.start({
    user,
    onFollow: name => addFollow(name, 'tiktok'),
    say,
    onState: s => { W.source = s; mark(); },
  });
}

/* ================= Donut Overlays uplink =================
   Pushes the same state the local overlay gets up to donutoverlays.com,
   so the hosted link works from anywhere rather than only from this PC.
   Wrapped because it must never be the reason a stream does not start:
   no account, no internet, an older website that has never heard of this
   overlay — all of them end the same way, with everything still working
   on localhost. */
try {
  const uplink = require('./uplink');
  const up = uplink.attach({
    getPort: () => livePort,
    game: 'wheel',
    getPayload: () => ({ t: 'state', w: W, now: now() }),
  });
  /* The reel changes in bursts — a run, then nothing for minutes — so
     rather than a fixed tick this pushes only when something moved. */
  setInterval(() => { if (up && up.push) up.push(); }, 100).unref();
} catch (e) {
  console.log('  uplink unavailable (' + e.message + ') — running locally only');
}

server.on('listening', announce);
server.listen(PORT);
