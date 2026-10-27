'use strict';
/**
 * Klien Orion Central sisi desktop.
 * Token disimpan di main process (bukan renderer) dan di-memory saja per sesi —
 * tidak pernah ditulis ke localStorage renderer.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

class CentralClient {
  constructor(opts){
    opts = opts || {};
    this.baseUrl = opts.baseUrl || '';
    this.token = opts.token || null;
    this.timeoutMs = opts.timeoutMs || 15000;
  }
  get hasToken(){ return !!this.token; }
  setToken(t){ this.token = t || null; }

  _request(method, path, body){
    return new Promise((resolve, reject) => {
      if (!this.baseUrl){ return reject(new Error('CENTRAL_URL_NOT_SET')); }
      let u;
      try { u = new URL(path, this.baseUrl); } catch (e) { return reject(new Error('CENTRAL_URL_INVALID')); }
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;
      const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
      const headers = { Accept: 'application/json' };
      if (payload){ headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
      if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
      const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method, headers, timeout: this.timeoutMs }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
          const err = new Error((json && json.error && json.error.message) || ('HTTP ' + res.statusCode));
          err.code = (json && json.error && json.error.code) || ('HTTP_' + res.statusCode);
          err.status = res.statusCode;
          return reject(err);
        });
      });
      req.on('timeout', () => { req.destroy(new Error('TIMEOUT')); });
      req.on('error', e => reject(e));
      if (payload) req.write(payload);
      req.end();
    });
  }
  health(){ return this._request('GET', '/v1/health'); }
  session(){ return this._request('GET', '/v1/session'); }
  listDevices(){ return this._request('GET', '/v1/devices'); }
  revokeDevice(id){ return this._request('DELETE', '/v1/devices/' + encodeURIComponent(id)); }
  listSessions(){ return this._request('GET', '/v1/sessions'); }
  audit(limit){ return this._request('GET', '/v1/audit?limit=' + (limit || 50)); }
  ready(){ return this._request('GET', '/v1/ready'); }
  pushEvents(events){ return this._request('POST', '/v1/events', { events }); }
  pullEvents(after, limit){ return this._request('GET', '/v1/events?after=' + (after || 0) + '&limit=' + (limit || 100)); }
  listMissions(){ return this._request('GET', '/v1/missions'); }
  getMission(id){ return this._request('GET', '/v1/missions/' + encodeURIComponent(id)); }
  cancelMission(id){ return this._request('POST', '/v1/missions/' + encodeURIComponent(id) + '/cancel', {}); }
  listApprovals(status){ return this._request('GET', '/v1/approvals' + (status ? ('?status=' + status) : '')); }
  decideApproval(id, decision){ return this._request('POST', '/v1/approvals/' + encodeURIComponent(id) + '/decision', { decision }); }
  searchMemory(q, opts){ const s = new URLSearchParams(Object.assign({}, opts||{}, q?{q}:{})); return this._request('GET', '/v1/memory?' + s.toString()); }
  importMemory(records){ return this._request('POST', '/v1/memory/import', { records: records || [] }); }
  importSkillVersions(versions){ return this._request('POST', '/v1/skills/import', { versions: versions || [] }); }
  rollbackImport(){ return this._request('POST', '/v1/memory/rollback-import', {}); }
  // ── percakapan & pesan (multi-perangkat) ──
  listConversations(opts){ const s = new URLSearchParams(opts||{}); return this._request('GET', '/v1/conversations' + (s.toString() ? '?' + s.toString() : '')); }
  getConversation(id){ return this._request('GET', '/v1/conversations/' + encodeURIComponent(id)); }
  createConversation(body){ return this._request('POST', '/v1/conversations', body || {}); }
  updateConversation(id, body){ return this._request('PATCH', '/v1/conversations/' + encodeURIComponent(id), body || {}); }
  deleteConversation(id){ return this._request('DELETE', '/v1/conversations/' + encodeURIComponent(id)); }
  listMessages(id, opts){ const s = new URLSearchParams(opts||{}); return this._request('GET', '/v1/conversations/' + encodeURIComponent(id) + '/messages' + (s.toString() ? '?' + s.toString() : '')); }
  sendMessage(id, body){ return this._request('POST', '/v1/conversations/' + encodeURIComponent(id) + '/messages', body || {}); }
  // ── sesi browser ──
  createSession(body){ return this._request('POST', '/v1/sessions', body || {}); }
  refreshSession(refreshToken){ return this._request('POST', '/v1/sessions/refresh', { refreshToken }); }
  revokeSession(id){ return this._request('DELETE', '/v1/sessions/' + encodeURIComponent(id)); }
  // ── delta feed terpadu ──
  changes(since, opts){ const s = new URLSearchParams(Object.assign({ since: since || 0 }, opts||{})); return this._request('GET', '/v1/sync/changes?' + s.toString()); }
  listSkillVersions(skillId){ return this._request('GET', '/v1/skills/versions' + (skillId ? ('?skillId=' + encodeURIComponent(skillId)) : '')); }
}

module.exports = { CentralClient };
