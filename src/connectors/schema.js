'use strict';
/* Validator JSON-Schema subset (tanpa regex pattern agar bebas ReDoS) untuk respons API. */
const ALLOWED = new Set(['type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'description', 'title']);
const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];

function assertSupported(s, depth) {
  const d = depth || 0;
  if (d > 12) throw new Error('Schema terlalu dalam.');
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('Schema harus objek.');
  Object.keys(s).forEach(k => { if (!ALLOWED.has(k)) throw new Error('Keyword schema tidak didukung: ' + k); });
  const types = s.type == null ? [] : [].concat(s.type);
  types.forEach(t => { if (!TYPES.includes(t)) throw new Error('Tipe schema tidak dikenal: ' + t); });
  if (s.properties) Object.keys(s.properties).forEach(k => assertSupported(s.properties[k], d + 1));
  if (s.items) assertSupported(s.items, d + 1);
}

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

function validate(data, schema) {
  const errors = []; let nodes = 0;
  (function walk(v, s, path, depth) {
    if (errors.length >= 5 || ++nodes > 20000 || depth > 24) return;
    const t = typeOf(v);
    if (s.type) {
      const ok = [].concat(s.type).some(x => x === t || (x === 'number' && t === 'integer'));
      if (!ok) { errors.push(`${path}: tipe ${t}, diharapkan ${[].concat(s.type).join('|')}`); return; }
    }
    if (s.enum && !s.enum.some(e => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${path}: nilai di luar enum`);
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(v)) errors.push(`${path}: bukan nilai const`);
    if (typeof v === 'string') { if (s.minLength != null && v.length < s.minLength) errors.push(`${path}: terlalu pendek`); if (s.maxLength != null && v.length > s.maxLength) errors.push(`${path}: terlalu panjang`); }
    if (typeof v === 'number') { if (s.minimum != null && v < s.minimum) errors.push(`${path}: < minimum`); if (s.maximum != null && v > s.maximum) errors.push(`${path}: > maksimum`); }
    if (Array.isArray(v)) {
      if (s.minItems != null && v.length < s.minItems) errors.push(`${path}: item terlalu sedikit`);
      if (s.maxItems != null && v.length > s.maxItems) errors.push(`${path}: item terlalu banyak`);
      if (s.items) v.slice(0, 200).forEach((x, i) => walk(x, s.items, `${path}[${i}]`, depth + 1));
    } else if (v && typeof v === 'object') {
      (s.required || []).forEach(k => { if (!(k in v)) errors.push(`${path}.${k}: wajib ada`); });
      Object.keys(v).forEach(k => {
        if (s.properties && s.properties[k]) walk(v[k], s.properties[k], `${path}.${k}`, depth + 1);
        else if (s.additionalProperties === false) errors.push(`${path}.${k}: properti tak dikenal`);
      });
    }
  })(data, schema, '$', 0);
  return errors;
}
module.exports = { assertSupported, validate };
