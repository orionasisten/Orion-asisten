'use strict';
/**
 * Policy & scope enforcement untuk Orion Central.
 * Prinsip: DEFAULT-DENY. Setiap akses data wajib punya owner scope yang valid dan
 * cocok dengan sumber daya. Client TIDAK pernah menentukan owner_id sendiri —
 * owner diambil dari token terautentikasi.
 */

/** Error domain dengan kode aman untuk dikirim ke klien (tanpa stack trace). */
class PolicyError extends Error {
  constructor(code, message, status){
    super(message || code);
    this.code = code;
    this.status = status || 403;
    this.expose = true;
  }
}

/** Pastikan ctx terautentikasi valid. */
function requireAuth(ctx){
  if (!ctx || !ctx.ownerId) throw new PolicyError('UNAUTHENTICATED', 'Autentikasi diperlukan.', 401);
  return ctx;
}

/**
 * Query owner-scoped. Selalu menyisipkan owner_id dari ctx (bukan dari argumen klien).
 */
function scoped(table, ctx, extra){
  extra = extra || {};
  const where = ['owner_id = ?'];
  const params = [ctx.ownerId];
  if (extra.deviceId){ where.push('(device_id IS NULL OR device_id = ?)'); params.push(extra.deviceId); }
  return { where: where.join(' AND '), params };
}

/** Cek apakah record yang diminta milik owner. Return record atau null. */
async function assertOwnership(db, table, id, ctx, extraCols){
  requireAuth(ctx);
  const cols = extraCols || ['*'];
  const rows = await db.query(`SELECT ${cols.join(', ')} FROM ${table} WHERE id = ? AND owner_id = ?`, [id, ctx.ownerId]);
  if (!rows.length) throw new PolicyError('NOT_FOUND_OR_FORBIDDEN', 'Data tidak ditemukan.', 404);
  return rows[0];
}

/** Cek akses ke record yang punya scope & sensitivity (mengikuti aturan Phase 4). */
function canAccessScope(record, callerScope){
  if (!record) return false;
  if (record.status === 'deleted') return false;
  if (callerScope === 'global') return true;
  if (callerScope === 'skill') return record.sensitivity !== 'private';
  if (callerScope === record.scope) return true;
  if (record.scope === 'mission' && callerScope === 'session') return false;
  return false;
}

/**
 * Akses memori via API. Scope TIDAK boleh berasal dari query klien.
 * `access.scope` ditentukan server: 'global' (tanpa konteks) atau 'mission'
 * setelah missionId diverifikasi milik owner. Record mission/private hanya
 * terlihat di konteks misi yang sama; tidak ada jalur "global" untuk record misi.
 */
function canAccessMemory(record, access){
  if (!record || record.status === 'deleted') return false;
  if (!access || !access.scope) return false;
  if (access.scope === 'global') return record.scope === 'global';
  if (access.scope === 'mission'){
    return record.scope === 'mission' && !!access.missionId && record.mission_id === access.missionId;
  }
  return false;
}

/**
 * Aturan konflik per jenis record. Last-write-wins TIDAK dipakai untuk hal sensitif.
 * Return { policy: 'server_authoritative'|'first_write_wins'|'merge_append'|'reject_client_change', ... }
 */
const CONFLICT_POLICIES = {
  'approval.decision':   { policy: 'server_authoritative', note: 'Keputusan approval hanya bisa dibuat lewat endpoint keputusan; event klien tidak boleh mengubahnya.' },
  'approval.request':    { policy: 'first_write_wins', note: 'Approval aktif pertama untuk fingerprint yang sama menang; duplikat diabaikan.' },
  'memory.verification': { policy: 'server_authoritative', note: 'Status verifikasi memori tidak boleh diubah oleh klien.' },
  'memory.upsert':       { policy: 'merge_append', note: 'Record baru = versi baru; isi lama tidak ditimpa diam-diam.' },
  'skill.active':        { policy: 'server_authoritative', note: 'Pointer skill aktif hanya lewat endpoint aktivasi (hash + evaluasi wajib).' },
  'skill.register':      { policy: 'merge_append', note: 'Versi skill immutable; registering ulang id+version dengan konten berbeda = konflik.' },
  'budget.spent':        { policy: 'server_authoritative', note: 'Pemakaian budget dihitung server; angka klien hanya advisory.' },
  'mission.state':       { policy: 'server_authoritative', note: 'Status misi dihitung oleh engine server.' },
  'default':             { policy: 'merge_append', note: 'Event default digabung; tidak ada overwrite diam-diam.' }
};

function conflictPolicy(type){
  return CONFLICT_POLICIES[type] || CONFLICT_POLICIES['default'];
}

/** Role & izin. Satu owner pribadi saat ini;ROLE dipisah dari izin misi & izin skill. */
const ROLES = { owner: { missions: ['create','read','update','cancel'], approvals: ['read','decide'], skills: ['read','evaluate','activate','rollback'], memory: ['read','write'] } };
function can(role, resource, action){
  const r = ROLES[role];
  if (!r) return false;
  const list = r[resource];
  return Array.isArray(list) && list.includes(action);
}

module.exports = { PolicyError, requireAuth, scoped, assertOwnership, canAccessScope, canAccessMemory, conflictPolicy, CONFLICT_POLICIES, ROLES, can };
