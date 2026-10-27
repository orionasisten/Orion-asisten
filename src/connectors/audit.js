'use strict';
/* Audit log append-only (JSONL) dengan rantai hash (tamper-evident, BUKAN immutable: pelaku yang bisa
 * menulis berkas tetap dapat menghapus seluruh log). Semua string disaring dari secret sebelum ditulis. */
const fs = require('fs');
const crypto = require('crypto');
const { redactText } = require('./redact');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const GENESIS = '0'.repeat(64);

function createAudit(o) {
  const file = o.file;
  const now = o.now || (() => new Date().toISOString());
  const secrets = o.secrets || (() => []);
  let prev = GENESIS, seq = 0;
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) { const last = JSON.parse(lines[lines.length - 1]); prev = last.hash; seq = last.seq; }
  } catch (e) { /* log baru */ }

  const clean = v => (typeof v === 'string' ? redactText(v, secrets())
    : Array.isArray(v) ? v.map(clean)
      : v && typeof v === 'object' ? Object.keys(v).reduce((a, k) => { a[k] = clean(v[k]); return a; }, {}) : v);

  function record(evt) {
    const body = clean(Object.assign({ seq: ++seq, ts: now(), id: crypto.randomBytes(6).toString('hex') }, evt, { prev }));
    const hash = sha(JSON.stringify(body));
    fs.appendFileSync(file, JSON.stringify(Object.assign({}, body, { hash })) + '\n', { mode: 0o600 });
    prev = hash;
    return hash;
  }

  function readAll() {
    try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; }
  }
  function verify() {
    const recs = readAll(); let p = GENESIS;
    for (let i = 0; i < recs.length; i++) {
      const { hash, ...rest } = recs[i];
      if (rest.prev !== p || sha(JSON.stringify(rest)) !== hash) return { ok: false, count: recs.length, brokenAt: i + 1 };
      p = hash;
    }
    return { ok: true, count: recs.length };
  }
  return { record, verify, tail: n => readAll().slice(-(n || 20)) };
}
module.exports = { createAudit };
