'use strict';
/**
 * Integrasi Desktop ↔ Orion Central (main process).
 *
 * - Token perangkat disimpan terenkripsi oleh main process (safeStorage) — TIDAK pernah
 *   diekspos ke renderer, tidak pernah ditulis ke log, tidak pernah di URL.
 * - Outbox pesan persisten (file) dengan idempotency key stabil → retry tidak menduplikasi.
 * - SSE untuk notifikasi + delta feed untuk catch-up (kursor persisten).
 * - Semua permintaan diverifikasi server (owner scope + device revocation).
 */
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const { CentralClient } = require('./client');
const { Outbox } = require('./outbox');

const TOKEN_KEY = 'centraltoken';
const POLL_MS = 15000;
const SSE_RECONNECT_BASE = 5000;
const SSE_RECONNECT_MAX = 60000;

class CentralDesktop {
  constructor(opts){
    opts = opts || {};
    this.getWindow = opts.getWindow || (() => null);
    this.userData = opts.userData;
    this.readToken = opts.readToken || (() => null);
    this.writeToken = opts.writeToken || (() => {});
    this.readState = opts.readState || (() => ({}));
    this.writeState = opts.writeState || (() => {});
    this.log = opts.log || (() => {});
    this.baseUrl = (opts.baseUrl || process.env.ORION_CENTRAL_URL || '').replace(/\/+$/, '');
    this.outbox = new Outbox(path.join(this.userData, 'central-outbox-messages'), { maxEvents: 2000 });
    this.client = new CentralClient({ baseUrl: this.baseUrl, timeoutMs: 20000 });
    this.status = { configured: !!this.baseUrl, connected: false, lastSyncAt: null, lastError: null, pending: 0, deviceId: null, sse: false, revoked: false };
    this.cursor = Number(this.readState().centralCursor || 0);
    this._timer = null;
    this._sse = null;
    this._sseAttempt = 0;
    this._stopped = false;
    this._flushing = false;
  }

  /* ── token & identitas ── */
  _token(){ try { return this.readToken(TOKEN_KEY); } catch (e) { return null; } }
  hasToken(){ return !!this._token(); }
  async login(token){
    const t = String(token || '').trim();
    if (!t || t.length < 20) throw new Error('TOKEN_TIDAK_VALID');
    this.client.setToken(t);
    const s = await this.client.session();
    this.writeToken(TOKEN_KEY, t);
    this.status.deviceId = s.deviceId || null;
    this.status.revoked = false;
    this.start();
    this._emit({ type: 'central:login' });
    return s;
  }
  async logout(){
    try { await this.client._request('DELETE', '/v1/sessions/current').catch(() => null); } catch (e) { /* ignore */ }
    this.client.setToken(null);
    this.writeToken(TOKEN_KEY, null);
    this.stop();
    this.status.connected = false; this.status.sse = false; this.status.deviceId = null;
  }
  async verify(){
    if (!this.baseUrl || !this.hasToken()) { this.status.connected = false; return false; }
    try {
      const s = await this.client.session();
      this.status.connected = true; this.status.deviceId = s.deviceId || null; this.status.revoked = false; this.status.lastError = null;
      return true;
    } catch (e) {
      this.status.connected = false;
      const msg = String((e && e.message) || e);
      if (/SESSION_REVOKED|TOKEN_REVOKED|DEVICE_REVOKED|DEVICE_UNKNOWN|TOKEN_INACTIVE|UNAUTHENTICATED|SESSION_EXPIRED|TOKEN_EXPIRED/.test(msg)) this.status.revoked = true;
      this.status.lastError = msg;
      return false;
    }
  }

  /* ── percakapan ── */
  async listConversations(){ return this.client.listConversations(50); }
  async getConversation(id){ return this.client.getConversation(id); }
  async createConversation(title, clientKey){ return this.client.createConversation(title, clientKey); }
  async updateConversation(id, patch){ return this.client.updateConversation(id, patch); }
  async removeConversation(id){ return this.client.deleteConversation(id); }
  async importConversations(convos){ return this.client._request('POST', '/v1/conversations/import', { conversations: convos || [] }); }

  /* ── outbox pesan ── */
  async sendMessage(conversationId, msg){
    const clientMessageId = String(msg.clientMessageId || msg.id || '');
    if (!clientMessageId) throw new Error('ID_PESAN_INVALID');
    const eventId = 'msg-' + clientMessageId;
    if (this.outbox.has(eventId)){
      const prev = this.outbox.get(eventId);
      return { status: prev && prev.state === 'failed' ? 'failed' : 'pending', clientMessageId, sent: false };
    }
    this.outbox.enqueue('message.send', { conversationId, role: msg.role || 'user', content: String(msg.content || ''), clientMessageId }, { eventId });
    this.status.pending = this.outbox.countPending();
    // Coba kirim sekarang; status HANYA 'sent' bila entri ini benar-benar sudah
    // dihapus dari outbox setelah server mengonfirmasi commit.
    await this.flushOutbox();
    const entry = this.outbox.get(eventId);
    const status = !entry ? 'sent' : (entry.state === 'failed' ? 'failed' : 'pending');
    return { status, clientMessageId, sent: status === 'sent' };
  }
  async flushOutbox(){
    if (this._flushing) return { sent: false, reason: 'BUSY' };
    this._flushing = true;
    let sent = false;
    try {
      const pending = this.outbox.pending(100);
      for (const item of pending){
        if (item.type !== 'message.send') continue;
        const p = item.payload || {};
        try {
          await this.client.sendMessage(p.conversationId, { role: p.role, content: p.content, clientMessageId: p.clientMessageId });
          this.outbox.markSynced([item.eventId]);
          sent = true;
        } catch (e) {
          const msg = String((e && e.message) || e);
          const code = String((e && e.code) || '');
          if (/SESSION_REVOKED|TOKEN_REVOKED|DEVICE_REVOKED|DEVICE_UNKNOWN|TOKEN_INACTIVE|UNAUTHENTICATED|SESSION_EXPIRED|TOKEN_EXPIRED/.test(code + ' ' + msg)){
            this.status.revoked = true;
            this.status.lastError = msg;
            break; // hentikan pengiriman; identitas dicabut/expired
          }
          if (/NOT_FOUND|BAD_|CONFLICT|DUPLICATE|FORBIDDEN/.test(code + ' ' + msg)){
            // Entri tidak bisa dikirim (mis. percakapan dihapus): simpan sebagai
            // failed permanen agar isi pesan tidak hilang. Tidak di-retry otomatis;
            // Owner dapat memicu retryFailed setelah memperbaiki penyebabnya.
            this.outbox.markFailed([item.eventId], code + ' ' + msg);
            this._emit({ type: 'outbox.failed', eventId: item.eventId, reason: msg });
            continue;
          }
          // transient (jaringan/server) → biarkan di outbox untuk percobaan berikutnya
          break;
        }
      }
    } finally {
      this._flushing = false;
      this.status.pending = this.outbox.countPending();
    }
    return { sent };
  }

  /* ── delta catch-up + SSE ── */
  async catchUp(){
    if (!this.hasToken()) return [];
    try {
      const res = await this.client.changes(this.cursor, 200);
      const out = [];
      if (res.changes && res.changes.length){
        for (const ch of res.changes){
          this.cursor = Math.max(this.cursor, Number(ch.cursor) || 0);
          out.push(ch);
          this._emit({ type: ch.type, payload: ch.payload, cursor: this.cursor, changeId: ch.id });
        }
        this.writeState({ centralCursor: this.cursor });
        this.status.lastSyncAt = new Date().toISOString();
      }
      return out;
    } catch (e) {
      this.status.lastError = String((e && e.message) || e);
      return [];
    }
  }
  _emit(ev){
    const w = this.getWindow();
    if (w && w.webContents) { try { w.webContents.send('orion:central:event', ev); } catch (e) { /* ignore */ } }
  }
  _connectSse(){
    if (this._stopped || !this.baseUrl || !this.hasToken()) return;
    let u;
    try { u = new URL(this.baseUrl + '/v1/stream'); } catch (e) { return; }
    const lib = u.protocol === 'https:' ? https : http;
    const token = this._token();
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'GET',
      headers: { Accept: 'text/event-stream', Authorization: 'Bearer ' + token, 'Cache-Control': 'no-cache' }
    }, res => {
      if (res.statusCode !== 200){ res.resume(); this._scheduleSse(); return; }
      this._sse = req;
      this._sseAttempt = 0;
      this.status.sse = true;
      this.status.connected = true;
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0){
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let evName = 'message', data = '';
          raw.split('\n').forEach(line => {
            if (line.startsWith('event:')) evName = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          });
          if (!data) continue;
          try {
            const obj = JSON.parse(data);
            if (evName === 'change' && obj && typeof obj.cursor === 'number'){
              this.cursor = Math.max(this.cursor, obj.cursor);
              this.writeState({ centralCursor: this.cursor });
              this.status.lastSyncAt = new Date().toISOString();
              this._emit({ type: obj.type, payload: obj.payload, cursor: this.cursor, changeId: obj.id });
            } else if (evName === 'ready'){
              this.status.connected = true;
              void this.catchUp();
            }
          } catch (e) { /* payload rusak diabaikan */ }
        }
      });
      res.on('end', () => { this.status.sse = false; this._scheduleSse(); });
    });
    req.on('error', () => { this.status.sse = false; this._scheduleSse(); });
    req.end();
  }
  _scheduleSse(){
    if (this._stopped) return;
    const delay = Math.min(SSE_RECONNECT_BASE * Math.pow(2, this._sseAttempt++), SSE_RECONNECT_MAX);
    setTimeout(() => this._connectSse(), delay);
  }

  /* ── siklus hidup ── */
  start(){
    if (this._timer) return;
    this._stopped = false;
    void this.verify().then(ok => { if (ok){ void this.catchUp(); this._connectSse(); } });
    this._timer = setInterval(() => {
      if (this._stopped) return;
      void this.verify();
      void this.flushOutbox();
      void this.catchUp();
    }, POLL_MS);
  }
  stop(){
    this._stopped = true;
    if (this._timer){ clearInterval(this._timer); this._timer = null; }
    try { if (this._sse){ this._sse.destroy(); this._sse = null; } } catch (e) { /* ignore */ }
    this.status.sse = false;
  }
  getStatus(){
    this.status.pending = this.outbox.countPending();
    return Object.assign({}, this.status, {
      configured: !!this.baseUrl, hasToken: this.hasToken(), cursor: this.cursor,
      outbox: this.outbox.count(), pending: this.outbox.countPending(), failed: this.outbox.countFailed()
    });
  }
}

module.exports = { CentralDesktop, TOKEN_KEY };
