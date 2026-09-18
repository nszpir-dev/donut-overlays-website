/**
 * Donut Overlays — the update feed
 * ---------------------------------------------------------------
 * Until now, a fix reached a customer like this: download the zip again,
 * delete the old folder, extract the new one, put your settings back,
 * and remember which of the loose files were yours. On a day with three
 * fixes that is three times. People stopped bothering, which meant fault
 * reports about faults that had already been fixed, and no way to tell
 * from a screenshot which of the two you were looking at.
 *
 * So the launcher updates itself now, and this is what it reads.
 *
 * THE ONE DESIGN DECISION WORTH KNOWING
 * -------------------------------------
 * There is no second thing to upload. The file list is read out of the
 * same donut-overlays-launcher.zip the download button already serves.
 * Upload that one zip and every launcher in the world picks the change
 * up the next time it starts.
 *
 * The alternative — a folder of loose files plus a hand-written version
 * number — has a failure mode that is genuinely hard to spot: the zip
 * and the update feed drift apart, and a new customer and an updating
 * customer end up running different code while both are told they are
 * current. Deriving one from the other makes that impossible rather
 * than unlikely.
 *
 * Zip reading is done here by hand (about sixty lines, below) rather
 * than with a dependency, because the server already has zlib and a
 * package that unpacks archives from user input is a larger surface
 * than the thing it saves.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ZIP = path.join(__dirname, 'launcher', 'donut-overlays-launcher.zip');

/* What a launcher file may be called. Anything else in the zip is
   ignored rather than served: this list is the only thing standing
   between a zip and an arbitrary file write on a customer's PC, so it
   is deliberately narrow — no separators, no dots leading anywhere. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;

/* Files the launcher must never overwrite while it is running.
   cmd.exe reads a .bat by byte offset AS IT RUNS, so replacing one
   mid-run makes it jump into the middle of a line. The launcher skips
   these; they are still listed so it can say a fresh download is worth
   doing. */
const FRAGILE = new Set(['START-DONUT-OVERLAYS.bat']);

/* ---------------- reading the zip ---------------- */

function centralDirectory(buf){
  /* The end-of-central-directory record is the last 22 bytes unless the
     zip carries a comment, so scan back for the signature. 64KB is the
     largest a comment can be. */
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for(let i = buf.length - 22; i >= floor; i--){
    if(buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('this does not look like a zip file');
}

function entries(buf){
  const eo = centralDirectory(buf);
  const count = buf.readUInt16LE(eo + 10);
  let p = buf.readUInt32LE(eo + 16);
  const out = [];
  for(let k = 0; k < count; k++){
    if(p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50){
      throw new Error('the zip directory is damaged');
    }
    const method = buf.readUInt16LE(p + 10);
    const csize  = buf.readUInt32LE(p + 20);
    const nlen   = buf.readUInt16LE(p + 28);
    const elen   = buf.readUInt16LE(p + 30);
    const clen   = buf.readUInt16LE(p + 32);
    const at     = buf.readUInt32LE(p + 42);
    const name   = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if(name.endsWith('/')) continue;
    out.push({ name, method, csize, at });
  }
  return out;
}

function bytesOf(buf, e){
  if(buf.readUInt32LE(e.at) !== 0x04034b50) throw new Error('a zip entry is damaged');
  /* The local header repeats the name and extra-field lengths, and they
     are NOT always the same numbers as in the central directory — the
     extra field in particular often differs. Read them from here. */
  const nlen = buf.readUInt16LE(e.at + 26);
  const elen = buf.readUInt16LE(e.at + 28);
  const from = e.at + 30 + nlen + elen;
  const raw = buf.subarray(from, from + e.csize);
  if(e.method === 0) return Buffer.from(raw);
  if(e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('unsupported compression in the zip');
}

/* ---------------- the manifest ---------------- */

let cache = null;   // { key, build, zipHash, files: Map<name, {size, sha256, body}> }

/* Re-read only when the zip on disk actually changes. Size and mtime
   together are enough: a deploy replaces the file wholesale. */
function manifest(){
  let st;
  try { st = fs.statSync(ZIP); } catch { return null; }
  const key = st.size + ':' + st.mtimeMs;
  if(cache && cache.key === key) return cache;

  let buf;
  try { buf = fs.readFileSync(ZIP); } catch { return null; }

  const files = new Map();
  let list;
  try { list = entries(buf); }
  catch(err){ console.error('[updates] cannot read the launcher zip:', err.message); return null; }

  for(const e of list){
    /* The zip may be flat or may hold everything in one folder; both
       have shipped. Either way the launcher's files sit loose in
       whatever folder the customer extracted to, so only the last part
       of the path is meaningful. Anything nested deeper than one folder
       is not part of a flat launcher folder and is skipped. */
    const parts = e.name.split('/').filter(Boolean);
    if(parts.length > 2) continue;
    const name = parts[parts.length - 1];
    if(!SAFE_NAME.test(name) || files.has(name)) continue;
    let body;
    try { body = bytesOf(buf, e); }
    catch(err){ console.error('[updates] skipping', name + ':', err.message); continue; }
    files.set(name, {
      size: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      body,
    });
  }

  if(!files.size) return null;

  /* The build stamp comes out of launcher.js itself, so the number the
     website shows and the number printed in the customer's window are
     the same string from the same file and cannot disagree. The hash is
     the tie-breaker: two uploads on one day differ by it even though
     the date is identical. */
  let build = '';
  const boot = files.get('launcher.js');
  if(boot){
    const m = /const\s+BUILD\s*=\s*'([^']{1,40})'/.exec(boot.body.toString('utf8'));
    if(m) build = m[1];
  }
  const zipHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

  cache = { key, build: build || 'unknown', zipHash, files };
  console.log(`[updates] launcher build ${cache.build} (${cache.zipHash}) — ${files.size} files`);
  return cache;
}

/* What the launcher asks for: names, sizes and hashes, no contents. A
   few kilobytes, so checking costs nothing on a slow connection. */
function feed(){
  const m = manifest();
  if(!m) return null;
  return {
    build: m.build,
    id: m.zipHash,
    files: [...m.files].map(([name, f]) => ({
      name,
      size: f.size,
      sha256: f.sha256,
      /* Named rather than guessed at the other end, so the rule about
         what cmd.exe will tolerate lives in exactly one place. */
      replaceWhileRunning: !FRAGILE.has(name),
    })),
  };
}

/* One file's bytes. Returns null for anything not in the manifest,
   which is also what makes the path safe — nothing on disk is reachable
   by name, only what was actually read out of the zip. */
function fileNamed(name){
  const m = manifest();
  if(!m) return null;
  const f = m.files.get(String(name || ''));
  return f ? f.body : null;
}

/* Just the version, for the website. Cheap after the first call. */
function current(){
  const m = manifest();
  return m ? { build: m.build, id: m.zipHash } : null;
}

module.exports = { feed, fileNamed, current, manifest, FRAGILE, SAFE_NAME };
