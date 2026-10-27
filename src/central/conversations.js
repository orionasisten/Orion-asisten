'use strict';
/**
 * Layanan percakapan & sesi (Orion Central) — fondasi multi-perangkat.
 *
 * Aturan:
 * - Owner SELALU dari konteks terautentikasi (tidak pernah dari payload).
 * - Pembuatan percakapan idempoten (client_key).
 * - Pesan idempoten (client_message_id) — retry lintas perangkat tidak menduplikasi.
 * - `seq` mesinnedeki server (urutan benar lintas perangkat, bukan timestamp klien).
 * - Metadata percakapan memakai optimistic concurrency (expectedUpdatedAt) —
 *   TIDAK last-write-wins buta: konflik → 409.
 * - Akses ke percakapan lain Owner → 404 (tidak membocorkan keberadaan).
 */
const crypto = require('crypto');
const { id, nowISO } = require('./auth/tokens');
const { PolicyError } = require('./policy/scope');

const MAX_TITLE = 200;
const MAX_MESSAGE_CHARS = 32000;
const MAX_PAGE = 100;
const ROLES = ['user', 'assistant', 'system', 'tool'];

function hashToken(t){ return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function randomToken(){ return crypto.randomBytes(32).toString('base64url'); }
function clampLimit(v, def){ const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PAGE) : (def || 20); }

/* ───────────────────────── percakapan ───────────────────────── */

async function createConversation(db, ctx, body){
  body = body || {};
  const title = String(body.title || '').slice(0, MAX_TITLE);
  const clientKey = body.clientKey ? String(body.clientKey).slice(0, 120) : null;
  if (clientKey){
    const existing = await db.query('SELECT * FROM conversations WHERE owner_id = ? AND client_key = ?', [ctx.ownerId, clientKey]);
    if (existing.length) return { conversation: existing[0], duplicate: true };
  }
  const now = nowISO();
  const convId = id('cnv');
  await db.query(`INSERT INTO conversations (id, owner_id, title, status, pinned, client_key, created_device_id, created_at, updated_at, metadata)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [convId, ctx.ownerId, title || 'Percakapan baru', 'active', 0, clientKey, ctx.deviceId || null, now, now, JSON.stringify(body.metadata || {})]);
  const conv = (await db.query('SELECT * FROM conversations WHERE id = ? AND owner_id = ?', [convId, ctx.ownerId]))[0];
  await db.query('INSERT INTO events (id, cursor, owner_id, device_id, device_seq, type, schema_version, payload, client_created_at, received_at, metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['ev-' + crypto.randomBytes(12).toString('hex'), await nextCursor(db), ctx.ownerId, ctx.deviceId || null, null, 'conversation.created', 1,
     JSON.stringify({ conversationId: convId, title: conv.title }), now, now, JSON.stringify({ source: 'central' })]);
  return { conversation: conv, duplicate: false };
}

async function listConversations(db, ctx, query){
  const limit = clampLimit(query.get('limit'), 20);
  const before = query.get('before');           // updated_at (kursor) — pagination stabil
  const includeDeleted = query.get('includeDeleted') === '1';
  const rows = await db.query(
    `SELECT id, title, status, pinned, created_device_id, last_message_at, last_seq, message_count, created_at, updated_at
     FROM conversations WHERE owner_id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}${before ? ' AND updated_at < ?' : ''}
     ORDER BY updated_at DESC LIMIT ` + limit + ' + 1',
    before ? [ctx.ownerId, before] : [ctx.ownerId]);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return { conversations: items, nextCursor: hasMore && items.length ? items[items.length - 1].updated_at : null, hasMore };
}

async function getConversation(db, ctx, convId){
  const rows = await db.query('SELECT * FROM conversations WHERE id = ? AND owner_id = ? AND deleted_at IS NULL', [convId, ctx.ownerId]);
  if (!rows.length) throw new PolicyError('NOT_FOUND_OR_FORBIDDEN', 'Percakapan tidak ditemukan.', 404);
  return rows[0];
}

/**
 * Update metadata percakapan dengan optimistic concurrency.
 * Parameter berubah → versi lain menjadi konflik (409), bukan ditimpa diam-diam.
 */
async function updateConversation(db, ctx, convId, body){
  const conv = await getConversation(db, ctx, convId);
  if (body.expectedUpdatedAt && body.expectedUpdatedAt !== conv.updated_at){
    throw new PolicyError('CONFLICT', 'Percakapan diubah di perangkat lain.', 409);
  }
  const title = body.title !== undefined ? String(body.title).slice(0, MAX_TITLE) : conv.title;
  const pinned = body.pinned !== undefined ? (body.pinned ? 1 : 0) : conv.pinned;
  const now = nowISO();
  await db.query('UPDATE conversations SET title = ?, pinned = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
    [title, pinned, now, convId, ctx.ownerId]);
  const out = (await db.query('SELECT * FROM conversations WHERE id = ? AND owner_id = ?', [convId, ctx.ownerId]))[0];
  await db.query('INSERT INTO events (id, cursor, owner_id, device_id, device_seq, type, schema_version, payload, client_created_at, received_at, metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['ev-' + crypto.randomBytes(12).toString('hex'), await nextCursor(db), ctx.ownerId, ctx.deviceId || null, null, 'conversation.updated', 1,
     JSON.stringify({ conversationId: convId, title: out.title, pinned: !!out.pinned }), now, now, JSON.stringify({ source: 'central' })]);
  return out;
}

async function deleteConversation(db, ctx, convId){
  const conv = await getConversation(db, ctx, convId);
  const now = nowISO();
  await db.query('UPDATE conversations SET deleted_at = ?, status = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
    [now, 'deleted', now, convId, ctx.ownerId]);
  await db.query('INSERT INTO events (id, cursor, owner_id, device_id, device_seq, type, schema_version, payload, client_created_at, received_at, metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['ev-' + crypto.randomBytes(12).toString('hex'), await nextCursor(db), ctx.ownerId, ctx.deviceId || null, null, 'conversation.deleted', 1,
     JSON.stringify({ conversationId: convId }), now, now, JSON.stringify({ source: 'central' })]);
  return { ok: true, conversationId: convId, deletedAt: now };
}

/* ───────────────────────── pesan ───────────────────────── */

async function addMessage(db, ctx, convId, body){
  body = body || {};
  const conv = await getConversation(db, ctx, convId);
  const role = ROLES.includes(String(body.role)) ? String(body.role) : null;
  if (!role) throw new PolicyError('BAD_ROLE', 'Role pesan tidak valid.', 400);
  const content = String(body.content === undefined || body.content === null ? '' : body.content);
  if (!content.trim()) throw new PolicyError('EMPTY_MESSAGE', 'Pesan kosong.', 400);
  if (content.length > MAX_MESSAGE_CHARS) throw new PolicyError('MESSAGE_TOO_LARGE', 'Pesan terlalu panjang (maks ' + MAX_MESSAGE_CHARS + ' karakter).', 413);
  const clientId = body.clientMessageId ? String(body.clientMessageId).slice(0, 120) : null;

  // Idempotensi: pesan yang sama (clientMessageId) tidak diduplikasi.
  if (clientId){
    const dup = await db.query('SELECT * FROM messages WHERE owner_id = ? AND client_message_id = ?', [ctx.ownerId, clientId]);
    if (dup.length) return { message: dup[0], duplicate: true };
  }

  const now = nowISO();
  const msgId = id('msg');
  const seq = Number(conv.last_seq || 0) + 1;
  await db.transaction(async (t) => {
    await t.exec(`INSERT INTO messages (id, owner_id, conversation_id, seq, role, content, client_message_id, device_id, created_at, metadata)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [msgId, ctx.ownerId, convId, seq, role, content, clientId, ctx.deviceId || null, now, JSON.stringify(body.metadata || {})]);
    await t.exec('UPDATE conversations SET last_seq = ?, message_count = message_count + 1, last_message_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
      [seq, now, now, convId, ctx.ownerId]);
    await t.exec('INSERT INTO events (id, cursor, owner_id, device_id, device_seq, type, schema_version, payload, client_created_at, received_at, metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ['ev-' + crypto.randomBytes(12).toString('hex'), await nextCursor(t), ctx.ownerId, ctx.deviceId || null, null, 'message.created', 1,
       JSON.stringify({ messageId: msgId, conversationId: convId, seq, role }), now, now, JSON.stringify({ source: 'central' })]);
  });
  const msg = (await db.query('SELECT * FROM messages WHERE id = ? AND owner_id = ?', [msgId, ctx.ownerId]))[0];
  return { message: msg, duplicate: false };
}

async function listMessages(db, ctx, convId, query){
  await getConversation(db, ctx, convId);
  const limit = clampLimit(query.get('limit'), 50);
  const after = parseInt(query.get('after') || '0', 10) || 0;
  const rows = await db.query(
    `SELECT id, conversation_id, seq, role, content, client_message_id, device_id, created_at
     FROM messages WHERE owner_id = ? AND conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ` + limit + ' + 1',
    [ctx.ownerId, convId, after]);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return { messages: items, nextSeq: items.length ? items[items.length - 1].seq : after, hasMore };
}

/* ───────────────────────── sesi browser ───────────────────────── */

async function createSession(db, ctx, body){
  body = body || {};
  // Device yang ditempel di sesi HARUS milik owner dan masih aktif. Tanpa ini,
  // deviceId arbitrer bisa mencemari audit dan cookie tetap hidup setelah revoke.
  if (ctx.deviceId){
    const dev = await db.query('SELECT status FROM devices WHERE id = ? AND owner_id = ?', [ctx.deviceId, ctx.ownerId]);
    if (!dev.length) throw new PolicyError('DEVICE_NOT_OWNED', 'Perangkat tidak ditemukan untuk owner ini.', 403);
    if (dev[0].status !== 'active') throw new PolicyError('DEVICE_REVOKED', 'Perangkat telah dicabut.', 403);
  }
  const accessTtlMin = Math.min(Math.max(parseInt(body.accessTtlMinutes, 10) || 30, 1), 24 * 60);
  const refreshTtlDays = Math.min(Math.max(parseInt(body.refreshTtlDays, 10) || 30, 1), 365);
  const now = nowISO();
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const sessionId = id('ses');
  await db.query(`INSERT INTO sessions (id, owner_id, device_id, access_token_hash, refresh_token_hash, status, user_agent, created_at, access_expires_at, refresh_expires_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [sessionId, ctx.ownerId, ctx.deviceId || null, hashToken(accessToken), hashToken(refreshToken), 'active',
     String(body.userAgent || '').slice(0, 200), now,
     new Date(Date.now() + accessTtlMin * 60000).toISOString(),
     new Date(Date.now() + refreshTtlDays * 86400000).toISOString()]);
  return { sessionId, accessToken, refreshToken, accessExpiresAt: new Date(Date.now() + accessTtlMin * 60000).toISOString(), refreshExpiresAt: new Date(Date.now() + refreshTtlDays * 86400000).toISOString() };
}

/**
 * Rotasi refresh token.
 *
 * - Rotasi memakai compare-and-swap pada hash refresh lama (atomik di SQLite & PG).
 * - Refresh token yang sudah dipakai lagi SETELAH grace window → replay → sesi dicabut.
 * - Dua request paralel dengan cookie yang sama (dua tab) tidak boleh saling menghapus
 *   sesi: request kedua mendapat 409 REFRESH_RACE dan klien memakai cookie hasil request
 *   pertama. Grace window hanya berlaku untuk token yang baru saja dirotasi.
 * - Sesi/device yang dicabut tidak pernah bisa refresh.
 */
const REFRESH_RACE_GRACE_MS = 15000;

async function assertSessionUsable(db, s){
  if (s.status !== 'active') throw new PolicyError('SESSION_REVOKED', 'Sesi telah dicabut.', 401);
  const owners = await db.query('SELECT status FROM owners WHERE id = ?', [s.owner_id]);
  if (!owners.length || owners[0].status !== 'active') throw new PolicyError('OWNER_INACTIVE', 'Owner tidak aktif.', 401);
  if (s.device_id){
    const dev = await db.query('SELECT status FROM devices WHERE id = ? AND owner_id = ?', [s.device_id, s.owner_id]);
    if (!dev.length) throw new PolicyError('DEVICE_UNKNOWN', 'Perangkat tidak ditemukan.', 401);
    if (dev[0].status !== 'active') throw new PolicyError('DEVICE_REVOKED', 'Perangkat telah dicabut.', 401);
  }
  if (new Date(s.refresh_expires_at) <= new Date()) throw new PolicyError('SESSION_EXPIRED', 'Sesi kedaluwarsa.', 401);
}

async function refreshSession(db, ctx, refreshToken){
  if (!refreshToken) throw new PolicyError('REFRESH_REQUIRED', 'Refresh token wajib.', 400);
  const hash = hashToken(refreshToken);
  const rows = await db.query('SELECT * FROM sessions WHERE refresh_token_hash = ? OR prev_refresh_token_hash = ?', [hash, hash]);
  if (!rows.length) throw new PolicyError('SESSION_NOT_FOUND', 'Sesi tidak valid.', 401);
  const s = rows[0];
  // Route refresh bersifat publik (access token boleh kedaluwarsa), tetapi bila
  // pemanggil juga mengirim bearer, identitasnya tetap harus cocok.
  if (ctx && ctx.ownerId && s.owner_id !== ctx.ownerId) throw new PolicyError('FORBIDDEN', 'Sesi milik owner lain.', 403);
  await assertSessionUsable(db, s);
  if (s.prev_refresh_token_hash && s.prev_refresh_token_hash === hash){
    const rotatedAt = s.rotated_at ? new Date(s.rotated_at).getTime() : 0;
    if (Date.now() - rotatedAt <= REFRESH_RACE_GRACE_MS){
      throw new PolicyError('REFRESH_RACE', 'Refresh paralel terdeteksi; gunakan cookie terbaru.', 409);
    }
    await db.exec('UPDATE sessions SET status = ?, revoked_at = ? WHERE owner_id = ? AND id = ? AND status = ?',
      ['revoked', nowISO(), s.owner_id, s.id, 'active']);
    throw new PolicyError('REFRESH_REPLAY_DETECTED', 'Refresh token pernah dipakai; sesi dicabut.', 401);
  }
  const newAccess = randomToken();
  const newRefresh = randomToken();
  const now = nowISO();
  const accessExp = new Date(Date.now() + 30 * 60000).toISOString();
  const res = await db.exec(
    `UPDATE sessions
     SET access_token_hash = ?, refresh_token_hash = ?, prev_refresh_token_hash = ?,
         access_expires_at = ?, rotated_at = ?, last_used_at = ?
     WHERE id = ? AND owner_id = ? AND status = ? AND refresh_token_hash = ? AND refresh_expires_at > ?`,
    [hashToken(newAccess), hashToken(newRefresh), s.refresh_token_hash, accessExp, now, now,
     s.id, s.owner_id, 'active', s.refresh_token_hash, now]);
  if (!res.changes){
    // Kalah balapan: baca ulang untuk membedakan revoke/replay dari race biasa.
    const again = (await db.query('SELECT * FROM sessions WHERE id = ? AND owner_id = ?', [s.id, s.owner_id]))[0];
    if (!again || again.status !== 'active') throw new PolicyError('SESSION_REVOKED', 'Sesi telah dicabut.', 401);
    if (again.prev_refresh_token_hash === hash){
      const rotatedAt = again.rotated_at ? new Date(again.rotated_at).getTime() : 0;
      if (Date.now() - rotatedAt <= REFRESH_RACE_GRACE_MS){
        throw new PolicyError('REFRESH_RACE', 'Refresh paralel terdeteksi; gunakan cookie terbaru.', 409);
      }
      await db.exec('UPDATE sessions SET status = ?, revoked_at = ? WHERE id = ? AND owner_id = ? AND status = ?',
        ['revoked', nowISO(), s.id, s.owner_id, 'active']);
      throw new PolicyError('REFRESH_REPLAY_DETECTED', 'Refresh token pernah dipakai; sesi dicabut.', 401);
    }
    throw new PolicyError('REFRESH_RACE', 'Refresh paralel terdeteksi; coba lagi.', 409);
  }
  return {
    sessionId: s.id, ownerId: s.owner_id, deviceId: s.device_id,
    accessToken: newAccess, refreshToken: newRefresh, accessExpiresAt: accessExp,
    refreshExpiresAt: s.refresh_expires_at
  };
}

async function revokeSession(db, ctx, sessionId){
  const res = await db.exec('UPDATE sessions SET status = ?, revoked_at = ? WHERE id = ? AND owner_id = ?', ['revoked', nowISO(), sessionId, ctx.ownerId]);
  return { ok: (res.changes && res.changes > 0) };
}

async function listSessions(db, ctx){
  return db.query('SELECT id, device_id, status, user_agent, created_at, access_expires_at, refresh_expires_at, revoked_at, last_used_at FROM sessions WHERE owner_id = ? ORDER BY created_at DESC', [ctx.ownerId]);
}

async function revokeDeviceSessions(db, ownerId, deviceId){
  await db.query('UPDATE sessions SET status = ?, revoked_at = ? WHERE owner_id = ? AND device_id = ? AND status = ?',
    ['revoked', nowISO(), ownerId, deviceId, 'active']);
}

/** Cabut sesi lain setelah perubahan kredensial; sesi saat ini (bila ada) dipertahankan. */
async function revokeOtherSessions(db, ownerId, keepSessionId){
  const res = await db.exec(
    `UPDATE sessions SET status = ?, revoked_at = ?
     WHERE owner_id = ? AND status = ?${keepSessionId ? ' AND id <> ?' : ''}`,
    ['revoked', nowISO(), ownerId, 'active', ...(keepSessionId ? [keepSessionId] : [])]);
  return { revoked: res.changes || 0 };
}

/** Cek sesi masih hidup + device/owner aktif (dipakai SSE). */
async function isSessionActive(db, sessionId, ownerId){
  if (!sessionId || !ownerId) return false;
  const rows = await db.query(`SELECT s.device_id, s.status, s.access_expires_at, o.status AS owner_status, d.status AS device_status
                               FROM sessions s
                               JOIN owners o ON o.id = s.owner_id
                               LEFT JOIN devices d ON d.id = s.device_id AND d.owner_id = s.owner_id
                               WHERE s.id = ? AND s.owner_id = ?`, [sessionId, ownerId]);
  if (!rows.length) return false;
  const s = rows[0];
  if (s.status !== 'active' || s.owner_status !== 'active') return false;
  if (new Date(s.access_expires_at) <= new Date()) return false;
  if (s.device_id){
    if (s.device_status === null || s.device_status === undefined) return false;
    if (s.device_status !== 'active') return false;
  }
  return true;
}

async function nextCursor(db){
  const rows = await db.query('UPDATE id_counters SET value = value + 1 WHERE name = ? RETURNING value', ['event_cursor']);
  if (rows && rows.length) return Number(rows[0].value);
  await db.query('INSERT INTO id_counters (name, value) VALUES (?, ?)', ['event_cursor', 1]);
  return 1;
}

/* ───────────────────────── impor (migrasi desktop) ───────────────────────── */

/**
 * Impor percakapan lokal (desktop) ke server.
 * - ID percakapan & pesan DIPERTAHANKAN bila aman & belum dipakai (konflik ID ditangani eksplisit).
 * - `clientMessageId` = id pesan lokal → idempoten (jalankan ulang tidak duplikasi).
 * - Urutan pesan dipertahankan lewat `seq`; waktu lokal dipakai bila valid (tidak dikarang).
 * - Judul, pin, dan jumlah pesan dipertahankan.
 */
async function importConversations(db, ctx, payload){
  payload = payload || {};
  const list = Array.isArray(payload.conversations) ? payload.conversations : [];
  if (list.length > 2000) throw new PolicyError('TOO_MANY_RECORDS', 'Maksimal 2000 percakapan per impor.', 413);
  const report = { found: list.length, imported: 0, skipped: 0, failed: 0, conversations: 0, messages: 0, conflicts: [], errors: [] };

  for (const c of list){
    try {
      if (!c || typeof c !== 'object' || !c.id){ report.failed++; report.errors.push('MISSING_ID'); continue; }
      const rawId = String(c.id).slice(0, 64);
      const safeId = /^[A-Za-z0-9_-]{3,64}$/.test(rawId) ? rawId : null;
      // client_key stabil → impor ulang melewati percakapan yang SUDAH diimpor (idempoten).
      const clientKey = 'migrated:' + rawId;
      const already = await db.query('SELECT id, title, message_count FROM conversations WHERE owner_id = ? AND client_key = ?', [ctx.ownerId, clientKey]);
      if (already.length){
        const msgCount = Array.isArray(c.messages) ? c.messages.length : 0;
        const sameContent = (already[0].title || '') === (c.title || '') && Number(already[0].message_count || 0) === msgCount;
        if (!sameContent){
          // Konflik isi: TIDAK menimpa; dilaporkan eksplisit.
          report.conflicts.push({ id: rawId, reason: 'CONTENT_DIFFERS', resolution: 'KEPT_EXISTING' });
        }
        report.skipped += msgCount;
        report.conversations++;
        continue;
      }
      let convId = safeId || ('cnv-' + crypto.randomBytes(8).toString('hex'));
      const existing = await db.query('SELECT id FROM conversations WHERE id = ? AND owner_id = ?', [convId, ctx.ownerId]);
      if (existing.length){
        // Konflik ID: jangan timpa. Pakai ID baru & catat konflik.
        report.conflicts.push({ id: rawId, reason: 'ID_EXISTS', resolution: 'REASSIGNED' });
        convId = 'cnv-' + crypto.randomBytes(8).toString('hex');
      }
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      const created = isoOr(c.createdAt, nowISO());
      const updated = isoOr(c.updatedAt, created);
      await db.query(`INSERT INTO conversations (id, owner_id, title, status, pinned, client_key, created_device_id, last_message_at, last_seq, message_count, created_at, updated_at, metadata)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [convId, ctx.ownerId, String(c.title || 'Percakapan').slice(0, 200), 'active', c.pinned ? 1 : 0, clientKey, ctx.deviceId || null,
         msgs.length ? isoOr(msgs[msgs.length - 1].t, updated) : null, msgs.length, msgs.length, created, updated,
         JSON.stringify({ migratedFrom: c.migratedFrom || 'orion-desktop-local' })]);
      report.conversations++;
      let seq = 0;
      for (const m of msgs){
        seq++;
        if (!m || !m.text) { report.skipped++; continue; }
        const clientId = m.id ? String(m.id).slice(0, 120) : null;
        if (clientId){
          const dup = await db.query('SELECT id FROM messages WHERE owner_id = ? AND client_message_id = ?', [ctx.ownerId, clientId]);
          if (dup.length){ report.skipped++; continue; }
        }
        const role = m.role === 'orion' ? 'assistant' : (['user','assistant','system','tool'].includes(m.role) ? m.role : 'user');
        const msgId = 'msg-' + crypto.randomBytes(8).toString('hex');
        await db.query(`INSERT INTO messages (id, owner_id, conversation_id, seq, role, content, client_message_id, device_id, created_at, metadata)
                       VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [msgId, ctx.ownerId, convId, seq, role, String(m.text).slice(0, 32000), clientId, ctx.deviceId || null, isoOr(m.t, created),
           JSON.stringify({ migratedFrom: 'orion-desktop-local', model: m.model || null, demo: !!m.demo })]);
        report.messages++;
        report.imported++;
      }
      await db.query('UPDATE conversations SET last_seq = ?, message_count = ? WHERE id = ? AND owner_id = ?', [seq, seq, convId, ctx.ownerId]);
    } catch (e) {
      report.failed++;
      report.errors.push(String((e && e.message) || e).slice(0, 200));
    }
  }
  return report;
}
function isoOr(v, fallback){
  if (!v) return fallback;
  const d = new Date(v);
  return isNaN(d.getTime()) ? fallback : d.toISOString();
}

module.exports = {
  createConversation, listConversations, getConversation, updateConversation, deleteConversation,
  addMessage, listMessages,
  createSession, refreshSession, revokeSession, listSessions, revokeDeviceSessions,
  revokeOtherSessions, isSessionActive,
  importConversations,
  nextCursor, hashToken, randomToken, MAX_MESSAGE_CHARS, ROLES
};
