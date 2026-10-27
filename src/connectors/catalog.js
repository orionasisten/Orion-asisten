'use strict';
/* Parser katalog public-apis/public-apis (README Markdown, tabel per kategori).
 * Katalog hanya bahan PENEMUAN: tidak memuat baseUrl, tidak ada izin, tidak ada jaminan gratis/aktif/aman.
 * Format baris yang diharapkan: | [Nama](url) | Deskripsi | `apiKey`/No/`OAuth` | Yes/No | Yes/No/Unknown |
 * Baris yang tidak cocok dihitung (skipped) agar penyimpangan format terlihat, bukan diabaikan diam-diam. */
const crypto = require('crypto');

const SOURCE = { type: 'public-apis', repo: 'public-apis/public-apis', url: 'https://github.com/public-apis/public-apis', license: 'MIT' };
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'api';
const short = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 6);

function authOf(cell) {
  const t = String(cell || '').replace(/`/g, '').trim();
  if (!t || /^no$/i.test(t)) return 'none';
  if (/^apikey$/i.test(t)) return 'apiKey';
  if (/^oauth/i.test(t)) return 'oauth';
  return 'other';
}
const yn = c => { const t = String(c || '').trim().toLowerCase(); return t === 'yes' ? true : t === 'no' ? false : null; };

function parsePublicApis(md, meta) {
  const m = meta || {};
  const entries = []; let category = '', skipped = 0, rows = 0;
  const row = /^\|\s*\[([^\]]+)\]\(([^)\s]+)\)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/;
  String(md).split(/\r?\n/).forEach(line => {
    const h = /^###\s+(.+?)\s*$/.exec(line);
    if (h) { category = /^index$/i.test(h[1]) ? '' : h[1].replace(/[#*_`]/g, '').trim(); return; }
    if (!line.startsWith('|') || /^\|\s*:?-{2,}/.test(line) || /^\|\s*API\s*\|/i.test(line)) return;
    rows++;
    const r = row.exec(line);
    if (!r || !category) { skipped++; return; }
    let docUrl = r[2];
    try { const u = new URL(docUrl); if (!/^https?:$/.test(u.protocol)) throw new Error('x'); docUrl = u.toString(); } catch (e) { skipped++; return; }
    entries.push({
      id: 'pa-' + slug(r[1]) + '-' + short(docUrl),
      name: r[1].trim().slice(0, 80), category: category.slice(0, 40), description: r[3].replace(/\s+/g, ' ').slice(0, 300),
      documentationUrl: docUrl, authType: authOf(r[4]), https: yn(r[5]), cors: yn(r[6]),
      source: Object.assign({}, SOURCE, { syncedAt: m.syncedAt || null, commit: m.commit || null }), state: 'discovered', verified: false
    });
  });
  return { entries, stats: { rows, parsed: entries.length, skipped, categories: new Set(entries.map(e => e.category)).size } };
}
module.exports = { parsePublicApis, SOURCE };
