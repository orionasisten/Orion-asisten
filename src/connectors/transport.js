'use strict';
/* Transport HTTP(S) tunggal tanpa dependensi (Node 16+/Electron 22+): timeout, batas ukuran respons
 * (berhenti di tengah aliran), tanpa kompresi, tanpa pool koneksi, dan lookup tervalidasi. */
const http = require('http');
const https = require('https');
const zlib = require('zlib');

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

function request(o) {
  return new Promise((resolve, reject) => {
    const u = o.url;
    const lib = u.protocol === 'https:' ? https : http;
    const agent = new lib.Agent({ keepAlive: false, maxSockets: 1 });
    const headers = Object.assign({ 'Accept-Encoding': 'gzip, deflate', Connection: 'close' }, o.headers || {});
    let settled = false, timer = null, onAbort = null;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); if (o.signal && onAbort) o.signal.removeEventListener('abort', onAbort); agent.destroy(); fn(v); };
    const req = lib.request(u, { method: o.method, headers, agent, lookup: o.lookup }, res => {
      const enc = String(res.headers['content-encoding'] || 'identity').toLowerCase();
      if (!['identity', 'gzip', 'x-gzip', 'deflate', 'br'].includes(enc)) { done(reject, fail('UNSUPPORTED_ENCODING', 'Encoding respons tidak didukung: ' + enc)); res.destroy(); return; }
      const len = Number(res.headers['content-length']);
      if (Number.isFinite(len) && len > o.maxBytes) { done(reject, fail('RESPONSE_TOO_LARGE', `Respons melebihi batas ${o.maxBytes} byte.`)); res.destroy(); return; }
      const chunks = []; let n = 0;
      res.on('data', c => {
        n += c.length;
        if (n > o.maxBytes) { done(reject, fail('RESPONSE_TOO_LARGE', `Respons melebihi batas ${o.maxBytes} byte.`)); res.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (enc === 'identity') return done(resolve, { status: res.statusCode, headers: res.headers, body: raw });
        const fn = enc === 'deflate' ? zlib.inflate : enc === 'br' ? zlib.brotliDecompress : zlib.gunzip;
        fn(raw, { maxOutputLength: o.maxBytes }, (err, out) => {
          if (err) return done(reject, err.code === 'ERR_BUFFER_TOO_LARGE' ? fail('RESPONSE_TOO_LARGE', `Respons terdekompresi melebihi batas ${o.maxBytes} byte.`) : fail('INVALID_RESPONSE', 'Respons terkompresi rusak.'));
          done(resolve, { status: res.statusCode, headers: res.headers, body: out });
        });
      });
      res.on('error', e => done(reject, e));
      res.on('aborted', () => done(reject, fail('NETWORK', 'Koneksi terputus.')));
    });
    req.on('error', e => done(reject, e.code === 'SSRF_BLOCKED' || e.code === 'DNS_FAILED' || e.code === 'TIMEOUT' || e.code === 'ABORTED' ? e : Object.assign(fail('NETWORK', 'Kesalahan jaringan.'), { cause: e.code })));
    timer = setTimeout(() => { req.destroy(); done(reject, fail('TIMEOUT', `Timeout setelah ${o.timeoutMs} ms.`)); }, o.timeoutMs);
    if (o.signal) {
      if (o.signal.aborted) { req.destroy(); return done(reject, fail('ABORTED', 'Dibatalkan.')); }
      onAbort = () => { req.destroy(); done(reject, fail('ABORTED', 'Dibatalkan.')); };
      o.signal.addEventListener('abort', onAbort);
    }
    if (o.body != null) req.write(o.body);
    req.end();
  });
}

module.exports = { request };
