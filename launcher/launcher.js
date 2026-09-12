#!/usr/bin/env node
/**
 * Donut Overlays — launcher
 * ---------------------------------------------------------------
 * The one thing a customer runs. Order matters:
 *
 *   1. sign in, while nothing else is writing to the console
 *   2. offer only the overlays their plan actually covers
 *   3. print that overlay's permanent link
 *   4. only then start the game, which prints its own banner
 *
 * One game at a time, on purpose: all three read the same Minecraft
 * chat, so running two would have both claiming the same payment.
 */
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const uplink = require('./uplink');

/* ---------------- the streamer's Minecraft name ----------------
   Everything depends on this: payments are matched against it, and a
   missing or wrong one means real money scrolls past unread with nothing
   on screen to explain why.

   Three places it can come from, in this order:
     1. the website, if the account has one set
     2. this file, from the last time it was asked
     3. asked here and now, and remembered

   The third exists so the launcher is never stuck waiting on the website.
   It is a plain text file next to the launcher, so it can also be edited
   by hand. */
const BUILD = '2026-09-12';

const NAME_FILE = path.join(__dirname, 'your-minecraft-name.txt');
const NAME_OK = /^[.*]?[A-Za-z0-9_]{3,16}$/;

function savedName() {
  try {
    const v = fs.readFileSync(NAME_FILE, 'utf8').trim();
    return NAME_OK.test(v) ? v : '';
  } catch { return ''; }
}
function rememberName(v) {
  try { fs.writeFileSync(NAME_FILE, v + '\n'); } catch { /* read-only folder — not fatal */ }
}

async function askForName() {
  console.log('');
  console.log('  What is your Minecraft username?');
  console.log('');
  console.log('    Type it exactly as it appears in Donut chat.');
  console.log('    Bedrock players: start it with a full stop, like  .yourname');
  console.log('');
  for (let i = 0; i < 5; i++) {
    const a = await ask('  Username: ');
    if (NAME_OK.test(a)) return a;
    console.log('  That does not look right — 3 to 16 letters, numbers or underscores.');
  }
  return '';
}

const GAMES = {
  board:   { label: 'Elimination board', file: './donut-relay.js' },
  auction: { label: 'Live auction',      file: './donut-auction-relay.js' },
  money:   { label: 'Money game',        file: './donut-money-relay.js' },
  lastcall:{ label: 'Last Call',         file: './donut-lastcall-relay.js' },
  wheel:   { label: 'Follow Reel',       file: './donut-wheel-relay.js' },
};

/* Follow Reel reads TikTok follows, not Minecraft chat, so it needs a
   different name from the other four and asking for it up front would be
   asking four fifths of people for something they will never use. It is
   asked for only when this overlay is actually chosen. */
const TIKTOK_FILE = path.join(__dirname, 'your-tiktok-name.txt');
const TIKTOK_OK = /^[A-Za-z0-9._]{2,24}$/;

function savedTikTok(){
  try {
    const v = fs.readFileSync(TIKTOK_FILE, 'utf8').trim().replace(/^@+/, '');
    return TIKTOK_OK.test(v) ? v : '';
  } catch { return ''; }
}
function rememberTikTok(v){
  try { fs.writeFileSync(TIKTOK_FILE, v + '\n'); } catch { /* read-only folder — not fatal */ }
}

async function askForTikTok(){
  console.log('');
  console.log('  What is your TikTok username?');
  console.log('');
  console.log('    Without the @. This is the live room the reel watches');
  console.log('    for follows. Leave it blank to set it up later.');
  console.log('');
  for(let i = 0; i < 3; i++){
    const a = (await ask('  TikTok name: ')).replace(/^@+/, '');
    if(!a) return '';
    if(TIKTOK_OK.test(a)) return a;
    console.log('  That does not look like a TikTok name — letters, numbers, dots and underscores.');
  }
  return '';
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, a => { rl.close(); resolve(a.trim()); });
  });
}

async function choose(available) {
  console.log('');
  console.log('  Which overlay are you running today?');
  console.log('');
  available.forEach((g, i) => console.log('    ' + (i + 1) + ')  ' + GAMES[g].label));
  console.log('');

  /* Always asked, even when only one overlay is available. It used to
     pick silently in that case, which meant the control panel opened in
     the browser before the streamer had said what they were doing — it
     looked like the launcher had decided for them. One keystroke is
     cheaper than that confusion, and Enter takes the top one. */
  const only = available.length === 1;
  const prompt = only
    ? '  Press Enter to start the ' + GAMES[available[0]].label.toLowerCase() + ': '
    : '  Type 1' + (available.length === 2 ? ' or 2' : ' to ' + available.length) +
      ' and press Enter: ';

  for (let tries = 0; tries < 5; tries++) {
    const a = (await ask(prompt) || '').trim();
    if (!a && only) return available[0];
    const n = parseInt(a, 10);
    if (n >= 1 && n <= available.length) return available[n - 1];
    console.log('  Just the number of one of the options above.');
  }
  return available[0];
}


(async () => {
  /* Printed so a screenshot is enough to tell which build someone is
     running. Half the faults reported so far have been a fixed bug in a
     copy downloaded weeks ago, and there was no way to see that from the
     window. */
  console.log('');
  console.log('  Donut Overlays        build ' + BUILD);
  console.log('  ------------------------------------------------------------');

  let session = null;
  try {
    session = await uplink.signIn();
  } catch (err) {
    console.log('');
    console.log('  Could not reach donutoverlays.com (' + err.message + ').');
    console.log('  Starting the elimination board locally — your permanent');
    console.log('  overlay link will not update until the site is back.');
  }

  let game = 'board';
  if (session) {
    const available = session.links.links.map(l => l.game).filter(g => GAMES[g]);
    if (!available.length) {
      console.log('');
      console.log('  There is no active plan on this account.');
      console.log('  Start a free trial at ' + uplink.SITE + ' and run this again.');
      process.exit(0);
    }
    game = await choose(available);
    console.log('');
    console.log('  Starting the ' + GAMES[game].label.toLowerCase() + '…');
    await uplink.begin(game, session);
  } else {
    uplink.useSession(null);
  }

  /* The website first, then whatever was used last time, and only then
     ask. Passed through the environment so the game has it before it
     reads a single line of chat.

     Asking here is what makes the launcher self-sufficient: it used to
     depend entirely on the site sending a name, so if the site did not
     have one the streamer got a warning and no way to fix it without
     leaving the window. */
  /* Follow Reel does not read Minecraft chat at all — it watches TikTok
     for follows — so asking for a Minecraft name here, and then announcing
     whose payments are being read, was answering a question nobody had
     asked and implying the overlay does something it does not. */
  const fromSite = (session && session.links && session.links.ign) || '';
  let ign = game === 'wheel' ? '' : (NAME_OK.test(fromSite) ? fromSite : savedName());
  if (!ign && game !== 'wheel') ign = await askForName();

  if (ign) {
    process.env.DONUT_IGN = ign;
    rememberName(ign);
    console.log('');
    console.log('  Reading payments made to  ' + ign);
    console.log('  (wrong? change it on the website, or edit your-minecraft-name.txt)');
  } else if (game !== 'wheel') {
    console.log('');
    console.log('  No username given, so payments cannot be matched to you.');
    console.log('  Set it in the control panel under Settings and they will start counting.');
  }

  /* Follow Reel needs the TikTok name instead, and only it does. Asked
     here rather than at startup so nobody running the other four is
     stopped for a question that has nothing to do with them. */
  if(game === 'wheel'){
    let tt = savedTikTok();
    if(!tt) tt = await askForTikTok();
    if(tt){
      process.env.TIKTOK_USER = tt;
      rememberTikTok(tt);
      console.log('');
      console.log('  Watching @' + tt + ' for follows');
    } else {
      console.log('');
      console.log('  No TikTok name given. The reel still works — you can send it');
      console.log('  follows from the control panel, or from anything that can make');
      console.log('  a web request. Put a name in your-tiktok-name.txt to change this.');
    }
  }

  // Hand over to the game itself: reads the Minecraft log, runs the
  // round, serves the local control panel, exactly as it always has.
  require(GAMES[game].file);
})();
