'use strict';
/**
 * Outbox event sisi desktop — tahan restart.
 * Event ditulis ke file append-only (JSONL) di userData; ditandai synced HANYA setelah
 * server mengonfirmasi commit. Bila aplikasi mati di tengah, event tetap ada dan terkirim ulang
 * (idempoten karena eventId unik).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir){ if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true}); }
function nowISO(){ return new Date().toISOString(); }

class Outbox {
  constructor(dir, opts){
    opts = opts || {};
    this.dir = dir;
    ensureDir(dir);
    this.file = path.join(dir, 'outbox.jsonl');
    this.metaFile = path.join(dir, 'outbox-meta.json');
    this.maxEvents = opts.maxEvents || 5000;
    this.deviceId = opts.deviceId || null;
    this.seq = this._readMeta().seq || 0;
  }
  _readMeta(){
    try { return JSON.parse(fs.readFileSync(this.metaFile,'utf8')); } catch(e){ return { seq: 0 }; }
  }
  _writeMeta(m){ try { fs.writeFileSync(this.metaFile, JSON.stringify(m)); } catch(e){} }

  /** Tambah event ke outbox (belum tersinkron). */
  enqueue(type, payload, meta){
    const ev = {
      eventId: (meta && meta.eventId) || ('ev-' + crypto.randomBytes(10).toString('hex')),
      type,
      schemaVersion: 1,
      deviceSeq: this.seq,
      clientCreatedAt: nowISO(),
      payload: payload || {}
    };
    this.seq++;
    ensureDir(this.dir);
    fs.appendFileSync(this.file, JSON.stringify(ev) + '\n', 'utf8');
    this._writeMeta({ seq: this.seq });
    this._compact();
    return ev;
  }

  /** Apakah event dengan id tertentu sudah ada di outbox (untuk idempotensi). */
  has(eventId){
    return this._readAll().some(e => e.eventId === eventId);
  }

  /** Ambil event yang belum tersinkron. Entri `failed` TIDAK di-retry otomatis. */
  pending(limit){
    const all = this._readAll().filter(e => e.state !== 'failed');
    const limitN = Math.min(Math.max(limit || 100, 1), 500);
    return all.slice(0, limitN);
  }

  /** Ambil satu entri (termasuk yang failed) untuk status pengiriman yang akurat. */
  get(eventId){
    return this._readAll().find(e => e.eventId === eventId) || null;
  }

  /** Tandai event sudah tersinkron (HANYA setelah server konfirmasi commit). */
  markSynced(eventIds){
    if (!eventIds || !eventIds.length) return;
    const done = new Set(eventIds);
    const all = this._readAll();
    const rest = all.filter(e => !done.has(e.eventId));
    this._rewrite(rest);
  }

  /**
   * Tandai gagal permanen TANPA menghapus. Entri tetap tersimpan agar bisa
   * diperiksa/dipulihkan secara sadar lewat retryFailed(eventId).
   */
  markFailed(eventIds, reason){
    if (!eventIds || !eventIds.length) return;
    const bad = new Set(eventIds);
    const at = nowISO();
    const all = this._readAll().map(e => bad.has(e.eventId)
      ? Object.assign({}, e, { state: 'failed', lastError: String(reason || '').slice(0, 300), failedAt: at })
      : e);
    this._rewrite(all);
  }

  /** Pemulihan sadar: jadikan entri failed kembali pending. */
  retryFailed(eventIds){
    if (!eventIds || !eventIds.length) return;
    const want = new Set(eventIds);
    const all = this._readAll().map(e => want.has(e.eventId)
      ? Object.assign({}, e, { state: undefined, retriedAt: nowISO() })
      : e);
    this._rewrite(all);
  }

  count(){ return this._readAll().length; }
  countPending(){ return this._readAll().filter(e => e.state !== 'failed').length; }
  countFailed(){ return this._readAll().filter(e => e.state === 'failed').length; }
  clear(){ this._rewrite([]); }

  _readAll(){
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch(e){ return []; }
    const out = [];
    text.split('\n').forEach(line => {
      if (!line.trim()) return;
      try { out.push(JSON.parse(line)); } catch(e){ /* baris rusak dilewati, bukan fatal */ }
    });
    return out;
  }
  _rewrite(events){
    const tmp = this.file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, this.file);
  }
  _compact(){
    const all = this._readAll();
    if (all.length > this.maxEvents){
      // Entri `failed` adalah data pengguna yang belum terkirim — jangan pernah
      // dibuang otomatis hanya karena batas ukuran. Buang event pending terlama.
      const failed = all.filter(e => e.state === 'failed');
      const rest = all.filter(e => e.state !== 'failed');
      const keep = Math.max(0, this.maxEvents - failed.length);
      this._rewrite(rest.slice(rest.length - keep).concat(failed));
    }
  }
}

module.exports = { Outbox, nowISO };
