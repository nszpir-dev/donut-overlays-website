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
function demoScript(game) {
  const names = JSON.stringify(DEMO_NAMES);
  return `<script>(function(){
  /* Nothing here may talk to the server: a hundred demo frames opening
     real sockets would be a self-inflicted denial of service. */
  window.WebSocket = function(){ this.readyState = 0; this.send = function(){}; this.close = function(){}; };
  var NAMES = ${names}, G = ${JSON.stringify(game)}, i = 0;
  var pick = function(){ return NAMES[(i++) % NAMES.length]; };
  function ready(fn){
    if(document.readyState === 'complete') setTimeout(fn, 400);
    else addEventListener('load', function(){ setTimeout(fn, 400); });
  }
  function have(){ for(var a = 0; a < arguments.length; a++) if(typeof window[arguments[a]] !== 'function') return false; return true; }
  ready(function(){
    document.body.classList.add('transparent');
    var tab = document.getElementById('opTab'); if(tab) tab.style.display = 'none';
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
