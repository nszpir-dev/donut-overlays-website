/**
 * Donut Overlays — reading payments out of the Minecraft log
 * ---------------------------------------------------------------
 * All three games need exactly the same thing: notice when somebody pays
 * the streamer in game. This used to be copy-pasted into each relay,
 * which meant a fix for one game silently left the other two broken.
 *
 * Two jobs, and the first one is the one that bites people:
 *
 *   1. FIND THE RIGHT LOG. Barely anyone plays through the vanilla
 *      launcher. Lunar, Badlion, Feather, Prism, Modrinth and the rest
 *      each write their chat somewhere else, and the old code only ever
 *      looked at .minecraft. It would happily say "watching ..." while
 *      pointing at a stale file from a launcher the streamer stopped
 *      using months ago, and then sit there silent forever.
 *
 *   2. READ THE PAY LINE. Servers word these differently, so a miss has
 *      to be loud. Silence is the worst possible outcome — it looks
 *      identical to "nobody paid".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---------------- who the money is going to ----------------
   Donut words some payments as "Legolas_3 paid ChiIIzs $16M" — the
   recipient by name rather than the word "you". That form is only a
   payment to THIS streamer when the name is theirs, so we have to know
   what their name is. Without this the line either had to be ignored
   (missing real payments) or accepted blindly (counting money two other
   players sent each other, which would be far worse). */
let MY_IGN = '';
function setIgn(name) {
  MY_IGN = String(name || '').trim().toLowerCase();
}
/* Compared with any Bedrock prefix removed from BOTH sides. Somebody who
   typed their name without the full stop, or with one when chat shows
   none, still gets their own payments. */
const bare = n => String(n || '').trim().toLowerCase().replace(/^[.*]/, '');
const isMe = name => !!MY_IGN && bare(name) === bare(MY_IGN);

/* ---------------- pay-message parsing ---------------- */
/* Donut writes payments like:  VyperJames paid you 💲1M
   Rank prefixes, colour codes and currency symbols all get in the way,
   so these skip anything that is not a digit between the words. */
const PATTERNS = [
  // "VyperJames paid you 💲1M"  ·  "Bob has sent you $1,000,000"
  { re: /([.*]?[A-Za-z0-9_]{3,16})\s+(?:has\s+|just\s+)?(?:paid|sent|gave|transferred)\s+(?:you|u)\s*\D{0,8}?([\d][\d.,]*)\s*([kmbt])?/i,
    name: 1, num: 2, suf: 3 },
  // "You received 💲1M from VyperJames"  ·  "You have been paid $1M by Bob"
  { re: /(?:you\s+)?(?:have\s+)?(?:received|got|been\s+(?:paid|sent|given))\s*\D{0,8}?([\d][\d.,]*)\s*([kmbt])?\s+(?:from|by)\s+([.*]?[A-Za-z0-9_]{3,16})/i,
    name: 3, num: 1, suf: 2 },
  // "[+] $1M from VyperJames"
  { re: /\[\+\]\s*\D{0,8}?([\d][\d.,]*)\s*([kmbt])?\s*(?:from\s+)?([.*]?[A-Za-z0-9_]{3,16})/i,
    name: 3, num: 1, suf: 2 },
  // "$1,000,000 has been sent to you by VyperJames"
  { re: /([\d][\d.,]*)\s*([kmbt])?\s+(?:has\s+been\s+)?(?:sent|paid|given|added|deposited)\s+to\s+(?:you|your\s+\w+)\s+(?:by|from)\s+([.*]?[A-Za-z0-9_]{3,16})/i,
    name: 3, num: 1, suf: 2 },
  /* "Legolas_3 paid ChiIIzs $ 16M" — the recipient named instead of
     "you". Only counts when that name is the streamer's own, which
     parseLine checks; `to` says which group holds the recipient. */
  { re: /([.*]?[A-Za-z0-9_]{3,16})\s+(?:has\s+|just\s+)?(?:paid|sent|gave|transferred)\s+([.*]?[A-Za-z0-9_]{3,16})\s*\D{0,8}?([\d][\d.,]*)\s*([kmbt])?/i,
    name: 1, to: 2, num: 3, suf: 4 },
  // "VyperJames → You: $1M"  ·  "VyperJames -> you 1M"
  { re: /([.*]?[A-Za-z0-9_]{3,16})\s*(?:->|→|»|>>)\s*(?:you|u)\s*\D{0,8}?([\d][\d.,]*)\s*([kmbt])?/i,
    name: 1, num: 2, suf: 3 },
];

/* Strip Minecraft colour codes and anything non-printing. */
function clean(line){
  return String(line).replace(/\u00a7./g, '').replace(/[\u0000-\u001f]/g, ' ');
}

function parseAmount(t){
  t = String(t).toLowerCase().replace(/[\s,$_]/g, '');
  const m = t.match(/^(\d+(?:\.\d+)?)([kmbt])?$/);
  if(!m) return 0;
  return Math.floor(parseFloat(m[1]) * ({ k:1e3, m:1e6, b:1e9, t:1e12 }[m[2]] || 1));
}

function parseLine(raw){
  const line = clean(raw);
  for(const p of PATTERNS){
    const m = line.match(p.re);
    if(!m) continue;
    const player = m[p.name];
    const amount = parseAmount((m[p.num] || '') + (m[p.suf] || ''));
    if(!player || !(amount > 0)) continue;
    if(p.to){
      /* Money between two other players is not yours. Never count it. */
      const to = m[p.to];
      if(!isMe(to)) continue;
    }
    return { player, amount };
  }
  return null;
}

/* When a line looked like a payment but did not parse, work out whether
   it was actually somebody paying a DIFFERENT player — including the
   case where it is this streamer under a name they have not set yet.
   "could not read" with no explanation is what makes people think the
   software is broken. */
function payToSomeoneElse(raw){
  const line = clean(raw);
  const m = line.match(/([.*]?[A-Za-z0-9_]{3,16})\s+(?:has\s+|just\s+)?(?:paid|sent|gave|transferred)\s+([.*]?[A-Za-z0-9_]{3,16})\s*\D{0,8}?([\d][\d.,]*)\s*([kmbt])?/i);
  if(!m) return null;
  const to = m[2];
  if(/^(you|u|your)$/i.test(to)) return null;
  return { from: m[1], to, amount: parseAmount((m[3] || '') + (m[4] || '')) };
}

/* Deliberately generous. A false alarm costs one printed line the
   streamer can ignore; a miss costs them a payment they never see and
   no clue that anything went wrong. Chat from other players talking
   about money is the price of never being silent. */
function looksLikePayment(raw){
  const line = clean(raw);
  if(!/\[CHAT\]/i.test(line)) return false;
  if(!/\d/.test(line)) return false;
  return /(paid|pay|sent|send|received|receive|transferred|given|gave|deposit)/i.test(line)
      || /\[\+\]/.test(line)
      || /[$💲]\s*[\d]/.test(line)
      /* Addressed to "you" and carrying a money-shaped number. Catches a
         wording nobody predicted, at the cost of the odd false alarm on
         ordinary chat — a wasted line in the window is far cheaper than a
         payment vanishing with no trace. */
      || (/\b(you|u|your)\b/i.test(line) && /\b\d[\d.,]*\s*[kmbt]\b|\b\d{4,}\b/i.test(line));
}

/* Money-shaped enough to be worth showing while we are still trying to
   learn what this server's pay message looks like. */
function hasMoneyish(raw){
  const line = clean(raw);
  return /\[CHAT\]/i.test(line) && (/\b\d[\d.,]*\s*[kmbt]\b/i.test(line) || /\b\d{3,}\b/.test(line) || /[$💲]/.test(line));
}

/* ---------------- finding the log ---------------- */
/* Folder names that belong to a Minecraft client of some sort. Anything
   matching gets searched; everything else is skipped, so this never
   turns into a scan of the whole drive. */
const CLIENT_HINT = /(minecraft|lunar|badlion|feather|prism|multimc|modrinth|theseus|curseforge|gdlauncher|technic|tlauncher|sklauncher|salwyrr|labymod|essential|atlauncher|ftb|polymc|xmdlauncher|pojav|cristalix|meteor|silent|rise)/i;
const SKIP = /^(node_modules|\.git|windows|program files|programdata|\$recycle\.bin|temp|tmp|cache|caches)$/i;

/* Folders that hold clients without being one. CurseForge in particular
   defaults to Documents\curseforge, and Documents is often redirected
   into OneDrive — so refusing to look inside anything that is not itself
   client-named misses it completely. Walk through these, but only near
   the top, so this never turns into a scan of the whole drive. */
const CONTAINER = /^(documents|onedrive|desktop|games|gaming|apps|applications|appdata|roaming|local|\.config|\.local|share|library|application support|users|home)$/i;

function roots(){
  const h = os.homedir();
  const out = [h];
  for(const v of [process.env.APPDATA, process.env.LOCALAPPDATA]) if(v) out.push(v);
  if(process.platform === 'darwin') out.push(path.join(h, 'Library', 'Application Support'));
  return [...new Set(out)];
}

/* Checked first, because an exact hit costs one stat() and skips the walk
   entirely. One entry per launcher people actually use; * expands to any
   folder, which is how instance and profile names get covered. */
const KNOWN = [
  // vanilla / Microsoft Store / most clients that reuse it
  '$APPDATA/.minecraft/logs/latest.log',
  // Badlion writes its own copy under the vanilla folder
  '$APPDATA/.minecraft/logs/blclient/minecraft/latest.log',
  // Lunar Client, old and new layouts
  '$HOME/.lunarclient/offline/*/logs/latest.log',
  '$HOME/.lunarclient/logs/game/latest.log',
  // Feather
  '$HOME/.feather/logs/latest.log',
  '$APPDATA/.feather/logs/latest.log',
  // CurseForge — default, and the OneDrive-redirected Documents case
  '$HOME/curseforge/minecraft/Instances/*/logs/latest.log',
  '$HOME/Documents/curseforge/minecraft/Instances/*/logs/latest.log',
  '$HOME/OneDrive/Documents/curseforge/minecraft/Instances/*/logs/latest.log',
  // Modrinth App, old and new names
  '$APPDATA/com.modrinth.theseus/profiles/*/logs/latest.log',
  '$APPDATA/ModrinthApp/profiles/*/logs/latest.log',
  '$HOME/.local/share/ModrinthApp/profiles/*/logs/latest.log',
  // Prism / PolyMC / MultiMC / ATLauncher / GDLauncher
  '$APPDATA/PrismLauncher/instances/*/.minecraft/logs/latest.log',
  '$APPDATA/PolyMC/instances/*/.minecraft/logs/latest.log',
  '$HOME/PrismLauncher/instances/*/.minecraft/logs/latest.log',
  '$HOME/MultiMC/instances/*/.minecraft/logs/latest.log',
  '$APPDATA/ATLauncher/instances/*/logs/latest.log',
  '$APPDATA/gdlauncher_next/instances/*/logs/latest.log',
  // TLauncher / SKLauncher and friends reuse .minecraft, already covered
  // macOS vanilla
  '$HOME/Library/Application Support/minecraft/logs/latest.log',
];

function expand(pattern){
  const h = os.homedir();
  const base = pattern
    .replace('$APPDATA', process.env.APPDATA || path.join(h, 'AppData', 'Roaming'))
    .replace('$HOME', h);
  const parts = base.split(/[\\/]/);
  let paths = [parts[0] === '' ? path.sep : parts[0]];
  for(const part of parts.slice(1)){
    if(part !== '*'){ paths = paths.map(p => path.join(p, part)); continue; }
    const next = [];
    for(const p of paths){
      let list;
      try { list = fs.readdirSync(p, { withFileTypes: true }); } catch { continue; }
      for(const d of list) if(d.isDirectory()) next.push(path.join(p, d.name));
    }
    paths = next.slice(0, 60);          // a sane cap on instance folders
  }
  return paths;
}

/* Depth-limited walk looking for logs/latest.log. Bounded three ways —
   only into folders that look like a client, only so deep, and only so
   many folders in total — because this runs at startup and a streamer
   waiting on a spinner will just close the window. */
function findLogs(limitMs = 4000, deep = true){
  const started = Date.now();
  const found = [];
  let looked = 0;

  const take = f => {
    try {
      const st = fs.statSync(f);
      if(st.isFile()) found.push({ file: f, mtime: st.mtimeMs, size: st.size });
    } catch { /* not there */ }
  };

  for(const pattern of KNOWN) for(const f of expand(pattern)) take(f);

  /* Everything above is a handful of stat() calls and finishes in under a
     millisecond. Everything below is a walk of the drive, and it is the
     slowest thing this program does — it runs on the same single thread
     that reads chat and answers the control panel, so while it runs,
     payments are not being read. It is worth it once at startup when we
     have nothing. It is not worth it when we already do.

     Two ways to skip it:
       · deep === false, for the routine re-checks while the stream is
         running. Known launchers cover all but a rare few, and a stat is
         free, so this is what should be running most of the time.
       · a known launcher's log was written to in the last ten minutes.
         The game is running on it right now; no sweep can beat that. */
  if(!deep) return tidy(found);
  if(found.some(f => Date.now() - f.mtime < 10 * 60 * 1000)) return tidy(found);

  /* Then the general sweep, which is what covers launchers nobody has
     told us about yet. */
  const walk = (dir, depth, insideClient) => {
    if(depth > 6 || looked > 4000 || Date.now() - started > limitMs) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    looked++;

    for(const d of list){
      if(!d.isDirectory()) continue;
      if(SKIP.test(d.name)) continue;
      const full = path.join(dir, d.name);

      if(d.name.toLowerCase() === 'logs'){
        take(path.join(full, 'latest.log'));
        take(path.join(full, 'blclient', 'minecraft', 'latest.log'));
        continue;                       // no need to go deeper than a logs folder
      }

      /* Three ways to earn a look: it is named after a client, we are
         already inside one, or it is a plain container like Documents
         that a client is commonly installed under. */
      if(insideClient || CLIENT_HINT.test(d.name)) walk(full, depth + 1, true);
      else if(CONTAINER.test(d.name) && depth < 3) walk(full, depth + 1, false);
    }
  };

  for(const r of roots()) walk(r, 0, false);
  return tidy(found);
}

/* Newest first — the one the game is writing to right now. */
function tidy(found){
  const seen = new Set();
  return found
    .filter(f => (seen.has(f.file) ? false : seen.add(f.file)))
    .sort((a, b) => b.mtime - a.mtime);
}

const short = p => {
  const h = os.homedir();
  return p.startsWith(h) ? '~' + p.slice(h.length) : p;
};

/* ---------------- the watcher ---------------- */
/* Rather than guessing which launcher the streamer uses, watch every log
   that has been touched recently and take payments from whichever one is
   alive. Picking wrong is the failure that cost a whole test session, and
   there is no cost to watching four files instead of one. */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;   // touched in the last week
/* Watching a file costs a file handle and nothing else, so be generous:
   a streamer with half a dozen launchers installed should not have to
   care which one we guessed. */
const MAX_WATCHED = 8;

/**
 * @param {(name:string, amount:number) => void} onPayment
 * @param {(msg:string) => void} say         prints into the game's own log panel
 * @param {boolean} learn                    print every money-ish line
 */
function startTail({ onPayment, say, learn = false, huntMs = 10000 }){
  const tails = new Map();          // file -> { offset, watcher, poller, reading, pending }
  let chatSeen = false, everParsed = false, shown = 0;
  const SHOW_LIMIT = 25;

  /* Two clients open at once would otherwise count the same payment
     twice. Same player, same amount, within a second and a half of each
     other is the same payment, not two. */
  const recent = new Map();
  function duplicate(name, amount){
    const key = name + '|' + amount;
    const now = Date.now();
    for(const [k, t] of recent) if(now - t > 3000) recent.delete(k);
    if(recent.has(key) && now - recent.get(key) < 1500) return true;
    recent.set(key, now);
    return false;
  }

  function handle(line){
    if(!line.trim()) return;
    if(learn && /\d|paid|sent|received/i.test(line)) console.log('  LEARN | ' + clean(line).trim());
    if(!chatSeen && /\[CHAT\]/i.test(line)){
      chatSeen = true;
      say('chat is coming through — payments will be picked up from here');
    }
    const hit = parseLine(line);
    if(hit){
      if(duplicate(hit.player, hit.amount)) return;
      if(!everParsed){
        everParsed = true;
        say('payments are being read correctly');
      }
      onPayment(hit.player, hit.amount);
      return;
    }
    if(looksLikePayment(line)){
      /* The commonest reason by far: it IS a payment, just to a named
         player rather than "you" — and the name in the settings does not
         match. Say so, with both names, instead of a bare failure. */
      const other = payToSomeoneElse(line);
      if(other){
        say(`NOT YOURS: ${other.from} paid ${other.to}` +
            (MY_IGN
              ? ` — your Minecraft name is set to "${MY_IGN}", so this one is not counted.`
                + (MY_IGN === String(other.to).toLowerCase() ? '' : ' If you ARE ' + other.to + ', fix the name in the control panel under Settings.')
              : ' — set your Minecraft name in the control panel under Settings and payments like this will count.'));
        return;
      }
      say('COULD NOT READ: ' + clean(line).trim().slice(-110));
      return;
    }
    /* Until one payment has parsed we do not know how this server words
       them, so show the money-ish chat. The real pay message is then in
       the window to be copied to us, instead of silence nobody can act
       on. Stops the moment one parses. */
    if(!everParsed && shown < SHOW_LIMIT && hasMoneyish(line)){
      if(shown === 0) say('no payment read yet — showing chat lines with money in them:');
      shown++;
      say('   chat | ' + clean(line).replace(/^.*\[CHAT\]\s*/i, '').trim().slice(0, 110));
      if(shown === SHOW_LIMIT) say('   (enough examples — send us one and we will add it)');
    }
  }

  function drain(file){
    const t = tails.get(file);
    if(!t) return;
    if(t.reading){ t.pending = true; return; }
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if(size < t.offset) t.offset = 0;            // the log rotated
    if(size === t.offset) return;

    t.reading = true;
    const from = t.offset;
    t.offset = size;
    const stream = fs.createReadStream(file, { start: from, end: size });
    let buf = '';
    stream.on('data', d => buf += d.toString('utf8'));
    stream.on('end', () => {
      t.reading = false;
      for(const line of buf.split(/\r?\n/)) handle(line);
      if(t.pending){ t.pending = false; drain(file); }
    });
    stream.on('error', () => { t.reading = false; });
  }

  /* How big each log was the last time we looked, including ones we are
     not following. When a log we skipped starts being written to, this is
     where to start reading from — otherwise attaching at its new end
     silently swallows the payment that made us notice it. Reading from
     further back is not an option: replaying old chat would count
     yesterday's payments all over again. */
  const sizeAtLastScan = new Map();

  function attach(file, readFrom){
    if(tails.has(file)) return false;
    const t = { offset: 0, watcher: null, poller: null, reading: false, pending: false };
    if(typeof readFrom === 'number') t.offset = readFrom;
    else { try { t.offset = fs.statSync(file).size; } catch { t.offset = 0; } }
    /* fs.watch is event-driven — Windows says the moment the file is
       written, instead of us asking every 150ms. That is the difference
       between a payment landing in ~20ms and up to ~200ms. */
    try { t.watcher = fs.watch(file, { persistent: true }, () => drain(file)); } catch { t.watcher = null; }
    t.poller = () => drain(file);
    /* fs.watch is the fast path, but it is not reliable on Windows for a
       file another program is appending to — Java buffers, and the event
       sometimes never comes. So the poll stays close behind it rather than
       a full second back: eight stat() calls four times a second is
       nothing, and it is the difference between a payment showing up the
       moment it happens and it showing up a second later, which on stream
       reads as the overlay being broken. */
    fs.watchFile(file, { interval: t.watcher ? 250 : 100 }, t.poller);
    tails.set(file, t);
    /* Read once straight away. The watchers only fire on what happens
       NEXT, so a log attached because it just grew would otherwise sit
       there with the very payment that made us notice it unread. */
    if(typeof readFrom === 'number') drain(file);
    return true;
  }

  if(process.env.LOG){
    attach(process.env.LOG);
    say(`watching ${short(process.env.LOG)}  (set by hand)`);
  } else {
    const all = findLogs();
    for(const f of all) sizeAtLastScan.set(f.file, f.size);
    const live = all.filter(f => Date.now() - f.mtime < RECENT_MS).slice(0, MAX_WATCHED);
    const pick = live.length ? live : all.slice(0, 1);
    for(const c of pick) attach(c.file);

    if(!pick.length){
      say('no Minecraft log found on this PC.');
      say('Start Minecraft once, then restart this window.');
      say('Or point at it by hand:  set LOG=C:\\path\\to\\latest.log');
      say('Until then you can still add payments by hand in the panel.');
    } else if(pick.length === 1){
      say(`watching ${short(pick[0].file)}`);
    } else {
      say(`watching ${pick.length} Minecraft logs — whichever you play on will work:`);
      for(const c of pick) say('   ' + short(c.file));
    }
  }

  /* A launcher started after this window will create a log we have not
     seen. Keep looking until chat actually arrives, then stop. */
  let ticks = 0;
  const hunt = setInterval(() => {
    if(process.env.LOG) return clearInterval(hunt);
    /* Keep looking even after chat starts arriving, just far less often.
       Stopping altogether meant that switching launcher mid-stream, or
       having more log files than we follow at once, silently swallowed
       every payment from then on. Checking costs a directory listing. */
    ticks++;

    /* This is the change that fixed payments landing late. It used to run
       a full sweep of the drive here, every ten seconds, for up to a
       second and a half — blocking the one thread that reads chat. A
       payment that arrived during a sweep simply waited for it to finish.

       So: while chat is coming through, everything is working, and all we
       do is stat the known launcher paths, every thirty seconds, which
       costs nothing. The expensive sweep is kept for the one case that
       actually needs it — no chat at all, nothing to lose by looking. */
    const deep = !chatSeen;
    if(chatSeen && ticks % 3 !== 0) return;
    /* A log that has GROWN since the last look is the one the game is
       writing to. That beats "recently modified" as a signal, and it is
       worth following even if we are already at the limit — a streamer
       with a pile of old launcher folders should not lose the live one
       to a cap. Everything else just gets its size recorded for the
       next comparison. */
    for(const f of findLogs(deep ? 1200 : 0, deep)){
      const before = sizeAtLastScan.get(f.file);
      const growing = before !== undefined && f.size > before;
      sizeAtLastScan.set(f.file, f.size);
      if(tails.has(f.file)) continue;

      if(growing){
        if(attach(f.file, before)) say('also watching ' + short(f.file) + '  (being written to now)');
      } else if(before === undefined && Date.now() - f.mtime < RECENT_MS && tails.size < MAX_WATCHED + 4){
        attach(f.file, f.size);         // brand new file, start at its end
      }
    }
  }, huntMs);
  if(hunt.unref) hunt.unref();

  /* Silence is the failure mode nobody can debug, so break it. */
  const nag = setTimeout(() => {
    if(chatSeen) return;
    say('');
    say('No chat has come through in the last minute.');
    say('If you are in game and people are talking, none of the logs above');
    say('are the one your launcher writes to. Either:');
    say('   · start the game, wait a moment, and restart this window, or');
    say("   · set LOG=<full path to your launcher's latest.log>");
    say('Everything else works meanwhile — add payments by hand in the panel.');
  }, 60000);
  if(nag.unref) nag.unref();

  return { drain: () => { for(const f of tails.keys()) drain(f); },
           watching: () => [...tails.keys()] };
}

module.exports = { PATTERNS, clean, parseAmount, parseLine, looksLikePayment, hasMoneyish,
                   setIgn, payToSomeoneElse, findLogs, startTail };
