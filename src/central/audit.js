'use strict';
/** Audit trail server (append-only). Tidak pernah mencatat bearer token, secret, atau konten privat. */
const crypto = require('crypto');
const { id, nowISO } = require('./auth/tokens');

const SECRET_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._-]+/gi,
  /\b(sk-[A-Za-z0-9_-]{6,})\b/g,
  /\b(AIza[A-Za-z0-9_-]{6,})\b/g,
  /\b(ghp_[A-Za-z0-9]{10,})\b/g,
  /("?(?:password|secret|api[_-]?key|token)"?\s*[:=]\s*"?)[^",\s}]{4,}/gi
];

function scrub(text){
  let out = String(text == null ? '' : text);
  SECRET_PATTERNS.forEach(re => { out = out.replace(re, (m, p1) => (p1 ? p1 + '[redacted]' : '[redacted]')); });
  return out.slice(0, 1000);
}

async function record(db, { ownerId, deviceId, actor, action, targetType, targetId, outcome, reason, metadata }){
  const row = {
    id: id('aud'),
    owner_id: ownerId,
    device_id: deviceId || null,
    actor: scrub(actor || 'system'),
    action: scrub(action || 'unknown'),
    target_type: targetType || null,
    target_id: targetId || null,
    outcome: outcome || 'ok',
    reason: reason ? scrub(reason) : null,
    metadata: metadata ? scrub(JSON.stringify(metadata)) : null,
    created_at: nowISO()
  };
  await db.query(`INSERT INTO audit_log (id, owner_id, device_id, actor, action, target_type, target_id, outcome, reason, metadata, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.owner_id, row.device_id, row.actor, row.action, row.target_type, row.target_id, row.outcome, row.reason, row.metadata, row.created_at]);
  return row;
}

async function tail(db, ownerId, limit){
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  return db.query('SELECT * FROM audit_log WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ' + n, [ownerId]);
}

module.exports = { record, tail, scrub };
