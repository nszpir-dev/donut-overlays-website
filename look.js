/**
 * Donut Overlays — saved overlay appearance
 * ---------------------------------------------------------------
 * What a customer picks in the customiser on the website, cleaned up and
 * turned into the little script that gets injected into their hosted
 * overlay page.
 *
 * It lives in its own file, with no dependencies, for two reasons: these
 * values end up inside a <script> tag and inside a CSS url(), so the
 * validation is the security boundary and deserves to be readable on its
 * own; and it means the rules can be tested without standing up Express,
 * Mongo and Stripe first.
 */
const GAMES = ['board', 'auction', 'money'];

const SCALES = [1, 1.2, 1.45];
const isHex = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

/* Three possible answers, and they are not the same thing:
     'none'          -> the customer turned the picture off
     a valid image   -> use it
     null            -> leave whatever the overlay ships with

   The size cap is ~700KB of base64: a generous 512x512 PNG. The website
   shrinks images before upload, so anything over that is either a bug or
   somebody poking at the API by hand. */
const MAX_IMAGE = 700000;
const MAX_URL = 500;

function cleanImage(v) {
  if (v === 'none') return 'none';
  if (typeof v !== 'string' || !v) return null;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(v) && v.length <= MAX_IMAGE) return v;
  /* No parentheses: the value lands inside a CSS url(...) and there is no
     image host that needs them. Cheaper to forbid than to reason about. */
  if (/^https:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%-]+$/.test(v) && v.length <= MAX_URL) return v;
  return null;
}

/* Allow-list, not deny-list: a key that is not recognised never survives,
   so nothing unexpected can reach the page. */
function cleanLook(input) {
  const out = {};
  for (const game of GAMES) {
    const g = (input && input[game]) || {};
    const one = {};
    if (isHex(g.accent)) one.accent = g.accent;
    if (SCALES.includes(Number(g.scale))) one.scale = Number(g.scale);
    if (game === 'board') {
      const img = cleanImage(g.bgImage);
      if (img) one.bgImage = img;
      const o = Number(g.bgOpacity);
      if (Number.isFinite(o) && o >= 0 && o <= 1) one.bgOpacity = o;
    }
    out[game] = one;
  }
  return out;
}

/* Values are validated above; escaping < as well stops a stray "</script"
   inside a URL from closing the tag early. */
const safeJson = o => JSON.stringify(o).replace(/</g, '\\u003c');

function lookScript(game, look) {
  if (!look || !Object.keys(look).length) return '';
  return `<script>(function(){
var L = ${safeJson(look)}, G = ${safeJson(game)}, root = document.documentElement;

/* --- accent colour ---
   The board drives everything off --accent; the two card overlays use
   --gold for the same job. Setting the wrong one would recolour the
   winner badge rather than the theme. */
if (L.accent) {
  if (G === 'board') {
    var n = L.accent.slice(1);
    root.style.setProperty('--accent', L.accent);
    root.style.setProperty('--accent-rgb', [
      parseInt(n.slice(0,2),16), parseInt(n.slice(2,4),16), parseInt(n.slice(4,6),16)
    ].join(','));
    root.style.setProperty('--emerald', L.accent);
  } else {
    root.style.setProperty('--gold', L.accent);
  }
}

/* --- the picture behind the elimination board --- */
var art = document.getElementById('chick');
if (art) {
  if (L.bgImage === 'none') art.style.backgroundImage = 'none';
  else if (L.bgImage) art.style.backgroundImage = 'url("' + L.bgImage + '")';
  if (typeof L.bgOpacity === 'number') art.style.opacity = String(L.bgOpacity);
}

/* --- text size ---
   Each overlay sizes itself by writing an inline font-size on <html>
   every time the browser source is resized. Rather than fight that,
   watch for its writes and multiply whatever it just decided. */
var k = Number(L.scale) || 1;
if (k > 0 && k !== 1) {
  var mine = '';
  var apply = function(){
    var raw = root.style.fontSize;
    if (raw === mine) return;                 // that write was ours
    var v = parseFloat(raw);
    if (!v) return;
    root.style.fontSize = (v * k) + 'px';
    /* Read it BACK rather than remembering what we asked for. The browser
       rounds the value it stores, so comparing against our own string
       never matched, every mutation looked like a fresh one from the
       overlay, and the size multiplied itself to infinity. */
    mine = root.style.fontSize;
  };
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['style'] });
  apply();
}
})();</script>`;
}

module.exports = { GAMES, SCALES, cleanImage, cleanLook, lookScript, MAX_IMAGE };
