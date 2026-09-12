/**
 * Follows out of a TikTok live room
 * -------------------------------------------------------------
 * Every word of this file exists because TikTok has no supported way to
 * tell a program that somebody followed you. What people use instead is
 * an unofficial library that reads the same feed the web player reads.
 * It works. It also breaks, without warning, whenever TikTok changes
 * something on their side — historically every few months.
 *
 * So this is built as the part that is allowed to fail:
 *
 *   · the library is loaded inside a try. Not installed, wrong version,
 *     throws on load — the reel still runs and follows can still arrive
 *     at POST /follow from anything else.
 *   · every failure is said out loud, in words, with what to do about
 *     it. A listener that silently stops is worse than one that was
 *     never there, because the streamer carries on expecting spins.
 *   · reconnects back off instead of hammering. Being rate limited by
 *     TikTok for reconnecting too fast is a self-inflicted outage.
 *
 * To turn it on, on the streamer's PC:
 *
 *     npm install tiktok-live-connector
 *     set TIKTOK_USER=yourtiktokname
 *
 * The launcher does both for you.
 */

/* The library has been published under more than one entry shape over
   the years. Rather than pinning to one and breaking on the next
   rename, take whichever of these exists. */
function loadLib(){
  let mod;
  try { mod = require('tiktok-live-connector'); }
  catch { return null; }
  const Ctor = mod.WebcastPushConnection || mod.TikTokLiveConnection
            || (mod.default && (mod.default.WebcastPushConnection || mod.default.TikTokLiveConnection));
  return typeof Ctor === 'function' ? Ctor : null;
}

/**
 * @param {string}   user      the TikTok username, no @
 * @param {function} onFollow  called with the follower's name
 * @param {function} say       prints into the game's own log
 * @param {function} onState   'tiktok' | 'http' — what the overlay shows
 */
function start({ user, onFollow, say, onState }){
  const Ctor = loadLib();
  if(!Ctor){
    say('follows: the TikTok listener is not installed on this PC.');
    say('         run  npm install tiktok-live-connector  in this folder,');
    say('         then start this window again. Everything else works meanwhile.');
    onState('http');
    return { stop(){} };
  }

  let conn = null, stopped = false, tries = 0, timer = null;

  /* Back off hard. A live room that is simply not live yet will refuse
     every attempt, and trying once a second for an hour is how an
     account gets rate limited for the evening. */
  const waitFor = () => Math.min(60000, 4000 * Math.pow(1.7, Math.min(tries, 6)));

  function connect(){
    if(stopped) return;
    try { conn = new Ctor(user); }
    catch(e){
      say('follows: could not start the TikTok listener — ' + e.message);
      onState('http');
      return;
    }

    conn.connect().then(() => {
      tries = 0;
      say(`follows: listening to @${user} on TikTok`);
      onState('tiktok');
    }).catch(err => {
      tries++;
      const msg = (err && err.message) || String(err);
      /* The overwhelmingly common case, and worth its own words: they
         are simply not live yet. Saying "connection failed" for that
         sends people hunting for a fault that is not there. */
      if(/offline|not.*live|LIVE has ended|user_not_found/i.test(msg)){
        if(tries === 1) say(`follows: @${user} is not live yet — will keep checking`);
      } else {
        say('follows: TikTok would not connect — ' + msg.slice(0, 120));
        if(tries === 1){
          say('         if this keeps up, TikTok has probably changed something.');
          say('         Everything still works: send follows to  POST /follow  instead.');
        }
      }
      onState('http');
      retry();
    });

    /* The library has used both spellings for this event depending on
       version. Listening for both costs nothing and means a rename does
       not silently stop every spin. */
    for(const ev of ['follow', 'social']){
      try {
        conn.on(ev, data => {
          if(!data) return;
          /* 'social' covers follows AND shares; only the follow half is
             a spin. Shares firing the reel would hand out prizes to
             people who did not follow, which is the exact thing the
             streamer promised on screen. */
          if(ev === 'social'){
            const label = String(data.displayType || data.label || '');
            if(!/follow/i.test(label)) return;
          }
          const name = data.uniqueId || data.nickname || data.user && (data.user.uniqueId || data.user.nickname);
          if(name) onFollow(name);
        });
      } catch { /* older builds may not know this event */ }
    }

    try {
      conn.on('disconnected', () => {
        if(stopped) return;
        say('follows: TikTok dropped the connection — reconnecting');
        onState('http');
        retry();
      });
      conn.on('error', () => { /* already reported through the paths above */ });
    } catch { /* not every version emits these */ }
  }

  function retry(){
    if(stopped || timer) return;
    const wait = waitFor();
    timer = setTimeout(() => { timer = null; connect(); }, wait);
    if(timer.unref) timer.unref();
  }

  connect();

  return {
    stop(){
      stopped = true;
      if(timer) clearTimeout(timer);
      try { conn && conn.disconnect && conn.disconnect(); } catch { /* already gone */ }
    },
  };
}

module.exports = { start, loadLib };
