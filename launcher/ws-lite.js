/**
 * Donut Overlays — WebSocket, without npm
 * ---------------------------------------------------------------
 * The launcher only ever needed one package from npm, and installing it
 * turned out to be the most fragile thing in the whole product: it needs
 * npm to exist, to work, and to reach the internet through whatever the
 * streamer's network is doing. It has now failed on two different PCs for
 * two different reasons, and every failure looks like a wall of red text
 * to somebody who just wants to run a game on stream.
 *
 * So this is the small part of `ws` that this project actually uses,
 * written against RFC 6455 directly. It is a fallback: if the real `ws` is
 * installed, that is still what runs.
 *
 * What it has to talk to:
 *   · the overlay pages, which use the browser's own WebSocket
 *   · donutoverlays.com, whose server runs the real `ws`
 * Both directions are covered by the tests.
 *
 * Deliberately NOT implemented, because nothing here uses them:
 * extensions (permessage-deflate is never negotiated), subprotocols, and
 * backpressure beyond what a socket already gives.
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const { EventEmitter } = require('events');

/* Fixed by the spec, and easy to typo — the last group is C5AB0DC85B11. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const accept = key => crypto.createHash('sha1').update(key + GUID).digest('base64');

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

/* ---------------- frames ---------------- */
/**
 * @param {number} opcode 1 text, 2 binary, 8 close, 9 ping, 10 pong
 * @param {boolean} mask  clients must mask, servers must not
 */
function frame(opcode, payload, mask){
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;

  let header;
  if(len < 126){
    header = Buffer.alloc(2);
    header[1] = len;
  } else if(len < 65536){
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    /* Two 32-bit halves rather than writeBigUInt64BE: the high half is
       always zero for anything this program sends, and it keeps the file
       working on older Node without BigInt fuss. */
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode;              // FIN + opcode, never fragmented

  if(!mask) return Buffer.concat([header, data]);

  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for(let i = 0; i < len; i++) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

/**
 * Pulls whole frames out of a stream of bytes, reassembling fragments.
 * Returns a function you feed chunks to.
 */
function reader({ onMessage, onPing, onPong, onClose, onError }){
  let buf = Buffer.alloc(0);
  let fragOpcode = 0, frags = [];

  return function push(chunk){
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    for(;;){
      if(buf.length < 2) return;
      const first = buf[0], second = buf[1];
      const fin = (first & 0x80) !== 0;
      if(first & 0x70) return onError(new Error('reserved bits set — extensions were never negotiated'));
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let len = second & 0x7f;
      let at = 2;

      if(len === 126){
        if(buf.length < at + 2) return;
        len = buf.readUInt16BE(at); at += 2;
      } else if(len === 127){
        if(buf.length < at + 8) return;
        const hi = buf.readUInt32BE(at), lo = buf.readUInt32BE(at + 4);
        len = hi * 4294967296 + lo; at += 8;
        if(len > 64 * 1024 * 1024) return onError(new Error('frame too big'));
      }

      let key = null;
      if(masked){
        if(buf.length < at + 4) return;
        key = buf.slice(at, at + 4); at += 4;
      }
      if(buf.length < at + len) return;            // wait for the rest

      let body = buf.slice(at, at + len);
      buf = buf.slice(at + len);
      if(key){
        const out = Buffer.allocUnsafe(len);
        for(let i = 0; i < len; i++) out[i] = body[i] ^ key[i & 3];
        body = out;
      }

      /* control frames (8,9,10) can arrive in the middle of a fragmented
         message and are never fragmented themselves */
      if(opcode === 0x8){ onClose(body); return; }
      if(opcode === 0x9){ onPing(body); continue; }
      if(opcode === 0xa){ onPong(body); continue; }

      if(opcode === 0x0){
        if(!frags.length) return onError(new Error('continuation with nothing to continue'));
        frags.push(body);
      } else {
        if(frags.length) return onError(new Error('new message started before the last one finished'));
        fragOpcode = opcode;
        frags = [body];
      }

      if(fin){
        const whole = frags.length === 1 ? frags[0] : Buffer.concat(frags);
        frags = [];
        onMessage(whole, fragOpcode === 0x2);
      }
    }
  };
}

/* ---------------- one connection, either end ---------------- */
class Conn extends EventEmitter {
  constructor(socket, isClient){
    super();
    this.socket = socket;
    this._client = isClient;
    this.readyState = OPEN;
    socket.setNoDelay(true);

    const push = reader({
      onMessage: (body, binary) => this.emit('message', binary ? body : body.toString('utf8')),
      onPing: body => this._raw(frame(0xa, body, this._client)),
      onPong: () => {},
      onClose: body => {
        const code = body.length >= 2 ? body.readUInt16BE(0) : 1005;
        if(this.readyState === OPEN){
          this.readyState = CLOSING;
          this._raw(frame(0x8, body.slice(0, 2), this._client));
        }
        this._done(code, body.slice(2).toString('utf8'));
      },
      onError: err => { this.emit('error', err); this.terminate(); },
    });

    socket.on('data', chunk => { try { push(chunk); } catch(err){ this.emit('error', err); this.terminate(); } });
    socket.on('close', () => this._done(1006, ''));
    socket.on('error', err => { this.emit('error', err); this._done(1006, ''); });
  }

  _raw(b){ try { this.socket.write(b); } catch { /* socket is going away */ } }

  _done(code, reason){
    if(this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    try { this.socket.destroy(); } catch {}
    this.emit('close', code, reason);
  }

  send(data){
    if(this.readyState !== OPEN) return;
    const binary = Buffer.isBuffer(data);
    this._raw(frame(binary ? 0x2 : 0x1, data, this._client));
  }

  ping(data = Buffer.alloc(0)){
    if(this.readyState === OPEN) this._raw(frame(0x9, data, this._client));
  }

  close(code = 1000, reason = ''){
    if(this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    const body = Buffer.concat([Buffer.alloc(2), Buffer.from(String(reason), 'utf8')]);
    body.writeUInt16BE(code, 0);
    this._raw(frame(0x8, body, this._client));
    /* Give the other end a moment to answer, then stop waiting. */
    setTimeout(() => this._done(code, reason), 1000).unref?.();
  }

  terminate(){ this._done(1006, ''); }
}

/* ---------------- server ---------------- */
class WebSocketServer extends EventEmitter {
  constructor({ server, path: only = null } = {}){
    super();
    if(!server) throw new Error('ws-lite needs an http server to attach to');
    this.clients = new Set();

    server.on('upgrade', (req, socket, head) => {
      if(String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return;
      if(only && req.url.split('?')[0] !== only) return;
      const key = req.headers['sec-websocket-key'];
      if(!key){ socket.destroy(); return; }

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept(key) + '\r\n\r\n');

      const ws = new Conn(socket, false);
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      this.emit('connection', ws, req);

      /* Bytes that arrived glued to the handshake still have to be read —
         but on the next tick, so listeners attached in the line after
         `new WebSocket(...)` are in place before anything is delivered.
         Feeding them synchronously here loses the first message. */
      if(head && head.length) setImmediate(() => socket.emit('data', head));
    });
  }
  close(cb){ for(const c of this.clients) c.terminate(); if(cb) cb(); }
}

/* ---------------- client ---------------- */
class WebSocket extends EventEmitter {
  constructor(url){
    super();
    this.readyState = CONNECTING;
    this.url = url;

    const u = new URL(url);
    const secure = u.protocol === 'wss:';
    const key = crypto.randomBytes(16).toString('base64');

    const req = (secure ? https : http).request({
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        Host: u.host,
        Origin: (secure ? 'https://' : 'http://') + u.host,
      },
    });

    /* A handshake that hangs is worse than one that fails: the caller
       retries on failure, but waits forever on a hang. */
    req.setTimeout(15000, () => { req.destroy(new Error('handshake timed out')); });

    req.on('upgrade', (res, socket, head) => {
      if(res.headers['sec-websocket-accept'] !== accept(key)){
        socket.destroy();
        this.readyState = CLOSED;
        this.emit('error', new Error('bad handshake answer'));
        this.emit('close', 1006, '');
        return;
      }
      const conn = new Conn(socket, true);
      this._conn = conn;
      this.readyState = OPEN;
      conn.on('message', m => this.emit('message', m));
      conn.on('error', e => this.emit('error', e));
      conn.on('close', (c, r) => { this.readyState = CLOSED; this.emit('close', c, r); });
      this.emit('open');
      if(head && head.length) setImmediate(() => socket.emit('data', head));
    });

    req.on('response', res => {           // answered, but not with an upgrade
      this.readyState = CLOSED;
      this.emit('error', new Error('server refused the websocket: HTTP ' + res.statusCode));
      this.emit('close', 1006, '');
      res.resume();
    });
    req.on('error', err => {
      if(this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this.emit('error', err);
      this.emit('close', 1006, '');
    });
    req.end();
    this._req = req;
  }

  send(data){ if(this._conn) this._conn.send(data); }
  ping(data){ if(this._conn) this._conn.ping(data); }
  close(code, reason){
    if(this._conn) this._conn.close(code, reason);
    else { try { this._req.destroy(); } catch {} this.readyState = CLOSED; }
  }
  terminate(){ if(this._conn) this._conn.terminate(); else { try { this._req.destroy(); } catch {} } }
}

WebSocket.CONNECTING = CONNECTING;
WebSocket.OPEN = OPEN;
WebSocket.CLOSING = CLOSING;
WebSocket.CLOSED = CLOSED;

module.exports = { WebSocketServer, WebSocket, Server: WebSocketServer, frame, reader };
