'use strict';
/**
 * Auth bearer token yang dikelola server (self-managed).
 *
 *ANCAMAN & MODEL:
 * - Token plaintext hanya ditampilkan SEKALI saat issuance; yang disimpan hanya SHA-256 hash.
 * - Token punya expiry, bisa dicabut (revoke) dan dirotasi.
 * - Device terikat: token menunjuk device_id; akses device lain butuh token terpisah.
 * - Skema ini untuk deployment privat satu-owner. Untuk IdP eksternal, ganti modul ini
 *   (interface: issueToken / verifyToken / revokeToken) — lihat docs/phase-5-implementation-report.md.
 * - TIDAK ada secret statis di binary desktop: desktop meminta token lewat dialog Owner.
 */
const crypto = require('crypto');

function hashToken(token){
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function randomToken(){
  return crypto.randomBytes(32).toString('base64url');
}
function id(prefix){
  return (prefix || 'id') + '-' + crypto.randomBytes(12).toString('hex');
}
function nowISO(){ return new Date().toISOString(); }

/**
 * Terbitkan token baru untuk owner (+ device opsional).
 * @returns { token, record }  — token plaintext HANYA dikembalikan di sini.
 */
async function issueToken(db, { ownerId, deviceId, label, scopes, ttlHours, rotatedFrom }){
  const token = randomToken();
  const issued = nowISO();
  const expires = new Date(Date.now() + (ttlHours || 720) * 3600 * 1000).toISOString();
  const record = {
    id: id('tk'),
    owner_id: ownerId,
    device_id: deviceId || null,
    token_hash: hashToken(token),
    label: label || '',
    scopes: JSON.stringify(Array.isArray(scopes) && scopes.length ? scopes : ['default']),
    status: 'active',
    issued_at: issued,
    expires_at: expires,
    rotated_from: rotatedFrom || null,
    last_used_at: null
  };
  await db.query(`INSERT INTO auth_tokens (id, owner_id, device_id, token_hash, label, scopes, status, issued_at, expires_at, rotated_from, last_used_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.owner_id, record.device_id, record.token_hash, record.label, record.scopes,
     record.status, record.issued_at, record.expires_at, record.rotated_from, record.last_used_at]);
  return { token, record };
}

/** Verifikasi token → context terautentikasi, atau null. */
async function verifyToken(db, token){
  if (!token || typeof token !== 'string') return null;
  const rows = await db.query(`SELECT t.*, o.status AS owner_status, o.role AS owner_role, d.status AS device_status
                               FROM auth_tokens t
                               JOIN owners o ON o.id = t.owner_id
                               LEFT JOIN devices d ON d.id = t.device_id AND d.owner_id = t.owner_id
                               WHERE t.token_hash = ?`, [hashToken(token)]);
  if (!rows.length) return null;
  const t = rows[0];
  if (t.status === 'revoked') return { error: 'TOKEN_REVOKED' };
  if (t.status !== 'active') return { error: 'TOKEN_INACTIVE' };
  if (new Date(t.expires_at) <= new Date()) return { error: 'TOKEN_EXPIRED' };
  if (t.owner_status !== 'active') return { error: 'OWNER_INACTIVE' };
  // device harus masih aktif
  if (t.device_id){
    if (t.device_status === null || t.device_status === undefined) return { error: 'DEVICE_UNKNOWN' };
    if (t.device_status !== 'active') return { error: 'DEVICE_REVOKED' };
  }
  await db.query('UPDATE auth_tokens SET last_used_at = ? WHERE id = ?', [nowISO(), t.id]);
  return {
    tokenId: t.id,
    ownerId: t.owner_id,
    deviceId: t.device_id,
    role: t.owner_role || null,
    scopes: safeParse(t.scopes),
    expiresAt: t.expires_at
  };
}

/** Apakah token masih aktif (dipakai SSE untuk memutus stream setelah revoke). */
async function isTokenActive(db, tokenId, ownerId){
  if (!tokenId || !ownerId) return false;
  const rows = await db.query(`SELECT t.device_id, t.status, t.expires_at, o.status AS owner_status, d.status AS device_status
                               FROM auth_tokens t
                               JOIN owners o ON o.id = t.owner_id
                               LEFT JOIN devices d ON d.id = t.device_id AND d.owner_id = t.owner_id
                               WHERE t.id = ? AND t.owner_id = ?`, [tokenId, ownerId]);
  if (!rows.length) return false;
  const t = rows[0];
  if (t.status !== 'active' || t.owner_status !== 'active') return false;
  if (new Date(t.expires_at) <= new Date()) return false;
  if (t.device_id){
    if (t.device_status === null || t.device_status === undefined) return false;
    if (t.device_status !== 'active') return false;
  }
  return true;
}

async function revokeToken(db, tokenId, ownerId){
  const res = await db.exec('UPDATE auth_tokens SET status = ?, revoked_at = ? WHERE id = ? AND owner_id = ? AND status = ?',
    ['revoked', nowISO(), tokenId, ownerId, 'active']);
  return (res.changes && res.changes > 0) ? { ok: true } : { ok: false, reason: 'TOKEN_NOT_FOUND_OR_NOT_ACTIVE' };
}

async function revokeDeviceTokens(db, deviceId, ownerId){
  await db.query('UPDATE auth_tokens SET status = ?, revoked_at = ? WHERE device_id = ? AND owner_id = ? AND status = ?',
    ['revoked', nowISO(), deviceId, ownerId, 'active']);
  return { ok: true };
}

/**
 * Cabut token lain milik owner. `keepTokenId` (bila ada) dipertahankan agar
 * sesi yang sedang dipakai untuk mengganti password tidak langsung mati.
 */
async function revokeOtherTokens(db, ownerId, keepTokenId){
  const res = await db.exec(
    `UPDATE auth_tokens SET status = ?, revoked_at = ?
     WHERE owner_id = ? AND status = ?${keepTokenId ? ' AND id <> ?' : ''}`,
    ['revoked', nowISO(), ownerId, 'active', ...(keepTokenId ? [keepTokenId] : [])]);
  return { revoked: res.changes || 0 };
}

/** Rotasi: cabut token lama, terbitkan baru (klien harus menyimpan token baru). */
async function rotateToken(db, tokenId, ownerId, opts){
  const old = await db.query('SELECT * FROM auth_tokens WHERE id = ? AND owner_id = ?', [tokenId, ownerId]);
  if (!old.length) throw new Error('TOKEN_NOT_FOUND');
  const revoked = await revokeToken(db, tokenId, ownerId);
  if (!revoked.ok) throw new Error('TOKEN_REVOKE_FAILED');
  const fresh = await issueToken(db, {
    ownerId: old[0].owner_id,
    deviceId: old[0].device_id,
    label: (opts && opts.label) || old[0].label,
    scopes: safeParse(old[0].scopes),
    ttlHours: opts && opts.ttlHours,
    rotatedFrom: tokenId
  });
  return fresh;
}

function safeParse(s){ try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; } }

module.exports = { issueToken, verifyToken, isTokenActive, revokeToken, revokeDeviceTokens, revokeOtherTokens, rotateToken, hashToken, randomToken, id, nowISO };
