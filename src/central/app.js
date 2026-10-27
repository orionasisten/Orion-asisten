'use strict';
/**
 * Orion Central — aplikasi HTTP (API v1).
 * Semua handler default-deny: butuh token valid (owner + device scope).
 * Owner ID SELALU berasal dari token, tidak pernah dari body/param klien.
 */
const { Router, errorBody } = require('./api/router');
const { PolicyError, requireAuth, assertOwnership, canAccessMemory, conflictPolicy } = require('./policy/scope');
const tokens = require('./auth/tokens');
const audit = require('./audit');
const { id, nowISO } = require('./auth/tokens');
const crypto = require('crypto');
const migrator = require('./migrate/migrate-local');
const webauth = require('./webauth');
const conv = require('./conversations');

function json(res, status, body){
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function parseBody(raw, maxBytes){
  if (!raw || raw.length === 0) return {};
  if (raw.length > maxBytes){ const e = new Error('PAYLOAD_TOO_LARGE'); e.code = 'PAYLOAD_TOO_LARGE'; e.status = 413; throw e; }
  try { return JSON.parse(raw.toString('utf8')); } catch (e) {
    const err = new Error('BAD_JSON'); err.code = 'BAD_JSON'; err.status = 400; throw err;
  }
}

function requireFields(obj, fields){
  const missing = fields.filter(f => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length){ const e = new Error('MISSING_FIELDS: ' + missing.join(',')); e.code = 'MISSING_FIELDS'; e.status = 400; throw e; }
}

// ── rate limiter per token/owner+IP (in-memory; didokumentasikan sebagai single-instance) ──
function csrfValid(ctx){
  const sent = ctx.headers['x-csrf-token'] || '';
  const expect = ctx.cookies && ctx.cookies[webauth.COOKIE.CSRF] || '';
  return !!sent && !!expect && sent === expect;
}

/**
 * SSE memakai identitas saat koneksi dibuka; status harus dicek ulang agar token/sesi
 * yang dicabut tidak terus menerima data.
 */
async function authContextActive(db, ctx){
  if (!ctx || !ctx.ownerId) return false;
  if (ctx.authMethod === 'cookie' && ctx.sessionId) return conv.isSessionActive(db, ctx.sessionId, ctx.ownerId);
  if (ctx.tokenId) return tokens.isTokenActive(db, ctx.tokenId, ctx.ownerId);
  return false;
}

function clientIp(req, cfg){
  if (cfg && cfg.trustProxy){
    const xff = String((req.headers && req.headers['x-forwarded-for']) || '');
    const first = xff.split(',')[0].trim();
    if (first) return first.replace(/^::ffff:/, '').slice(0, 200);
  }
  return String((req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
}

function createApp(opts){
  const cfg = opts.config;
  const db = opts.db;
  const router = new Router();
  const { InMemoryRateLimiter, PgRateLimiter } = require('./rate-limit/store');
  const rateBackend = (cfg.nodeEnv === 'production' && cfg.driver === 'postgres' && db) ? 'postgres' : 'memory';
  if (rateBackend === 'postgres') {
    if (!db || typeof db.query !== 'function') {
      throw new Error('CONFIG: production PostgreSQL requires valid db for shared rate limit');
    }
  }
  const rateLimit = rateBackend === 'postgres'
    ? PgRateLimiter(cfg.rateLimitPerMin, db)
    : InMemoryRateLimiter(cfg.rateLimitPerMin);
  const loginThrottle = webauth.createLoginThrottle(cfg.loginMaxAttempts || 10, 15 * 60 * 1000);
  const now = () => new Date().toISOString();

  // ── health & readiness (tanpa auth, tanpa membocorkan detail internal) ──
  router.get('/v1/health', () => ({ status: 200, body: { status: 'ok', service: 'orion-central', version: opts.version || '1.0.0' } }));
  router.get('/v1/ready', async () => {
    // Readiness WAJIB punya timeout: DB yang macet tidak boleh membuat health check menggantung.
    const timeoutMs = opts.readinessTimeoutMs || 3000;
    try {
      const check = await Promise.race([
        (async () => {
          await db.query('SELECT 1 AS ok');
          const migs = await db.query('SELECT count(*) AS c FROM schema_migrations');
          return { migrations: Number(migs[0] && migs[0].c) || 0 };
        })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('READINESS_TIMEOUT')), timeoutMs))
      ]);
      return { status: 200, body: { status: 'ready', migrations: check.migrations } };
    } catch (e) {
      return { status: 503, body: { status: 'not_ready', error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Database tidak tersedia.' } } };
    }
  });

  // ── auth bootstrap (dilindungi setup key; TIDAK bisa membuat owner tanpa otorisasi) ──
  router.post('/v1/auth/bootstrap', async (ctx) => {
    const setupKey = opts.setupKey || '';
    if (!setupKey) throw new PolicyError('SETUP_DISABLED', 'Bootstrap dinonaktifkan (CENTRAL_SETUP_KEY tidak diset).', 403);
    if (ctx.headers['x-setup-key'] !== setupKey) throw new PolicyError('FORBIDDEN', 'Setup key salah.', 403);
    const body = ctx.body || {};
    requireFields(body, ['email']);
    const existing = await db.query('SELECT id FROM owners WHERE email = ?', [String(body.email)]);
    if (existing.length) throw new PolicyError('OWNER_EXISTS', 'Owner sudah ada.', 409);
    const ownerId = id('own');
    const password = body.password ? String(body.password) : (opts.setupPassword || '');
    await db.query('INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at, password_hash, password_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ownerId, String(body.email).slice(0, 200), String(body.displayName || '').slice(0, 80), 'owner', 'active', now(), now(),
       password ? webauth.hashPassword(password) : null, password ? now() : null]);
    const issued = await tokens.issueToken(db, { ownerId, label: 'bootstrap', scopes: ['default', 'auth:issue'], ttlHours: cfg.tokenTtlHours });
    await audit.record(db, { ownerId, actor: 'setup', action: 'owner.bootstrap', outcome: 'ok', metadata: { hasPassword: !!password } });
    return { status: 201, body: { ownerId, token: issued.token, tokenId: issued.record.id, expiresAt: issued.record.expires_at, passwordConfigured: !!password } };
  });

  // ── devices ──
  router.post('/v1/devices', async (ctx) => {
    const body = ctx.body || {};
    requireFields(body, ['name']);
    const deviceId = id('dev');
    await db.query(`INSERT INTO devices (id, owner_id, name, platform, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [deviceId, ctx.ownerId, String(body.name).slice(0, 80), String(body.platform || '').slice(0, 40), 'active', now(), now()]);
    const issued = await tokens.issueToken(db, { ownerId: ctx.ownerId, deviceId, label: String(body.name).slice(0, 80), scopes: ['default'], ttlHours: cfg.tokenTtlHours });
    await audit.record(db, { ownerId: ctx.ownerId, deviceId, actor: 'device', action: 'device.register', targetType: 'device', targetId: deviceId });
    return { status: 201, body: { deviceId, token: issued.token, tokenId: issued.record.id, expiresAt: issued.record.expires_at } };
  });
  router.get('/v1/devices', async (ctx) => {
    const rows = await db.query('SELECT id, name, platform, status, created_at, last_seen_at FROM devices WHERE owner_id = ? ORDER BY created_at', [ctx.ownerId]);
    return { status: 200, body: { devices: rows } };
  });
  router.delete('/v1/devices/:id', async (ctx) => {
    const dev = await assertOwnership(db, 'devices', ctx.params.id, ctx, ['id', 'owner_id', 'status']);
    await db.query('UPDATE devices SET status = ?, revoked_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?', ['revoked', now(), now(), dev.id, ctx.ownerId]);
    await tokens.revokeDeviceTokens(db, dev.id, ctx.ownerId);
    // Sesi browser milik device ikut dicabut (re-multi-device: akses revoked device = 401)
    await db.query('UPDATE sessions SET status = ?, revoked_at = ? WHERE owner_id = ? AND device_id = ? AND status = ?',
      ['revoked', now(), ctx.ownerId, dev.id, 'active']);
    // Push token milik device yang dicabut tidak boleh tetap menjadi target notifikasi.
    await db.query('UPDATE push_tokens SET status = ?, revoked_at = ?, updated_at = ? WHERE owner_id = ? AND device_id = ? AND status = ?',
      ['revoked', now(), now(), ctx.ownerId, dev.id, 'active']);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: dev.id, actor: 'owner', action: 'device.revoke', targetType: 'device', targetId: dev.id });
    return { status: 200, body: { ok: true, deviceId: dev.id } };
  });

  // ── tokens ──
  router.post('/v1/auth/token', async (ctx) => {
    if (!ctx.scopes.includes('auth:issue')) throw new PolicyError('FORBIDDEN', 'Scope auth:issue dibutuhkan.', 403);
    const body = ctx.body || {};
    const requested = Array.isArray(body.scopes) && body.scopes.length ? body.scopes.map(String) : ['default'];
    // Tidak boleh memberi scope yang tidak dimiliki pemanggil.
    const escalated = requested.filter(s => !ctx.scopes.includes(s));
    if (escalated.length) throw new PolicyError('SCOPE_ESCALATION', 'Scope melebihi izin pemanggil.', 403);
    let deviceId = body.deviceId || ctx.deviceId || null;
    if (body.deviceId){
      const dev = await db.query('SELECT status FROM devices WHERE id = ? AND owner_id = ?', [String(body.deviceId), ctx.ownerId]);
      if (!dev.length) throw new PolicyError('DEVICE_NOT_OWNED', 'Perangkat tidak ditemukan untuk owner ini.', 403);
      if (dev[0].status !== 'active') throw new PolicyError('DEVICE_REVOKED', 'Perangkat telah dicabut.', 403);
      deviceId = String(body.deviceId);
    }
    const issued = await tokens.issueToken(db, { ownerId: ctx.ownerId, deviceId, label: String(body.label || '').slice(0, 120), scopes: requested, ttlHours: cfg.tokenTtlHours });
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'owner', action: 'token.issue' });
    return { status: 201, body: { tokenId: issued.record.id, token: issued.token, expiresAt: issued.record.expires_at } };
  });
  router.post('/v1/auth/token/:id/rotate', async (ctx) => {
    const res = await tokens.rotateToken(db, ctx.params.id, ctx.ownerId, { ttlHours: cfg.tokenTtlHours });
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'owner', action: 'token.rotate', targetType: 'token', targetId: ctx.params.id });
    return { status: 200, body: { token: res.token, tokenId: res.record.id, expiresAt: res.record.expires_at } };
  });
  router.delete('/v1/auth/token/:id', async (ctx) => {
    const res = await tokens.revokeToken(db, ctx.params.id, ctx.ownerId);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'owner', action: 'token.revoke', targetType: 'token', targetId: ctx.params.id, outcome: res.ok ? 'ok' : 'error', reason: res.reason });
    if (!res.ok) throw new PolicyError('TOKEN_NOT_FOUND', 'Token tidak ditemukan.', 404);
    return { status: 200, body: { ok: true } };
  });

  // ── missions ──
  router.post('/v1/missions', async (ctx) => {
    const body = ctx.body || {};
    requireFields(body, ['title']);
    if (body.budgetLimit !== undefined && !Number.isFinite(Number(body.budgetLimit))) throw new PolicyError('BUDGET_INVALID', 'Anggaran harus angka.', 400);
    if (Number(body.budgetLimit) < 0) throw new PolicyError('BUDGET_INVALID', 'Anggaran tidak boleh negatif.', 400);
    if (body.maxExecutions !== undefined && !Number.isFinite(Number(body.maxExecutions))) throw new PolicyError('EXECUTION_INVALID', 'Batas eksekusi harus angka.', 400);
    if (Number(body.maxExecutions) < 0) throw new PolicyError('EXECUTION_INVALID', 'Batas eksekusi tidak boleh negatif.', 400);
    const missionId = body.id && /^ms-[a-z0-9-]{6,}$/i.test(String(body.id)) ? String(body.id) : id('ms');
    const dup = await db.query('SELECT id FROM missions WHERE id = ? AND owner_id = ?', [missionId, ctx.ownerId]);
    if (dup.length) throw new PolicyError('DUPLICATE', 'Misi dengan id itu sudah ada.', 409);
    await db.query(`INSERT INTO missions (id, owner_id, device_id, title, goal, state, budget_limit, budget_currency, max_executions, created_at, updated_at, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [missionId, ctx.ownerId, ctx.deviceId, String(body.title).slice(0, 200), String(body.goal || '').slice(0, 4000),
       'queued', Number.isFinite(body.budgetLimit) ? body.budgetLimit : null, String(body.currency || 'unit'),
       Number.isFinite(body.maxExecutions) ? body.maxExecutions : 100, now(), now(), JSON.stringify(body.metadata || {})]);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'owner', action: 'mission.create', targetType: 'mission', targetId: missionId });
    return { status: 201, body: { missionId } };
  });
  router.get('/v1/missions', async (ctx) => {
    const rows = await db.query('SELECT id, title, goal, state, budget_limit, budget_spent, budget_reserved, budget_currency, executions, max_executions, created_at, updated_at, completed_at FROM missions WHERE owner_id = ? ORDER BY created_at DESC', [ctx.ownerId]);
    return { status: 200, body: { missions: rows } };
  });
  router.get('/v1/missions/:id', async (ctx) => {
    const m = await assertOwnership(db, 'missions', ctx.params.id, ctx, ['*']);
    const tasks = await db.query('SELECT id, title, state, deps, attempts, max_attempts, started_at, completed_at, last_error FROM mission_tasks WHERE mission_id = ? AND owner_id = ? ORDER BY created_at', [m.id, ctx.ownerId]);
    const approvals = await db.query('SELECT id, task_id, action, resource, fingerprint, status, decision, created_at, expires_at FROM approvals WHERE mission_id = ? AND owner_id = ?', [m.id, ctx.ownerId]);
    return { status: 200, body: { mission: m, tasks, approvals } };
  });
  router.post('/v1/missions/:id/cancel', async (ctx) => {
    const m = await assertOwnership(db, 'missions', ctx.params.id, ctx, ['id', 'state']);
    if (['completed', 'cancelled'].includes(m.state)) throw new PolicyError('CONFLICT', 'Misi sudah final.', 409);
    await db.query('UPDATE missions SET state = ?, updated_at = ? WHERE id = ? AND owner_id = ?', ['cancelled', now(), m.id, ctx.ownerId]);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'owner', action: 'mission.cancel', targetType: 'mission', targetId: m.id });
    return { status: 200, body: { ok: true, missionId: m.id, state: 'cancelled' } };
  });

  // ── approvals (server-authoritative) ──
  router.get('/v1/approvals', async (ctx) => {
    const status = ctx.query.get('status') || null;
    const rows = status
      ? await db.query('SELECT id, mission_id, task_id, action, resource, params, scope, fingerprint, status, decision, created_at, expires_at FROM approvals WHERE owner_id = ? AND status = ? ORDER BY created_at', [ctx.ownerId, status])
      : await db.query('SELECT id, mission_id, task_id, action, resource, params, scope, fingerprint, status, decision, created_at, expires_at FROM approvals WHERE owner_id = ? ORDER BY created_at', [ctx.ownerId]);
    return { status: 200, body: { approvals: rows } };
  });
  router.post('/v1/approvals/:id/decision', async (ctx) => {
    const body = ctx.body || {};
    requireFields(body, ['decision']);
    const decision = String(body.decision);
    if (!['approved', 'rejected'].includes(decision)) throw new PolicyError('BAD_DECISION', 'Decision harus approved|rejected.', 400);
    const a = await assertOwnership(db, 'approvals', ctx.params.id, ctx, ['*']);
    if (a.status !== 'pending') throw new PolicyError('ALREADY_DECIDED', 'Approval sudah diputuskan.', 409);
    if (new Date(a.expires_at) <= new Date()) throw new PolicyError('EXPIRED', 'Approval kedaluwarsa.', 409);
    await db.query('UPDATE approvals SET status = ?, decision = ?, decided_by = ?, decided_at = ? WHERE id = ? AND owner_id = ? AND status = ?',
      [decision, decision, ctx.ownerId, now(), a.id, ctx.ownerId, 'pending']);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'owner', action: 'approval.' + decision, targetType: 'approval', targetId: a.id, metadata: { fingerprint: a.fingerprint } });
    return { status: 200, body: { ok: true, approvalId: a.id, status: decision } };
  });

  // ── events (sync) ──
  const sync = require('./sync/events');
  router.post('/v1/events', async (ctx) => {
    const body = ctx.body || {};
    const events = Array.isArray(body.events) ? body.events : [];
    if (events.length > 500) throw new PolicyError('TOO_MANY_EVENTS', 'Maksimal 500 event per batch.', 413);
    const res = await sync.uploadEvents(db, ctx, events);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'device', action: 'events.upload', metadata: { accepted: res.accepted, duplicates: res.duplicates, rejected: res.rejected } });
    return { status: 200, body: res };
  });
  router.get('/v1/events', async (ctx) => {
    const after = parseInt(ctx.query.get('after') || '0', 10) || 0;
    const limit = Math.min(parseInt(ctx.query.get('limit') || '100', 10) || 100, 500);
    const res = await sync.pullEvents(db, ctx, after, limit);
    return { status: 200, body: res };
  });

  // ── memory (metadata + provenance, scope enforced SERVER-SIDE) ──
  // `scope` query hanya memilih konteks; bukan pemberian izin. Tanpa konteks,
  // hanya memory global yang terlihat. Konteks misi diverifikasi kepemilikannya.
  const memoryAccess = async (ctx) => {
    const requested = ctx.query.get('scope') || 'global';
    if (requested === 'global') return { scope: 'global' };
    if (requested === 'mission'){
      const missionId = String(ctx.query.get('missionId') || '').trim();
      if (!missionId) throw new PolicyError('MISSION_CONTEXT_REQUIRED', 'missionId wajib untuk scope mission.', 400);
      await assertOwnership(db, 'missions', missionId, ctx, ['id']);
      return { scope: 'mission', missionId };
    }
    // Scope skill/session hanya untuk konteks internal; tidak diekspos lewat API.
    throw new PolicyError('SCOPE_CONTEXT_UNAVAILABLE', 'Konteks scope tidak didukung.', 400);
  };
  router.get('/v1/memory', async (ctx) => {
    const access = await memoryAccess(ctx);
    const q = (ctx.query.get('q') || '').toLowerCase();
    const type = ctx.query.get('type') || null;
    const status = ctx.query.get('status') || 'active';
    let rows = await db.query('SELECT * FROM memory_records WHERE owner_id = ? AND status = ?', [ctx.ownerId, status]);
    if (access.scope === 'mission') rows = rows.filter(r => r.mission_id === access.missionId);
    if (type) rows = rows.filter(r => r.type === type);
    if (q) rows = rows.filter(r => (r.content + ' ' + (r.source_ref || '') + ' ' + (r.excerpt || '')).toLowerCase().includes(q));
    const visible = rows.filter(r => canAccessMemory({ scope: r.scope, mission_id: r.mission_id, sensitivity: r.sensitivity, status: r.status }, access));
    return { status: 200, body: { records: visible, scope: access.scope, missionId: access.missionId || null } };
  });
  router.get('/v1/memory/:id', async (ctx) => {
    const access = await memoryAccess(ctx);
    const rec = await assertOwnership(db, 'memory_records', ctx.params.id, ctx, ['*']);
    if (!canAccessMemory({ scope: rec.scope, mission_id: rec.mission_id, sensitivity: rec.sensitivity, status: rec.status }, access)){
      throw new PolicyError('NOT_FOUND_OR_FORBIDDEN', 'Data tidak ditemukan.', 404);
    }
    const versions = await db.query('SELECT id, content_version, verification_status, integrity_hash, reason, created_at FROM memory_versions WHERE record_id = ? AND owner_id = ? ORDER BY content_version', [rec.id, ctx.ownerId]);
    return { status: 200, body: { record: rec, versions } };
  });

  // ── skill versions (metadata + aktivasi terotorisasi) ──
  router.get('/v1/skills/versions', async (ctx) => {
    const skillId = ctx.query.get('skillId') || null;
    const rows = skillId
      ? await db.query('SELECT version_id, skill_id, version, content_hash, state, created, evaluation, quarantined FROM skill_versions WHERE owner_id = ? AND skill_id = ? ORDER BY created', [ctx.ownerId, skillId])
      : await db.query('SELECT version_id, skill_id, version, content_hash, state, created, evaluation, quarantined FROM skill_versions WHERE owner_id = ? ORDER BY created', [ctx.ownerId]);
    return { status: 200, body: { versions: rows } };
  });
  router.get('/v1/skills/versions/:id', async (ctx) => {
    const v = await assertOwnership(db, 'skill_versions', ctx.params.id, ctx, ['*']);
    const evals = await db.query('SELECT id, content_hash, evaluator_version, test_suite_version, result, failures, limitations, created_at FROM skill_evaluations WHERE version_id = ? AND owner_id = ? ORDER BY created_at', [v.version_id, ctx.ownerId]);
    const auditRows = await db.query('SELECT action, from_state, to_state, reason, actor, created_at FROM skill_lifecycle_audit WHERE version_id = ? AND owner_id = ? ORDER BY created_at', [v.version_id, ctx.ownerId]);
    return { status: 200, body: { version: v, evaluations: evals, lifecycle: auditRows } };
  });
  router.post('/v1/skills/versions/:id/activate', async (ctx) => {
    const v = await assertOwnership(db, 'skill_versions', ctx.params.id, ctx, ['*']);
    const skills = require('./skills/service');
    const res = await skills.activate(db, ctx, v);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'owner', action: 'skill.activate', targetType: 'skill_version', targetId: v.version_id });
    return { status: 200, body: res };
  });

  // ── jobs (hanya pihak berwenang) ──
  router.get('/v1/jobs', async (ctx) => {
    const state = ctx.query.get('state') || null;
    const rows = state
      ? await db.query('SELECT id, mission_id, kind, state, attempts, max_attempts, available_at, lease_expires_at, last_error, created_at, updated_at FROM jobs WHERE owner_id = ? AND state = ? ORDER BY created_at DESC', [ctx.ownerId, state])
      : await db.query('SELECT id, mission_id, kind, state, attempts, max_attempts, available_at, lease_expires_at, last_error, created_at, updated_at FROM jobs WHERE owner_id = ? ORDER BY created_at DESC', [ctx.ownerId]);
    return { status: 200, body: { jobs: rows } };
  });
  router.get('/v1/jobs/:id', async (ctx) => {
    const j = await assertOwnership(db, 'jobs', ctx.params.id, ctx, ['*']);
    const attempts = await db.query('SELECT attempt, worker_id, outcome, error, started_at, finished_at FROM job_attempts WHERE job_id = ? AND owner_id = ? ORDER BY attempt', [j.id, ctx.ownerId]);
    return { status: 200, body: { job: j, attempts } };
  });
  router.post('/v1/jobs/:id/retry', async (ctx) => {
    const j = await assertOwnership(db, 'jobs', ctx.params.id, ctx, ['*']);
    if (!['failed', 'dead_letter'].includes(j.state)) throw new PolicyError('CONFLICT', 'Job tidak dalam status yang bisa di-retry.', 409);
    if (j.dead_letter) throw new PolicyError('DEAD_LETTER', 'Job sudah dead-letter; perlu pemeriksaan manual.', 409);
    await db.query('UPDATE jobs SET state = ?, available_at = ?, attempts = 0, worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND owner_id = ?',
      ['queued', now(), now(), j.id, ctx.ownerId]);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'owner', action: 'job.retry', targetType: 'job', targetId: j.id });
    return { status: 200, body: { ok: true, jobId: j.id, state: 'queued' } };
  });

  // ── percakapan & pesan (fondasi multi-perangkat) ──
  router.post('/v1/conversations', async (ctx) => {
    const r = await conv.createConversation(db, ctx, ctx.body || {});
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'device', action: 'conversation.create', targetType: 'conversation', targetId: r.conversation.id });
    return { status: r.duplicate ? 200 : 201, body: { conversation: r.conversation, duplicate: !!r.duplicate } };
  });
  router.get('/v1/conversations', async (ctx) => {
    const r = await conv.listConversations(db, ctx, ctx.query);
    return { status: 200, body: r };
  });
  router.get('/v1/conversations/:id', async (ctx) => {
    const c = await conv.getConversation(db, ctx, ctx.params.id);
    const msgs = await conv.listMessages(db, ctx, c.id, new URLSearchParams('limit=20'));
    return { status: 200, body: { conversation: c, messages: msgs.messages } };
  });
  router.patch('/v1/conversations/:id', async (ctx) => {
    const c = await conv.updateConversation(db, ctx, ctx.params.id, ctx.body || {});
    return { status: 200, body: { conversation: c } };
  });
  router.delete('/v1/conversations/:id', async (ctx) => {
    const r = await conv.deleteConversation(db, ctx, ctx.params.id);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'device', action: 'conversation.delete', targetType: 'conversation', targetId: ctx.params.id });
    return { status: 200, body: r };
  });
  router.post('/v1/conversations/:id/messages', async (ctx) => {
    const r = await conv.addMessage(db, ctx, ctx.params.id, ctx.body || {});
    return { status: r.duplicate ? 200 : 201, body: { message: r.message, duplicate: !!r.duplicate } };
  });
  router.get('/v1/conversations/:id/messages', async (ctx) => {
    const r = await conv.listMessages(db, ctx, ctx.params.id, ctx.query);
    return { status: 200, body: r };
  });

  // ── sesi browser (web/PWA) ──
  // mode 'cookie' (default bila Origin web diizinkan): token hanya di cookie HttpOnly.
  // mode 'body': token dikembalikan di body (untuk klien non-browser / desktop).
  const wantsCookie = (body, ctx) => {
    if (body && body.delivery === 'body') return false;
    if (body && body.delivery === 'cookie') return true;
    return !!ctx.cookies && (!!ctx.cookies[webauth.COOKIE.ACCESS] || !!ctx.cookies[webauth.COOKIE.REFRESH] || !!ctx.originAllowed);
  };
  const logoutSelf = async (ctx) => {
    let revokedSession = false;
    let revokedToken = false;
    let ownerId = ctx.ownerId || null;
    let deviceId = ctx.deviceId || null;
    // Tanpa access yang valid (kedaluwarsa), logout via cookie refresh tetap harus
    // bisa mencabut sesi. Handler memverifikasi bukti refresh token + CSRF sendiri.
    if (!ctx.sessionId && !ctx.tokenId && ctx.cookies && (ctx.cookies[webauth.COOKIE.ACCESS] || ctx.cookies[webauth.COOKIE.REFRESH])){
      if (!csrfValid(ctx)) throw new PolicyError('CSRF_FAILED', 'Token CSRF tidak valid.', 403);
      const hashes = [ctx.cookies[webauth.COOKIE.ACCESS], ctx.cookies[webauth.COOKIE.REFRESH]]
        .filter(Boolean).map(webauth.hashToken);
      const rows = await db.query(`SELECT * FROM sessions WHERE status = ? AND (access_token_hash IN (${hashes.map(() => '?').join(',')}) OR refresh_token_hash IN (${hashes.map(() => '?').join(',')}))`,
        ['active', ...hashes, ...hashes]);
      if (rows.length){
        ownerId = rows[0].owner_id;
        deviceId = rows[0].device_id;
        const r = await conv.revokeSession(db, { ownerId }, rows[0].id);
        revokedSession = !!r.ok;
      }
    }
    if (ctx.sessionId){
      const r = await conv.revokeSession(db, { ownerId }, ctx.sessionId);
      revokedSession = !!r.ok;
    }
    if (ctx.tokenId){
      const r = await tokens.revokeToken(db, ctx.tokenId, ownerId);
      revokedToken = !!r.ok;
    }
    // Logout harus selalu membersihkan cookie (HttpOnly tidak bisa dihapus JS).
    if (ctx.cookies && (ctx.cookies[webauth.COOKIE.ACCESS] || ctx.cookies[webauth.COOKIE.REFRESH])){
      ctx.setCookies(webauth.clearSessionCookies(ctx.isSecure, ctx.crossSite));
    }
    if (!revokedSession && !revokedToken && !ownerId) throw new PolicyError('UNAUTHENTICATED', 'Autentikasi diperlukan.', 401);
    if (ownerId) await audit.record(db, { ownerId, deviceId, actor: 'owner', action: 'auth.logout', metadata: { revokedSession, revokedToken } });
    return { status: 200, body: { ok: true, revokedSession, revokedToken } };
  };
  router.post('/v1/sessions', async (ctx) => {
    const body = ctx.body || {};
    const r = await conv.createSession(db, ctx, body);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'device', action: 'session.create', targetType: 'session', targetId: r.sessionId });
    if (wantsCookie(body, ctx)){
      const csrf = webauth.randomCsrf();
      ctx.setCookies(webauth.sessionCookies({
        accessToken: r.accessToken, refreshToken: r.refreshToken, csrfToken: csrf,
        accessExpiresAt: r.accessExpiresAt, refreshExpiresAt: r.refreshExpiresAt,
        secure: ctx.isSecure, crossSite: ctx.crossSite
      }));
      return { status: 201, body: { sessionId: r.sessionId, accessExpiresAt: r.accessExpiresAt, refreshExpiresAt: r.refreshExpiresAt, csrfToken: csrf, delivery: 'cookie' } };
    }
    return { status: 201, body: Object.assign({}, r, { delivery: 'body' }) };
  });
  router.post('/v1/sessions/refresh', async (ctx) => {
    const body = ctx.body || {};
    const cookieRefresh = ctx.cookies && ctx.cookies[webauth.COOKIE.REFRESH];
    const viaCookie = !body.refreshToken && !!cookieRefresh;
    // Refresh via cookie tidak memerlukan access token (boleh kedaluwarsa), tetapi
    // tetap wajib CSRF double-submit. Token di body adalah bearer credential (klien native).
    if (viaCookie && !csrfValid(ctx)) throw new PolicyError('CSRF_FAILED', 'Token CSRF tidak valid.', 403);
    const refreshToken = body.refreshToken || cookieRefresh;
    const r = await conv.refreshSession(db, ctx, refreshToken);
    if (viaCookie){
      const csrf = webauth.randomCsrf();
      ctx.setCookies(webauth.sessionCookies({
        accessToken: r.accessToken, refreshToken: r.refreshToken, csrfToken: csrf,
        accessExpiresAt: r.accessExpiresAt, refreshExpiresAt: r.refreshExpiresAt,
        secure: ctx.isSecure, crossSite: ctx.crossSite
      }));
      return { status: 200, body: { sessionId: r.sessionId, accessExpiresAt: r.accessExpiresAt, refreshExpiresAt: r.refreshExpiresAt, csrfToken: csrf, delivery: 'cookie' } };
    }
    return { status: 200, body: Object.assign({}, r, { delivery: 'body' }) };
  });
  router.get('/v1/sessions', async (ctx) => ({ status: 200, body: { sessions: await conv.listSessions(db, ctx) } }));
  // Endpoint logout eksplisit. `/current` tidak boleh jatuh ke route `/:id`.
  router.delete('/v1/sessions/current', logoutSelf);
  router.delete('/v1/sessions', logoutSelf);
  router.delete('/v1/sessions/:id', async (ctx) => {
    const r = await conv.revokeSession(db, ctx, ctx.params.id);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'owner', action: 'session.revoke', targetType: 'session', targetId: ctx.params.id });
    if (ctx.cookies && ctx.cookies[webauth.COOKIE.ACCESS]) ctx.setCookies(webauth.clearSessionCookies(ctx.isSecure, ctx.crossSite));
    return { status: 200, body: r };
  });

  // ── login Owner (web) ──
  router.post('/v1/auth/login', async (ctx) => {
    const body = ctx.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) throw new PolicyError('MISSING_FIELDS', 'Email dan password wajib.', 400);
    if (!ctx.loginThrottle(ctx.ip + '|' + email)) throw new PolicyError('RATE_LIMITED', 'Terlalu banyak percobaan login.', 429);
    const rows = await db.query('SELECT * FROM owners WHERE lower(email) = ?', [email]);
    const owner = rows.length ? rows[0] : null;
    // SELALU jalankan scrypt (hash dummy untuk email tidak dikenal / owner tanpa password)
    // agar waktu respons tidak membocorkan keberadaan akun.
    const storedHash = owner && owner.password_hash ? owner.password_hash : webauth.DUMMY_PASSWORD_HASH;
    const ok = webauth.verifyPassword(password, storedHash) && !!owner && !!owner.password_hash && owner.status === 'active';
    if (!ok){
      // Email tidak dikenal → tidak bisa menulis audit ter-scope owner (owner_id wajib & ter-FK);
      // percobaan tetap tercatat melalui throttle login.
      if (owner) await audit.record(db, { ownerId: owner.id, actor: 'web', action: 'auth.login', outcome: 'denied', reason: 'INVALID_CREDENTIALS' });
      throw new PolicyError('INVALID_CREDENTIALS', 'Email atau password salah.', 401);
    }
    const deviceId = String(body.deviceId || '').slice(0, 64) || null;
    const r = await conv.createSession(db, { ownerId: owner.id, deviceId }, { userAgent: body.userAgent, delivery: body.delivery });
    await audit.record(db, { ownerId: owner.id, deviceId, actor: 'web', action: 'auth.login', outcome: 'ok' });
    if (body.delivery !== 'body'){
      const csrf = webauth.randomCsrf();
      ctx.setCookies(webauth.sessionCookies({
        accessToken: r.accessToken, refreshToken: r.refreshToken, csrfToken: csrf,
        accessExpiresAt: r.accessExpiresAt, refreshExpiresAt: r.refreshExpiresAt,
        secure: ctx.isSecure, crossSite: ctx.crossSite
      }));
      return { status: 200, body: { sessionId: r.sessionId, ownerId: owner.id, displayName: owner.display_name, accessExpiresAt: r.accessExpiresAt, csrfToken: csrf, delivery: 'cookie' } };
    }
    return { status: 200, body: Object.assign({ ownerId: owner.id, displayName: owner.display_name }, r, { delivery: 'body' }) };
  });

  // ── ganti password Owner ──
  router.post('/v1/auth/change-password', async (ctx) => {
    const body = ctx.body || {};
    const rows = await db.query('SELECT * FROM owners WHERE id = ?', [ctx.ownerId]);
    if (!rows.length) throw new PolicyError('NOT_FOUND', 'Owner tidak ditemukan.', 404);
    const owner = rows[0];
    if (!webauth.verifyPassword(String(body.oldPassword || ''), owner.password_hash || '')) throw new PolicyError('INVALID_CREDENTIALS', 'Password lama salah.', 401);
    const np = String(body.newPassword || '');
    if (np.length < 10) throw new PolicyError('WEAK_PASSWORD', 'Password baru minimal 10 karakter.', 400);
    if (np.length > webauth.MAX_PASSWORD_CHARS) throw new PolicyError('WEAK_PASSWORD', 'Password baru terlalu panjang.', 400);
    await db.query('UPDATE owners SET password_hash = ?, password_updated_at = ? WHERE id = ?', [webauth.hashPassword(np), nowISO(), ctx.ownerId]);
    // Kredensial lain yang masih hidup setelah password berubah adalah risiko
    // (token lama/pencuri tetap punya akses). Pertahankan hanya kredensial saat ini.
    const s = await conv.revokeOtherSessions(db, ctx.ownerId, ctx.sessionId || null);
    const t = await tokens.revokeOtherTokens(db, ctx.ownerId, ctx.tokenId || null);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'owner', action: 'auth.change_password', outcome: 'ok', metadata: { sessionsRevoked: s.revoked, tokensRevoked: t.revoked } });
    return { status: 200, body: { ok: true, sessionsRevoked: s.revoked, tokensRevoked: t.revoked } };
  });

  // ──-info sesi saat ini (untuk web app) ──
  router.get('/v1/session', async (ctx) => {
    const rows = await db.query('SELECT id, display_name, email, role FROM owners WHERE id = ?', [ctx.ownerId]);
    const owner = rows.length ? rows[0] : {};
    return { status: 200, body: {
      ownerId: ctx.ownerId,
      displayName: owner.display_name || '',
      email: owner.email || '',
      role: ctx.role || owner.role || 'owner',
      deviceId: ctx.deviceId || null,
      authMethod: ctx.authMethod || 'bearer',
      expiresAt: ctx.tokenExpiresAt || null
    } };
  });

  // ── set password awal (owner yang di-bootstrap tanpa password) ──
  router.post('/v1/auth/set-initial-password', async (ctx) => {
    const body = ctx.body || {};
    const rows = await db.query('SELECT id, password_hash FROM owners WHERE id = ?', [ctx.ownerId]);
    if (!rows.length) throw new PolicyError('NOT_FOUND', 'Owner tidak ditemukan.', 404);
    if (rows[0].password_hash) throw new PolicyError('CONFLICT', 'Password sudah diatur — gunakan change-password.', 409);
    const pw = String(body.password || '');
    if (pw.length < 10) throw new PolicyError('WEAK_PASSWORD', 'Password minimal 10 karakter.', 400);
    if (pw.length > webauth.MAX_PASSWORD_CHARS) throw new PolicyError('WEAK_PASSWORD', 'Password terlalu panjang.', 400);
    await db.query('UPDATE owners SET password_hash = ?, password_updated_at = ? WHERE id = ?', [webauth.hashPassword(pw), nowISO(), ctx.ownerId]);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'owner', action: 'auth.set_initial_password', outcome: 'ok' });
    return { status: 200, body: { ok: true } };
  });

  // ── inferensi sisi server ──
  // BELUM ADA worker/eksekutor resmi yang menegakkan scope, budget misi, approval,
  // idempotensi, dan usage accounting. Karena itu endpoint ini TIDAK memanggil
  // provider secara langsung (itu akan melewati boundary misi). Status aman yang
  // eksplisit lebih benar daripada eksekusi tanpa kontrol.
  router.post('/v1/conversations/:id/respond', async (ctx) => {
    // Tetap verifikasi kepemilikan agar tidak menjadi oracle 404/503 lintas owner.
    await assertOwnership(db, 'conversations', ctx.params.id, ctx, ['id']);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'central', action: 'conversation.infer', targetType: 'conversation', targetId: ctx.params.id, outcome: 'unavailable', reason: 'INFERENCE_WORKER_UNAVAILABLE' });
    throw new PolicyError('INFERENCE_WORKER_UNAVAILABLE', 'Jawaban AI belum tersedia: worker inferensi resmi (budget/approval/idempotensi) belum diimplementasikan.', 503);
  });

  router.post('/v1/conversations/import', async (ctx) => {
    const report = await conv.importConversations(db, ctx, ctx.body || {});
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'device', action: 'conversation.import', metadata: { found: report.found, imported: report.imported, skipped: report.skipped, failed: report.failed, conflicts: report.conflicts.length } });
    return { status: 200, body: report };
  });

  // ── push token perangkat (untuk notifikasi mobile) ──
  // Token push = identifier notifikasi, bukan rahasia. Tetap terautentikasi & ter-scope owner.
  router.post('/v1/push/register', async (ctx) => {
    const body = ctx.body || {};
    const token = String(body.token || '').trim();
    const platform = ['android', 'ios'].includes(String(body.platform)) ? String(body.platform) : null;
    if (!token || token.length < 10 || token.length > 4096) throw new PolicyError('TOKEN_INVALID', 'Token push tidak valid.', 400);
    if (!platform) throw new PolicyError('PLATFORM_INVALID', 'Platform harus android|ios.', 400);
    // Token push harus terikat ke perangkat pemiliknya; token owner tanpa device
    // tidak boleh mendaftarkan token notifikasi milik perangkat mana pun.
    if (!ctx.deviceId) throw new PolicyError('DEVICE_REQUIRED', 'Pendaftaran push membutuhkan token perangkat.', 403);
    const ts = now();
    const existing = await db.query('SELECT id, owner_id, device_id FROM push_tokens WHERE token = ?', [token]);
    if (existing.length && existing[0].owner_id !== ctx.ownerId){
      // JANGAN ambil alih: token yang sudah dimiliki Owner lain adalah konflik.
      await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'device', action: 'push.token.register', outcome: 'denied', reason: 'OWNED_BY_OTHER_OWNER' });
      throw new PolicyError('PUSH_TOKEN_CONFLICT', 'Token push sudah terikat ke Owner lain.', 409);
    }
    if (existing.length && existing[0].device_id && existing[0].device_id !== ctx.deviceId){
      await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'device', action: 'push.token.register', outcome: 'denied', reason: 'OWNED_BY_OTHER_DEVICE' });
      throw new PolicyError('PUSH_TOKEN_CONFLICT', 'Token push sudah terikat ke perangkat lain.', 409);
    }
    if (existing.length){
      const upd = await db.exec(`UPDATE push_tokens
                                 SET device_id = ?, status = ?, revoked_at = NULL, platform = ?, last_seen_at = ?, updated_at = ?
                                 WHERE id = ? AND owner_id = ? AND (device_id IS NULL OR device_id = ?)`,
        [ctx.deviceId, 'active', platform, ts, ts, existing[0].id, ctx.ownerId, ctx.deviceId]);
      if (!upd.changes) throw new PolicyError('PUSH_TOKEN_CONFLICT', 'Token push sudah terikat ke perangkat lain.', 409);
      return { status: 200, body: { ok: true, id: existing[0].id } };
    }
    const pushId = id('pt');
    try {
      await db.query(`INSERT INTO push_tokens (id, owner_id, device_id, platform, token, status, last_seen_at, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [pushId, ctx.ownerId, ctx.deviceId, platform, token, 'active', ts, ts, ts]);
    } catch (e) {
      // Balapan insert: ulangi resolusi konflik secara aman, jangan overwrite owner.
      const again = await db.query('SELECT id, owner_id, device_id FROM push_tokens WHERE token = ?', [token]);
      if (!again.length || again[0].owner_id !== ctx.ownerId || (again[0].device_id && again[0].device_id !== ctx.deviceId)){
        throw new PolicyError('PUSH_TOKEN_CONFLICT', 'Token push sudah terikat ke identitas lain.', 409);
      }
      await db.query('UPDATE push_tokens SET status = ?, platform = ?, last_seen_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
        ['active', platform, ts, ts, again[0].id, ctx.ownerId]);
      return { status: 200, body: { ok: true, id: again[0].id } };
    }
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'device', action: 'push.token.register', metadata: { platform } });
    return { status: 201, body: { ok: true, id: pushId } };
  });
  router.post('/v1/push/revoke', async (ctx) => {
    const body = ctx.body || {};
    const token = String(body.token || '').trim();
    const res = await db.exec('UPDATE push_tokens SET status = ?, revoked_at = ?, updated_at = ? WHERE token = ? AND owner_id = ?',
      ['revoked', now(), now(), token, ctx.ownerId]);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'device', action: 'push.token.revoke' });
    return { status: 200, body: { ok: (res.changes && res.changes > 0) } };
  });
  router.get('/v1/push/tokens', async (ctx) => {
    // Hanya token milik perangkat yang sedang terautentikasi. Tidak ada daftar
    // token seluruh owner (mengurangi permukaan penyalahgunaan notifikasi).
    if (!ctx.deviceId) throw new PolicyError('DEVICE_REQUIRED', 'Token perangkat diperlukan.', 403);
    const rows = await db.query('SELECT id, device_id, platform, status, created_at, last_seen_at FROM push_tokens WHERE owner_id = ? AND device_id = ? ORDER BY created_at', [ctx.ownerId, ctx.deviceId]);
    return { status: 200, body: { tokens: rows } };
  });

  // ── unified delta feed (semua entitas, satu cursor) ──
  router.get('/v1/sync/changes', async (ctx) => {
    const since = parseInt(ctx.query.get('since') || '0', 10) || 0;
    const limit = Math.min(Math.max(parseInt(ctx.query.get('limit') || '100', 10) || 100, 1), 500);
    const types = ctx.query.get('types');
    const where = ['owner_id = ?', 'cursor > ?'];
    const params = [ctx.ownerId, since];
    if (types){
      const want = [...new Set(String(types).split(',').map(s => s.trim()).filter(Boolean))].slice(0, 50);
      if (!want.length) return { status: 200, body: { changes: [], cursor: since, hasMore: false } };
      where.push('type IN (' + want.map(() => '?').join(',') + ')');
      params.push(...want);
    }
    // Filter dilakukan DI SQL sebelum LIMIT; hasMore dihitung dari limit+1 agar
    // `types` tidak menghasilkan hasMore palsu.
    const rows = await db.query(
      'SELECT id, cursor, device_id, type, schema_version, payload, client_created_at, received_at FROM events WHERE ' +
      where.join(' AND ') + ' ORDER BY cursor ASC LIMIT ' + (limit + 1),
      params);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.length ? Number(page[page.length - 1].cursor) : since;
    return { status: 200, body: { changes: page, cursor: last, hasMore } };
  });

  // ── realtime (SSE) — header Authorization wajib (EventSource tak bisa header) ──
  router.get('/v1/stream', async (ctx) => {
    const res = ctx.res;
    if (!res || typeof res.writeHead !== 'function') throw new PolicyError('SSE_UNAVAILABLE', 'Streaming tidak tersedia.', 500);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    });
    let closed = false;
    const send = (event, data) => {
      if (closed) return;
      try { res.write('event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* ignore */ }
    };
    send('ready', { cursor: ctx.__lastCursor || 0, ownerId: ctx.ownerId });
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      clearTimeout(maxLife);
      try { res.end(); } catch (e) { /* ignore */ }
    };
    const timer = setInterval(async () => {
      if (closed) return;
      try {
        // Revalidasi identitas setiap poll: token/sesi/device yang dicabut harus
        // langsung menghentikan stream, bukan hanya request baru.
        if (!(await authContextActive(db, ctx))){
          send('revoked', { reason: 'AUTH_REVOKED' });
          cleanup();
          return;
        }
        const rows = await db.query('SELECT id, cursor, type, payload, received_at FROM events WHERE owner_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT 50', [ctx.ownerId, ctx.__lastCursor || 0]);
        if (closed) return;
        rows.forEach(r => { send('change', r); ctx.__lastCursor = Number(r.cursor); });
      } catch (e) { /* DB sementara tidak tersedia: biarkan stream hidup sampai poll berikut */ }
    }, 3000);
    const heartbeat = setInterval(() => { if (!closed) { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } } }, 20000);
    // Batasi umur stream agar kredensial yang dicabut tidak bergantung pada satu poll.
    const maxLife = setTimeout(() => { send('reconnect', { reason: 'max_lifetime' }); cleanup(); }, 30 * 60 * 1000);
    if (maxLife.unref) maxLife.unref();
    ctx.onClose = cleanup;
    return { status: 200, body: null, raw: true };
  });

  // ── import metadata memori & skill (migrasi Phase 4 → Central) ──
  // Owner SELALU dari token; provenance (origin, sourceRef, excerpt, verificationStatus,
  // hash, versi, soft-delete) dipertahankan; secret diredact; idempoten; konflik dilaporkan.
  router.post('/v1/memory/import', async (ctx) => {
    const body = ctx.body || {};
    const records = Array.isArray(body.records) ? body.records : [];
    if (records.length > 5000) throw new PolicyError('TOO_MANY_RECORDS', 'Maksimal 5000 record per permintaan.', 413);
    const { plan, counts } = migrator.planMemory(records, { ownerId: ctx.ownerId });
    const rep = await migrator.applyMemoryPlan(db, ctx.ownerId, plan, 'import');
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'device', action: 'memory.import', metadata: { inserted: rep.inserted, skipped: rep.skipped, conflicts: rep.conflicts.length } });
    return { status: 200, body: { counts, inserted: rep.inserted, skipped: rep.skipped, conflicts: rep.conflicts, checksum: migrator.reportChecksum(rep) } };
  });
  router.post('/v1/skills/import', async (ctx) => {
    const body = ctx.body || {};
    const versions = Array.isArray(body.versions) ? body.versions : [];
    if (versions.length > 2000) throw new PolicyError('TOO_MANY_RECORDS', 'Maksimal 2000 versi per permintaan.', 413);
    const { plan, counts } = migrator.planSkills(versions, { ownerId: ctx.ownerId });
    const rep = await migrator.applySkillPlan(db, ctx.ownerId, plan);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'device', action: 'skill.import', metadata: { inserted: rep.inserted, skipped: rep.skipped, conflicts: rep.conflicts.length } });
    return { status: 200, body: { counts, inserted: rep.inserted, skipped: rep.skipped, conflicts: rep.conflicts } };
  });
  router.post('/v1/memory/rollback-import', async (ctx) => {
    const res = await migrator.rollbackMigration(db, ctx.ownerId);
    await audit.record(db, { ownerId: ctx.ownerId, deviceId: ctx.deviceId, actor: 'owner', action: 'memory.import.rollback', metadata: res });
    return { status: 200, body: { ok: true, ...res } };
  });

  // ── audit ──
  router.get('/v1/audit', async (ctx) => {
    const rows = await audit.tail(db, ctx.ownerId, ctx.query.get('limit'));
    return { status: 200, body: { entries: rows } };
  });

  // ── dispatch + middleware ──
  const setCookieHeader = (res, list) => {
    if (!list || !list.length) return;
    const prev = res.getHeader('Set-Cookie');
    const all = prev ? (Array.isArray(prev) ? prev : [prev]).concat(list) : list;
    res.setHeader('Set-Cookie', all);
  };
  async function handle(req, res){
    const url = new URL(req.url, 'http://localhost');
    const method = req.method.toUpperCase();
    const origin = req.headers.origin || '';
    const originAllowed = webauth.isAllowedOrigin(origin, cfg);
    // CORS: allowlist eksplisit, TANPA wildcard + credentials.
    if (originAllowed){
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'X-CSRF-Token');
    }
    if (method === 'OPTIONS'){
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CSRF-Token');
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204);
      return res.end();
    }
    const match = router.match(method, url.pathname);
    if (!match) return json(res, 404, errorBody('NOT_FOUND', 'Endpoint tidak dikenal.'));
    // body
    let body = {};
    if (method !== 'GET' && method !== 'DELETE'){
      let raw;
      try { raw = await readBody(req, cfg.maxBodyBytes); }
      catch (e){
        const code = (e && e.code) || 'BAD_REQUEST';
        const st = (e && e.status) || 400;
        return json(res, st, errorBody(code, code === 'PAYLOAD_TOO_LARGE' ? 'Payload terlalu besar.' : 'Permintaan tidak valid.'));
      }
      try { body = parseBody(raw, cfg.maxBodyBytes); }
      catch (e){ return json(res, e.status || 400, errorBody(e.code || 'BAD_REQUEST', 'Permintaan tidak valid.')); }
    }
    const cookies = webauth.parseCookies(req.headers.cookie);
    const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket && req.socket.encrypted ? 'https' : 'http');
    const isSecure = proto === 'https';
    // Same-Site hanya jika origin request benar-benar berbeda dari origin server.
    const host = req.headers.host || '';
    const selfOrigin = proto + '://' + host;
    const crossSite = !!origin && originAllowed && origin !== selfOrigin;
    const ctx = {
      headers: req.headers, query: url.searchParams, body, params: match.params,
      ip: clientIp(req, cfg), res, cookies, origin, originAllowed,
      isSecure, crossSite,
      loginThrottle,
      setCookies: (list) => setCookieHeader(res, list)
    };
    if (req.on) req.on('close', () => { try { if (typeof ctx.onClose === 'function') ctx.onClose(); } catch (e) { /* ignore */ } });
    const authHeader = req.headers.authorization || '';
    // Endpoint publik TIDAK boleh diblokir cookie lama (bisa membuat login mustahil).
    // Refresh boleh memakai cookie refresh tanpa access; logout juga harus tetap bisa
    // membersihkan cookie saat access sudah kedaluwarsa (handler tetap memverifikasi
    // refresh token + CSRF).
    const PUBLIC = ['/v1/health', '/v1/ready', '/v1/auth/bootstrap', '/v1/auth/login', '/v1/sessions/refresh'];
    const logoutPath = method === 'DELETE' && (url.pathname === '/v1/sessions' || url.pathname === '/v1/sessions/current');
    const isPublic = PUBLIC.includes(url.pathname) || logoutPath;
    if (authHeader.startsWith('Bearer ')){
      const verified = await tokens.verifyToken(db, authHeader.slice(7).trim());
      if (verified && verified.error) return json(res, 401, errorBody(verified.error, 'Token tidak valid.'));
      if (!verified) return json(res, 401, errorBody('UNAUTHENTICATED', 'Token tidak valid.'));
      ctx.ownerId = verified.ownerId;
      ctx.deviceId = verified.deviceId;
      ctx.tokenId = verified.tokenId;
      ctx.scopes = verified.scopes;
      ctx.role = verified.role || null;
      ctx.tokenExpiresAt = verified.expiresAt || null;
      ctx.authMethod = 'bearer';
    } else if (cookies[webauth.COOKIE.ACCESS] && !isPublic){
      // Autentikasi via cookie sesi (browser). Token access disimpan sebagai hash → cari sesi.
      const rows = await db.query(`SELECT s.*, o.status AS owner_status, o.role AS owner_role, d.status AS device_status
                                   FROM sessions s
                                   JOIN owners o ON o.id = s.owner_id
                                   LEFT JOIN devices d ON d.id = s.device_id AND d.owner_id = s.owner_id
                                   WHERE s.access_token_hash = ?`, [webauth.hashToken(cookies[webauth.COOKIE.ACCESS])]);
      const s = rows.length ? rows[0] : null;
      if (!s) return json(res, 401, errorBody('UNAUTHENTICATED', 'Sesi tidak valid.'));
      if (s.status !== 'active') return json(res, 401, errorBody('SESSION_REVOKED', 'Sesi telah dicabut.'));
      if (new Date(s.access_expires_at) <= new Date()) return json(res, 401, errorBody('SESSION_EXPIRED', 'Sesi kedaluwarsa.'));
      if (s.owner_status !== 'active') return json(res, 401, errorBody('OWNER_INACTIVE', 'Owner tidak aktif.'));
      // Device yang dicabut/dihapus langsung mematikan sesi cookie terkait.
      if (s.device_id){
        if (s.device_status === null || s.device_status === undefined){
          await conv.revokeSession(db, { ownerId: s.owner_id }, s.id);
          return json(res, 401, errorBody('DEVICE_UNKNOWN', 'Perangkat tidak ditemukan.'));
        }
        if (s.device_status !== 'active'){
          await conv.revokeSession(db, { ownerId: s.owner_id }, s.id);
          return json(res, 401, errorBody('DEVICE_REVOKED', 'Perangkat telah dicabut.'));
        }
      }
      ctx.ownerId = s.owner_id;
      ctx.deviceId = s.device_id;
      ctx.sessionId = s.id;
      ctx.authMethod = 'cookie';
      ctx.role = s.owner_role || null;
      ctx.scopes = ['default', 'auth:issue'];
      ctx.tokenExpiresAt = s.access_expires_at;
      // CSRF (double-submit): wajib untuk request yang mengubah state saat auth via cookie.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !csrfValid(ctx)) {
        return json(res, 403, errorBody('CSRF_FAILED', 'Token CSRF tidak valid.'));
      }
    }
    // DEFAULT-DENY: semua endpoint (kecuali health/ready/bootstrap/login) butuh identitas terautentikasi.
    if (!isPublic && !ctx.ownerId){
      return json(res, 401, errorBody('UNAUTHENTICATED', 'Autentikasi diperlukan.'));
    }
    // Role diperiksa server-side untuk endpoint sensitif (bukan hanya UI).
    if (!isPublic && ctx.ownerId && ctx.role && ctx.role !== 'owner'){
      return json(res, 403, errorBody('ROLE_FORBIDDEN', 'Role tidak berwenang.'));
    }
    try {
      // Rate limit per owner untuk request terautentikasi (bukan per IP yang bisa
      // dibagi NAT), dan per IP untuk endpoint publik. In-memory = per instance;
      // deployment multi-instance wajib shared limiter (lihat docs).
      await rateLimit.check(ctx.ownerId ? 'owner:' + ctx.ownerId : 'ip:' + ctx.ip);
      const out = await match.route.handler(ctx);
      if (out && out.raw) return;           // handler menulis respons sendiri (SSE)
      return json(res, out.status || 200, out.body || {});
    } catch (e) {
      if (e instanceof PolicyError || e.expose){
        return json(res, e.status || 403, errorBody(e.code || 'FORBIDDEN', e.message));
      }
      if (e && e.code && (e.status === 400 || e.status === 413 || e.status === 429)){
        return json(res, e.status, errorBody(e.code, e.message));
      }
      // jangan bocorkan stack trace
      try { await audit.record(db, { ownerId: ctx.ownerId || null, deviceId: ctx.deviceId, actor: 'system', action: 'request.error', outcome: 'error', reason: String((e && e.code) || 'ERROR') }); } catch (x) { /* ignore */ }
      return json(res, 500, errorBody('INTERNAL_ERROR', 'Terjadi kesalahan internal.'));
    }
  }
  return { router, handle };
}

function readBody(req, maxBytes){
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let done = false;
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > maxBytes){
        // Jangan destroy request: klien harus menerima respons 413 yang rapi.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (tooLarge){
        const e = new Error('PAYLOAD_TOO_LARGE'); e.code = 'PAYLOAD_TOO_LARGE'; e.status = 413;
        return reject(e);
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}

module.exports = { createApp, json };
