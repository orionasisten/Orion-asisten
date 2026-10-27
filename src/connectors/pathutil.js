'use strict';
/* Validasi path & query untuk permintaan connector (tanpa traversal, tanpa smuggling). */
function validatePath(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('Path harus string yang diawali "/".');
  if (p.length > 1024) throw new Error('Path terlalu panjang.');
  if (p.startsWith('//')) throw new Error('Path tidak boleh diawali "//".');
  if (/[\u0000-\u0020\u007f\\#?]/.test(p)) throw new Error('Path berisi karakter terlarang (spasi, kontrol, \\, #, ?). Gunakan objek query untuk parameter.');
  for (const seg of p.split('/')) {
    let d; try { d = decodeURIComponent(seg); } catch (e) { throw new Error('Path berisi percent-encoding tidak valid.'); }
    if (d === '..' || d === '.' || d.includes('/') || d.includes('\\')) throw new Error('Path berisi traversal atau pemisah tersembunyi.');
  }
  return p;
}

function buildQuery(q) {
  const out = [];
  if (q == null) return out;
  if (typeof q !== 'object' || Array.isArray(q)) throw new Error('Query harus objek.');
  const keys = Object.keys(q);
  if (keys.length > 30) throw new Error('Terlalu banyak parameter query (maks 30).');
  keys.forEach(k => {
    if (!/^[A-Za-z0-9_.\-[\]]{1,64}$/.test(k)) throw new Error('Nama parameter query tidak valid: ' + k);
    (Array.isArray(q[k]) ? q[k] : [q[k]]).forEach(v => {
      if (!(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) throw new Error('Nilai query harus string/angka/boolean: ' + k);
      const s = String(v); if (s.length > 500) throw new Error('Nilai query terlalu panjang: ' + k);
      out.push([k, s]);
    });
  });
  return out;
}
module.exports = { validatePath, buildQuery };
