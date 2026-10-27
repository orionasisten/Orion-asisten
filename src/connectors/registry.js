'use strict';
/**
 * Registry API connector. Lima keadaan yang sengaja dipisahkan:
 *   katalog (discovered) → connector ditinjau (reviewed) → diuji (tested) → diaktifkan (enabled)
 *   → digunakan (usage.count > 0, dicatat gateway saat panggilan benar-benar terjadi).
 * Masuk katalog ≠ izin. Mengubah konfigurasi relevan keamanan membatalkan status tested/enabled.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateHostPattern, matchHost } = require('./netguard');
const { validatePath } = require('./pathutil');
const { assertSupported } = require('./schema');

const ID_RE = /^[a-z0-9][a-z0-9-]{2,47}$/;
const AUTH = ['none', 'apiKey', 'bearer', 'oauth'];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const RISK = ['read-public', 'read-private', 'write', 'high-impact'];
const RANK = { 'read-public': 0, 'read-private': 1, write: 2, 'high-impact': 3 };
const CLASSES = ['public', 'internal', 'confidential'];
const BAD_HEADER = /^(host|content-length|transfer-encoding|connection|cookie|set-cookie|upgrade|te|trailer|proxy-.*|accept-encoding|user-agent|content-type|accept|authorization)$/i;

class ValidationError extends Error { constructor(list) { super(list.join(' ')); this.name = 'ValidationError'; this.errors = list; } }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const int = (v, d, lo, hi, label, errs) => {
  if (v == null) return d;
  if (!Number.isInteger(v) || v < lo || v > hi) { errs.push(`${label} harus bilangan bulat ${lo}–${hi}.`); return d; }
  return v;
};

function minRisk(c) {
  if (c.allowedMethods.some(m => m !== 'GET' && m !== 'HEAD')) return 'write';
  if (c.authType !== 'none' || c.dataClassification !== 'public') return 'read-private';
  return 'read-public';
}

function configHash(c) {
  const f = { baseUrl: c.baseUrl, allowedHosts: c.allowedHosts, allowedMethods: c.allowedMethods, authType: c.authType, auth: c.auth, riskLevel: c.riskLevel, dataClassification: c.dataClassification, limits: c.limits, rateLimit: c.rateLimit, responseSchema: c.responseSchema || null, testPath: c.testPath || null };
  return sha(JSON.stringify(f));
}

function normalize(inp, guard) {
  const errs = [];
  const c = {};
  const i = inp || {};
  c.id = String(i.id || '');
  if (!ID_RE.test(c.id)) errs.push('id: huruf kecil/angka/-, 3–48 karakter.');
  c.name = String(i.name || '').trim().slice(0, 80); if (!c.name) errs.push('name wajib diisi.');
  c.category = String(i.category || 'uncategorized').slice(0, 40);
  c.description = String(i.description || '').slice(0, 300);

  c.authType = i.authType || 'none';
  if (!AUTH.includes(c.authType)) errs.push('authType tidak dikenal.');
  if (c.authType === 'oauth') errs.push('OAuth belum didukung (hanya DESIGNED). Gunakan none, apiKey, atau bearer.');
  c.auth = null; c.requiredSecrets = [];
  if (c.authType === 'apiKey') {
    const a = i.auth || {};
    const where = a.in === 'query' ? 'query' : 'header';
    const nm = String(a.name || (where === 'header' ? 'X-Api-Key' : 'api_key'));
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(nm)) errs.push('auth.name tidak valid.');
    if (where === 'header' && BAD_HEADER.test(nm)) errs.push(`auth.name tidak boleh header "${nm}".`);
    c.auth = { in: where, name: nm }; c.requiredSecrets = ['apiKey'];
  } else if (c.authType === 'bearer') { c.auth = { in: 'header', name: 'Authorization', scheme: 'Bearer' }; c.requiredSecrets = ['token']; }

  c.allowedMethods = [...new Set((i.allowedMethods && i.allowedMethods.length ? i.allowedMethods : ['GET']).map(m => String(m).toUpperCase()))];
  if (c.allowedMethods.some(m => !METHODS.includes(m))) errs.push('allowedMethods berisi metode tidak valid.');

  try {
    const list = (i.allowedHosts || []).map(validateHostPattern);
    if (!list.length || list.length > 10) errs.push('allowedHosts: 1–10 pola host.');
    c.allowedHosts = [...new Set(list)];
  } catch (e) { errs.push(e.message); c.allowedHosts = []; }

  c.baseUrl = '';
  try {
    const u = guard.validateUrl(String(i.baseUrl || ''), { allowedHosts: c.allowedHosts });
    if (u.search) throw new Error('baseUrl tidak boleh berisi query.');
    c.baseUrl = u.origin + u.pathname.replace(/\/+$/, '');
  } catch (e) { errs.push('baseUrl: ' + e.message); }

  c.documentationUrl = '';
  if (i.documentationUrl) { try { const d = new URL(String(i.documentationUrl)); if (d.protocol !== 'https:' && d.protocol !== 'http:') throw new Error('x'); c.documentationUrl = d.toString().slice(0, 300); } catch (e) { errs.push('documentationUrl tidak valid.'); } }

  c.dataClassification = i.dataClassification || 'public';
  if (!CLASSES.includes(c.dataClassification)) errs.push('dataClassification tidak valid.');
  const rl = i.rateLimit || {};
  c.rateLimit = { perMinute: int(rl.perMinute, 30, 1, 600, 'rateLimit.perMinute', errs) };
  const uc = i.usageCost || {};
  c.usageCost = { model: ['free', 'metered', 'unknown'].includes(uc.model) ? uc.model : 'unknown' };
  if (uc.model && !['free', 'metered', 'unknown'].includes(uc.model)) errs.push('usageCost.model tidak valid.');
  if (c.usageCost.model === 'metered') c.usageCost.unitCost = Number.isFinite(uc.unitCost) && uc.unitCost >= 0 ? uc.unitCost : 1;
  c.license = String(i.license || 'unknown').slice(0, 120);

  const lim = i.limits || {};
  c.limits = {
    timeoutMs: int(lim.timeoutMs, 10000, 1000, 30000, 'limits.timeoutMs', errs),
    maxResponseBytes: int(lim.maxResponseBytes, 1048576, 1024, 5242880, 'limits.maxResponseBytes', errs),
    maxRequestBytes: int(lim.maxRequestBytes, 65536, 0, 262144, 'limits.maxRequestBytes', errs),
    retries: int(lim.retries, 2, 0, 3, 'limits.retries', errs)
  };

  const need = errs.length ? 'read-public' : minRisk(c);
  c.riskLevel = i.riskLevel || need;
  if (!RISK.includes(c.riskLevel)) errs.push('riskLevel tidak valid.');
  else if (RANK[c.riskLevel] < RANK[need]) errs.push(`riskLevel "${c.riskLevel}" terlalu rendah untuk konfigurasi ini (minimal "${need}").`);

  if (i.responseSchema != null) {
    try { if (JSON.stringify(i.responseSchema).length > 8192) throw new Error('Schema > 8 KB.'); assertSupported(i.responseSchema); c.responseSchema = i.responseSchema; } catch (e) { errs.push('responseSchema: ' + e.message); }
  }
  if (i.testPath) { try { c.testPath = validatePath(String(i.testPath)); } catch (e) { errs.push('testPath: ' + e.message); } }

  if (errs.length) throw new ValidationError(errs);
  c.source = i.source && typeof i.source === 'object' ? i.source : { type: 'manual' };
  return c;
}

function createRegistry(o) { // o: { file, guard, now }
  const now = o.now || (() => new Date().toISOString());
  let db = { version: 1, catalog: {}, connectors: {}, meta: { lastSyncAt: null } };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(o.file, 'utf8'))); } catch (e) { /* baru */ }
  const save = () => {
    const tmp = o.file + '.tmp';
    fs.mkdirSync(path.dirname(o.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, o.file);
  };
  const need = id => { const c = db.connectors[id]; if (!c) throw new Error('Connector tidak ditemukan.'); return c; };
  const view = c => JSON.parse(JSON.stringify(c));

  return {
    /* katalog */
    importCatalog(entries, meta) {
      let added = 0, updated = 0;
      entries.forEach(e => {
        const cur = db.catalog[e.id];
        if (cur) { db.catalog[e.id] = Object.assign({}, e, { state: cur.state, connectorId: cur.connectorId, firstSeenAt: cur.firstSeenAt, lastSeenAt: now() }); updated++; }
        else { db.catalog[e.id] = Object.assign({}, e, { firstSeenAt: now(), lastSeenAt: now() }); added++; }
      });
      db.meta.lastSyncAt = (meta && meta.syncedAt) || now();
      save();
      return { added, updated, total: Object.keys(db.catalog).length };
    },
    listCatalog(f) {
      const q = String((f && f.q) || '').toLowerCase(), cat = f && f.category, auth = f && f.auth;
      let list = Object.values(db.catalog).filter(e => (!q || (e.name + ' ' + e.description).toLowerCase().includes(q)) && (!cat || e.category === cat) && (!auth || e.authType === auth));
      list.sort((a, b) => a.name.localeCompare(b.name));
      const total = list.length, off = (f && f.offset) || 0, lim = Math.min((f && f.limit) || 30, 100);
      return { total, items: list.slice(off, off + lim).map(view), categories: [...new Set(Object.values(db.catalog).map(e => e.category))].sort(), lastSyncAt: db.meta.lastSyncAt };
    },
    getCatalogEntry: id => (db.catalog[id] ? view(db.catalog[id]) : null),

    /* connector */
    review(input, opts) {
      const c = normalize(input, o.guard);
      if (db.connectors[c.id]) throw new ValidationError(['id sudah dipakai; gunakan update.']);
      const cat = opts && opts.catalogId ? db.catalog[opts.catalogId] : null;
      if (cat) c.source = Object.assign({}, cat.source, { catalogId: cat.id });
      Object.assign(c, { status: 'reviewed', healthStatus: 'unknown', lastVerifiedAt: null, lastTest: null, createdAt: now(), reviewedAt: now(), usage: { count: 0, lastUsedAt: null, missions: [] } });
      c.configHash = configHash(c);
      db.connectors[c.id] = c;
      if (cat) { cat.state = 'reviewed'; cat.connectorId = c.id; }
      save(); return view(c);
    },
    update(id, patch) {
      const cur = need(id);
      if (cur.status === 'revoked') throw new Error('Connector sudah dicabut.');
      const merged = Object.assign({}, cur, patch, { id });
      const c = normalize(merged, o.guard);
      Object.assign(c, { status: cur.status, healthStatus: cur.healthStatus, lastVerifiedAt: cur.lastVerifiedAt, lastTest: cur.lastTest, createdAt: cur.createdAt, reviewedAt: cur.reviewedAt, usage: cur.usage, source: cur.source });
      c.configHash = configHash(c);
      if (c.configHash !== cur.configHash && ['tested', 'enabled', 'disabled'].includes(cur.status)) { c.status = 'reviewed'; c.lastTest = null; c.healthStatus = 'unknown'; c.reviewedAt = now(); }
      db.connectors[id] = c; save(); return view(c);
    },
    recordTest(id, r) {
      const c = need(id);
      c.lastTest = { ok: !!r.ok, status: r.status || null, bytes: r.bytes || 0, error: r.error || null, at: r.at || now(), configHash: c.configHash };
      c.healthStatus = r.ok ? 'healthy' : r.authFailed ? 'auth_failed' : r.unreachable ? 'unreachable' : 'degraded';
      if (r.ok) { c.lastVerifiedAt = c.lastTest.at; if (c.status === 'reviewed') c.status = 'tested'; }
      save(); return view(c);
    },
    setHealth(id, healthStatus) { const c = need(id); c.healthStatus = healthStatus; save(); },
    enable(id, approval) {
      const c = need(id);
      if (approval !== 'user-dialog') throw new Error('Pengaktifan membutuhkan persetujuan pengguna.');
      if (!['tested', 'disabled'].includes(c.status)) throw new Error('Connector harus berstatus "tested" sebelum diaktifkan.');
      if (!c.lastTest || !c.lastTest.ok || c.lastTest.configHash !== c.configHash) throw new Error('Uji ulang diperlukan: konfigurasi berubah sejak uji terakhir.');
      c.status = 'enabled'; c.enabledAt = now(); save(); return view(c);
    },
    disable(id) { const c = need(id); if (c.status === 'enabled') { c.status = 'disabled'; save(); } return view(c); },
    revoke(id) { const c = need(id); c.status = 'revoked'; c.revokedAt = now(); save(); return view(c); },
    remove(id) {
      const c = need(id);
      if (c.status === 'enabled') throw new Error('Nonaktifkan connector sebelum menghapus.');
      delete db.connectors[id];
      Object.values(db.catalog).forEach(e => { if (e.connectorId === id) { e.state = 'discovered'; delete e.connectorId; } });
      save();
    },
    markUsed(id, missionId) {
      const c = need(id); c.usage.count++; c.usage.lastUsedAt = now();
      if (missionId && !c.usage.missions.includes(missionId)) { c.usage.missions.push(missionId); c.usage.missions = c.usage.missions.slice(-20); }
      save();
    },
    get: id => (db.connectors[id] ? view(db.connectors[id]) : null),
    list: () => Object.values(db.connectors).map(view),
    stats: () => ({ catalog: Object.keys(db.catalog).length, connectors: Object.keys(db.connectors).length, lastSyncAt: db.meta.lastSyncAt })
  };
}

module.exports = { createRegistry, normalize, ValidationError, configHash, RANK, matchHost };
