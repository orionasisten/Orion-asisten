'use strict';
/* Abstraksi penyimpanan secret per connector. Implementasi konkret (Keychain macOS / DPAPI Windows lewat
 * Electron safeStorage) disuntikkan oleh bridge. Nilai secret TIDAK PERNAH dikembalikan ke renderer:
 * hanya `has` yang tersedia di sisi UI; `get` khusus untuk gateway di proses utama. */
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const ID = /^[a-z0-9][a-z0-9-]{2,47}$/;

function createSecretStore(o) { // o: { load(), save(obj), crypto:{available(), encrypt(s)->b64, decrypt(b64)->s} }
  const k = (id, name) => { if (!ID.test(id) || !NAME.test(name)) throw new Error('Nama secret/connector tidak valid.'); return id + ':' + name; };
  return {
    available: () => !!o.crypto.available(),
    set(id, name, value) {
      const v = String(value == null ? '' : value);
      if (!v || v.length > 4096 || /[\u0000-\u001f\u007f]/.test(v)) throw new Error('Nilai secret tidak valid (kosong, >4096, atau berisi karakter kontrol).');
      if (!o.crypto.available()) throw new Error('Penyimpanan aman OS tidak tersedia — secret tidak disimpan.');
      const d = o.load() || {}; d[k(id, name)] = o.crypto.encrypt(v); o.save(d);
    },
    has: (id, name) => !!(o.load() || {})[k(id, name)],
    get(id, name) { // KHUSUS gateway
      const v = (o.load() || {})[k(id, name)];
      if (!v) return null;
      try { return o.crypto.decrypt(v); } catch (e) { return null; }
    },
    delete(id, name) { const d = o.load() || {}; delete d[k(id, name)]; o.save(d); },
    deleteAll(id) { const d = o.load() || {}; Object.keys(d).forEach(x => { if (x.startsWith(id + ':')) delete d[x]; }); o.save(d); },
    valuesOf(id) { const d = o.load() || {}; return Object.keys(d).filter(x => x.startsWith(id + ':')).map(x => { try { return o.crypto.decrypt(d[x]); } catch (e) { return ''; } }).filter(Boolean); }
  };
}
module.exports = { createSecretStore };
