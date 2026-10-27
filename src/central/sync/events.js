'use strict';
/**
 * Sinkronisasi event.
 * Aturan:
 * - Event ID unik (idempotensi) — upload berulang TIDAK membuat duplikat.
 * - Cursor ditentukan server (monoton) — waktu klien bukan sumber kebenaran.
 * - Owner/device scope SELALU dari token, bukan dari payload.
 * - Konflik ditangani per tipe event (lihat policy/scope.js) — bukan last-write-wins buta.
 * - Payload divalidasi (ukuran, tipe, schema_version) dan secret disaring.
 */
const { id, nowISO } = require('../auth/tokens');
const { conflictPolicy, PolicyError } = require('../policy/scope');
const { scrub } = require('../audit');

const EVENT_TYPES = new Set([
  'mission.state', 'mission.task.state', 'approval.request', 'approval.decision',
  'memory.upsert', 'memory.verification', 'skill.register', 'skill.active', 'skill.evaluate',
  'budget.spent', 'schedule.trigger', 'device.heartbeat', 'agent.note'
]);
const MAX_PAYLOAD_BYTES = 64 * 1024;

function validateEvent(ev, ctx){
  const errors = [];
  if (!ev || typeof ev !== 'object') return ['EVENT_NOT_OBJECT'];
  if (!ev.eventId || typeof ev.eventId !== 'string' || ev.eventId.length > 120) errors.push('EVENT_ID_INVALID');
  if (!ev.type || !EVENT_TYPES.has(ev.type)) errors.push('EVENT_TYPE_INVALID');
  if (ev.schemaVersion !== undefined && !Number.isFinite(ev.schemaVersion)) errors.push('SCHEMA_VERSION_INVALID');
  if (ev.schemaVersion !== undefined && ev.schemaVersion > 1) errors.push('SCHEMA_VERSION_UNSUPPORTED');
  if (ev.deviceSeq !== undefined && ev.deviceSeq !== null && !Number.isFinite(ev.deviceSeq)) errors.push('DEVICE_SEQ_INVALID');
  if (ev.clientCreatedAt !== undefined && ev.clientCreatedAt !== null && isNaN(new Date(ev.clientCreatedAt))) errors.push('TIMESTAMP_INVALID');
  const payloadSize = Buffer.byteLength(JSON.stringify(ev.payload || {}));
  if (payloadSize > MAX_PAYLOAD_BYTES) errors.push('PAYLOAD_TOO_LARGE');
  // klien tidak boleh mengirim owner_id/role/permission — ditolak, bukan diabaikan diam-diam
  if (ev.payload && (ev.payload.owner_id || ev.payload.ownerId || ev.payload.role || ev.payload.permissions)){
    errors.push('CLIENT_SCOPE_FIELD_FORBIDDEN');
  }
  return errors;
}

/** Alokasikan cursor event (monoton, atomik). */
async function nextCursor(db){
  const rows = await db.query('UPDATE id_counters SET value = value + 1 WHERE name = ? RETURNING value', ['event_cursor']);
  if (rows && rows.length) return Number(rows[0].value);
  await db.query('INSERT INTO id_counters (name, value) VALUES (?, ?)', ['event_cursor', 1]);
  return 1;
}

/**
 * Upload batch event. Return { accepted, duplicates, rejected, conflicts, cursor }.
 */
async function uploadEvents(db, ctx, events){
  const result = { accepted: 0, duplicates: 0, rejected: 0, conflicts: 0, errors: [], cursor: 0 };
  for (const ev of events){
    const errors = validateEvent(ev, ctx);
    if (errors.length){
      result.rejected++;
      result.errors.push({ eventId: (ev && ev.eventId) || null, errors });
      continue;
    }
    // idempotensi: event_id unik PER OWNER (bukan global; mencegah squatting lintas owner)
    const dup = await db.query('SELECT id, cursor FROM events WHERE owner_id = ? AND id = ?', [ctx.ownerId, ev.eventId]);
    if (dup.length){ result.duplicates++; result.cursor = Math.max(result.cursor, Number(dup[0].cursor) || 0); continue; }

    // device_seq unik per (owner, device)
    if (ev.deviceSeq !== undefined && ev.deviceSeq !== null){
      const seqDup = await db.query('SELECT id FROM events WHERE owner_id = ? AND device_id = ? AND device_seq = ?', [ctx.ownerId, ctx.deviceId, ev.deviceSeq]);
      if (seqDup.length){ result.duplicates++; continue; }
    }

    // policy per tipe event
    const pol = conflictPolicy(ev.type);
    let resolution = 'accepted';
    if (pol.policy === 'server_authoritative' && ev.type !== 'mission.state' && ev.type !== 'mission.task.state'){
      // klien tidak berwenang mengubah hal ini; event dicatat sebagai conflict & diabaikan
      await recordConflict(db, ctx, ev.eventId, ev.type, 'rejected_client_change', pol.note);
      result.conflicts++;
      continue;
    }
    if (ev.type === 'memory.verification'){
      await recordConflict(db, ctx, ev.eventId, ev.type, 'rejected_client_change', pol.note);
      result.conflicts++;
      continue;
    }
    if (ev.type === 'approval.decision'){
      await recordConflict(db, ctx, ev.eventId, ev.type, 'rejected_client_change', pol.note);
      result.conflicts++;
      continue;
    }

    const cursor = await nextCursor(db);
    const payload = scrub(JSON.stringify(ev.payload || {}));
    await db.query(`INSERT INTO events (id, cursor, owner_id, device_id, device_seq, type, schema_version, payload, client_created_at, received_at, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ev.eventId, cursor, ctx.ownerId, ctx.deviceId, ev.deviceSeq === undefined ? null : ev.deviceSeq,
       ev.type, ev.schemaVersion || 1, payload, ev.clientCreatedAt || null, nowISO(),
       JSON.stringify({ resolution, policy: pol.policy })]);
    result.accepted++;
    result.cursor = Math.max(result.cursor, cursor);
  }
  // update cursor perangkat
  if (ctx.deviceId){
    // CASE (bukan MAX(a,b)) → portabel: PostgreSQL tidak punya MAX 2-argumen, SQLite punya.
    // Kolom juga di-kualifikasi agar tidak ambigu dengan `excluded` saat ON CONFLICT DO UPDATE.
    await db.query(`INSERT INTO sync_cursors (owner_id, device_id, last_cursor, last_pushed_at, updated_at) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(owner_id, device_id) DO UPDATE SET
                      last_cursor = CASE WHEN sync_cursors.last_cursor > excluded.last_cursor THEN sync_cursors.last_cursor ELSE excluded.last_cursor END,
                      last_pushed_at = excluded.last_pushed_at,
                      updated_at = excluded.updated_at`,
      [ctx.ownerId, ctx.deviceId, result.cursor, nowISO(), nowISO()]);
  }
  return result;
}

async function recordConflict(db, ctx, eventId, type, resolution, detail){
  await db.query(`INSERT INTO event_conflicts (id, owner_id, event_id, conflict_type, resolution, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id('cfl'), ctx.ownerId, eventId, type, resolution, String(detail || '').slice(0, 500), nowISO()]);
}

/** Pull event setelah cursor. Cursor server = sumber urutan. */
async function pullEvents(db, ctx, after, limit){
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const rows = await db.query(
    'SELECT id, cursor, device_id, device_seq, type, schema_version, payload, client_created_at, received_at FROM events WHERE owner_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ' + lim,
    [ctx.ownerId, after]);
  const last = rows.length ? Number(rows[rows.length - 1].cursor) : after;
  return { events: rows, cursor: last, hasMore: rows.length === lim };
}

module.exports = { uploadEvents, pullEvents, validateEvent, nextCursor, EVENT_TYPES, MAX_PAYLOAD_BYTES };
