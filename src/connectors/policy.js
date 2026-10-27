'use strict';
/**
 * Policy broker LOKAL untuk panggilan API (interim: blueprint menetapkan broker pusat di Orion Core;
 * antarmuka decide() sengaja dibuat murni sehingga nanti bisa didelegasikan ke backend).
 * Hasil: allow | approve | deny. Approval terikat pada fingerprint operasi (connector, konfigurasi,
 * metode, host, path, query, hash body): mengubah parameter penting = fingerprint baru = approval baru.
 */
const crypto = require('crypto');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function fingerprint(p) {
  const q = (p.query || []).slice().sort((a, b) => (a[0] + '=' + a[1]).localeCompare(b[0] + '=' + b[1]));
  return sha(JSON.stringify([p.connectorId, p.configHash, p.method, p.host, p.path, q, p.bodyHash || '']));
}

const deny = (code, reason) => ({ effect: 'deny', code, reason });

function decide(a) {
  if (a.emergency) return deny('EMERGENCY_STOP', 'Emergency stop aktif: panggilan baru diblokir.');
  const c = a.connector;
  if (!c) return deny('NOT_FOUND', 'Connector tidak ditemukan.');
  if (c.status === 'revoked') return deny('REVOKED', 'Akses connector telah dicabut.');
  if (!c.allowedMethods.includes(a.method)) return deny('METHOD_NOT_ALLOWED', `Metode ${a.method} tidak diizinkan untuk connector ini.`);

  if (a.source === 'user') { // uji/health manual: hanya GET/HEAD, selalu minta persetujuan
    if (a.method !== 'GET' && a.method !== 'HEAD') return deny('METHOD_NOT_ALLOWED', 'Uji manual hanya GET/HEAD.');
    return { effect: 'approve', code: 'MANUAL_TEST', reason: 'Uji manual connector.', cacheable: false };
  }

  // sumber model: wajib mission aktif + connector enabled + dalam scope
  if (c.status !== 'enabled') return deny('NOT_ENABLED', 'Connector belum diaktifkan.');
  const m = a.mission;
  if (!m || !m.active) return deny('NO_MISSION', 'Tidak ada mission aktif yang mengizinkan panggilan ini.');
  if (!m.allowedConnectors.includes(c.id)) return deny('NOT_IN_SCOPE', 'Connector tidak termasuk scope mission ini.');
  if (m.calls >= m.maxCalls) return deny('MISSION_CALL_LIMIT', `Batas ${m.maxCalls} panggilan per mission tercapai.`);
  if ((m.perConn[c.id] || 0) >= m.perConnectorMax) return deny('CONNECTOR_CALL_LIMIT', `Batas ${m.perConnectorMax} panggilan untuk connector ini tercapai.`);

  if (c.usageCost && c.usageCost.model === 'metered') {
    const unit = c.usageCost.unitCost || 1;
    if (!m.budget || !(m.budget.maxUnits > 0)) return deny('BUDGET_REQUIRED', 'Connector berbiaya memerlukan anggaran mission.');
    if (m.spent + unit > m.budget.maxUnits) return deny('BUDGET_EXCEEDED', 'Anggaran mission tidak cukup.');
  }

  switch (c.riskLevel) {
    case 'read-public': return { effect: 'allow', code: 'AUTO', reason: 'Baca-saja publik dalam scope mission.' };
    case 'read-private': return { effect: 'approve', code: 'PRIVATE_READ', reason: 'Membaca data berautentikasi/non-publik.', cacheable: true };
    case 'write':
      if (!m.allowWrites) return deny('WRITES_NOT_ALLOWED', 'Mission ini tidak mengizinkan operasi tulis.');
      return { effect: 'approve', code: 'WRITE', reason: 'Operasi tulis: persetujuan setiap panggilan.', cacheable: false };
    case 'high-impact':
      if (!m.allowWrites) return deny('WRITES_NOT_ALLOWED', 'Mission ini tidak mengizinkan operasi tulis.');
      if (!m.budget) return deny('BUDGET_REQUIRED', 'Tindakan berdampak tinggi memerlukan anggaran mission.');
      return { effect: 'approve', code: 'HIGH_IMPACT', reason: 'Tindakan berdampak tinggi: persetujuan setiap panggilan.', cacheable: false };
    default: return deny('BAD_RISK', 'Tingkat risiko tidak dikenal.');
  }
}

module.exports = { decide, fingerprint };
