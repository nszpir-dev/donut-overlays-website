/**
 * Donut Overlays — the playable demos on the front page.
 */
/* ---------------------------------------------------------------------
   The playable demos on the front page.

   The real overlay file, served to anybody, with two things bolted on:
   a WebSocket that goes nowhere (so the page falls back to the little
   engine it already carries for running on its own), and a script that
   feeds it a round of made-up payments on a loop.

   It is the actual overlay rather than a picture of one, which is the
   entire point — what a visitor watches on the front page is the thing
   they are buying, down to the last animation. */
const DEMO_NAMES = ['9void', 'xqovr', 'DrDonutt', 'VyperJames', 'Sc0tty', 'mighty4l', 'nj_lucca', 'Crawdiddle'];
function demoScript(game, mode) {
  const names = JSON.stringify(DEMO_NAMES);
  /* Which giveaway the demo should play. Anything unexpected falls back
     to the chicken race rather than showing nothing. */
  const want = ['chicken', 'boat', 'number'].includes(String(mode)) ? String(mode) : 'chicken';
  return `<script>(function(){
  /* Nothing here may talk to the server: a hundred demo frames opening
     real sockets would be a self-inflicted denial of service. */
  window.WebSocket = function(){ this.readyState = 0; this.send = function(){}; this.close = function(){}; };
  var NAMES = ${names}, G = ${JSON.stringify(game)}, MODE = ${JSON.stringify(want)}, i = 0;
  var pick = function(){ return NAMES[(i++) % NAMES.length]; };
  function ready(fn){
    if(document.readyState === 'complete') setTimeout(fn, 400);
    else addEventListener('load', function(){ setTimeout(fn, 400); });
  }
  function have(){ for(var a = 0; a < arguments.length; a++) if(typeof window[arguments[a]] !== 'function') return false; return true; }
  ready(function(){
    document.body.classList.add('transparent');
    var tab = document.getElementById('opTab'); if(tab) tab.style.display = 'none';
    /* These overlays size themselves from the window, which is right on
       a stream and wrong inside a small frame on a sales page — it comes
       out as a postage stamp in the corner. The demo sets a readable
       size and keeps it, because the page re-runs its own sizing on
       every resize. */
    var FIXED = { stats: 20, giveaway: 13 }[G];
    if(FIXED){
      var hold = function(){ document.documentElement.style.fontSize = FIXED + 'px'; };
      hold();
      setInterval(hold, 500);
      addEventListener('resize', hold);
    }
    var step = 0;
    function beat(){
      try { play(step++); } catch(e){ /* a demo must never throw on the sales page */ }
      setTimeout(beat, 2200);
    }
    function play(n){
      var amt = [1, 2, 5, 3, 8, 4][n % 6] * 1000000;
      if(G === 'board'){
        if(!have('openEntries','addPayment','resetRound')) return;
        if(n === 0) return openEntries(14);
        if(typeof S === 'object' && S.phase === 'done'){ resetRound(); openEntries(14); return; }
        if(typeof S === 'object' && (S.phase === 'open' || S.phase === 'unlocked')) addPayment(pick(), amt);
        return;
      }
      if(G === 'auction'){
        if(!have('localOpen','localBid')) return;
        if(n === 0) return localOpen('Netherite kit', 1000000, 30);
        if(typeof A === 'object' && A.phase !== 'live') return localOpen('Elytra', 1000000, 30);
        localBid(pick(), (typeof A === 'object' && A.top ? A.top.amount : 0) + amt);
        return;
      }
      if(G === 'money'){
        if(!have('localOpen','localPay')) return;
        if(n === 0) return localOpen(5000000, 1000000, 40);
        if(typeof M === 'object' && M.phase !== 'live') return localOpen(5000000, 1000000, 40);
        localPay(pick(), amt);
        return;
      }
      if(G === 'lastcall'){
        if(!have('localOpen','localPay')) return;
        if(n === 0) return localOpen(5000000, 0, 20, 12);
        if(typeof M === 'object' && M.phase !== 'live') return localOpen(5000000, 0, 20, 12);
        localPay(pick(), (typeof M === 'object' && M.leader ? M.leader.amount : 0) + amt);
        return;
      }
      if(G === 'stats'){
        /* The tracker has its own little engine for running on its own,
           so the demo just feeds it a stream that goes up more than it
           goes down — which is what a good night looks like. */
        if(!have('localStart','localMove')) return;
        if(n === 0) return localStart(1200000000);
        var up = [5, 12, 3, 25, 8, 2, 15][n % 7] * 1000000;
        if(n % 4 === 3) return localMove('out', Math.round(up / 2), 'shop');
        return localMove('in', up, pick());
      }
      if(G === 'giveaway'){
        /* No local engine on this one — the relay normally decides
           everything — so the demo writes the same state the relay
           would send and lets the page draw it.
        
           The crowd is the point here: a real giveaway has hundreds in
           it, and a demo showing eight would be selling the wrong
           picture. */
        if(typeof window.GSET !== 'function') return;
        var d = window.__demo || (window.__demo = { entries: [] });
        var t = Date.now(), step = n % 16;
        var wheres = ['twitch', 'youtube', 'tiktok'];
        var made = function(k){
          var out = [];
          for(var j = 0; j < k; j++){
            var base = NAMES[j % NAMES.length];
            out.push({ name: j < NAMES.length ? base : base + (10 + (j % 89)),
                       platform: wheres[j % 3], at: t,
                       guess: MODE === 'number' ? 1 + ((j * 7) % 99) : null });
          }
          return out;
        };
        if(step === 0){
          d.entries = made(14);
          return window.GSET({ phase:'open', mode: MODE, prize: MODE === 'number' ? '100M' : '50M',
                               low: 1, high: 100, secret: 0, revealSecret: false,
                               endsAt: t + 32000, entries: d.entries, total: d.entries.length, winner: null });
        }
        if(step < 9){
          d.entries = made(14 + step * 26);           /* 40, 66, 92 … a real crowd */
          return window.GSET({ phase:'open', endsAt: t + (32000 - step * 3200),
                               entries: d.entries.slice(-200), total: d.entries.length });
        }
        if(step === 9){
          var w = d.entries[Math.floor(d.entries.length / 3)];
          if(MODE === 'number'){
            return window.GSET({ phase:'done', revealSecret: true, secret: w.guess, endsAt: 0,
                                 entries: d.entries.slice(-200), total: d.entries.length,
                                 winner: { name: w.name, platform: w.platform, guess: w.guess } });
          }
          return window.GSET({ phase:'racing', endsAt: 0, entries: d.entries.slice(-200),
                               total: d.entries.length,
                               winner: { name: w.name, platform: w.platform, guess: null } });
        }
        return;    /* the race plays itself out, then the winner sits there */
      }
      if(G === 'crown'){
        if(!have('localOpen','localPay')) return;
        if(n === 0) return localOpen({ seed: 5000000, minPay: 1000000, cutPct: 10, targetSec: 40 });
        if(typeof C === 'object' && C.phase !== 'live') return localOpen({ seed: 5000000, minPay: 1000000, cutPct: 10, targetSec: 40 });
        localPay(pick(), amt);
        return;
      }
    }
    beat();
  });
})();<\/script>`;
}


module.exports = { script: demoScript, NAMES: DEMO_NAMES };
