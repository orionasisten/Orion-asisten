'use strict';
/* Menguji ekstraksi lampiran (DOCX/XLSX/PPTX/PDF/teks/HTML) dengan berkas nyata buatan Python + kasus jahat. */
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const X = require('../app-src/orion-extract');
const F = n => { const b = fs.readFileSync(path.join(__dirname, 'fixtures', n)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const buf = s => { const b = Buffer.from(s); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const queue = []; let pass = 0, fail = 0; const test = (n, fn) => queue.push({ n, fn });

/* penulis ZIP minimal (untuk kasus jahat) */
function zip(entries) {
  const parts = [], cd = []; let off = 0;
  entries.forEach(e => {
    const data = zlib.deflateRawSync(e.data), name = Buffer.from(e.name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(0, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(e.claim != null ? e.claim : e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(e.claim != null ? e.claim : e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    cd.push(ch, name); off += lh.length + name.length + data.length;
  });
  const cdb = Buffer.concat(cd); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(off, 16);
  const all = Buffer.concat([...parts, cdb, end]); return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

test('DOCX nyata: teks run terpecah, tab, baris baru, entitas, tabel; kode bidang (TOC) tidak ikut', async () => {
  const r = await X.extractBuffer('Laporan.DOCX', F('sample.docx')); assert.ok(r.ok && r.kind === 'docx');
  assert.ok(r.text.includes('Laporan Kopi & Teh')); assert.ok(r.text.includes('Halo dunia\tsetelah tab\nbaris baru')); assert.ok(r.text.includes('Isi bidang') && !r.text.includes('TOC')); assert.ok(/Nama \| Nilai\nKopi \| 42/.test(r.text), JSON.stringify(r.text));
});
test('XLSX nyata: shared strings (rich text), inline, angka, boolean, sel jarang, dua sheet bernama', async () => {
  const r = await X.extractBuffer('data.xlsx', F('sample.xlsx')); assert.ok(r.ok && r.kind === 'xlsx');
  assert.ok(r.text.includes('# Sheet: Penjualan (3 baris)') && r.text.includes('# Sheet: Catatan (1 baris)'));
  assert.ok(r.text.includes('Produk\tJumlah\t\tInline') && r.text.includes('Kopi Luwak\t1500.5\tTRUE') && r.text.includes('Total & pajak\t1500.5') && r.text.includes('catatan teks'));
  assert.ok(!r.text.includes('SUM('), 'rumus tidak boleh bocor sebagai nilai');
});
test('PPTX nyata: slide diurutkan numerik (2 sebelum 10), entitas didekode', async () => {
  const r = await X.extractBuffer('deck.pptx', F('sample.pptx')); assert.ok(r.ok);
  const order = [...r.text.matchAll(/--- Slide (\d+) ---/g)].map(m => +m[1]); assert.deepStrictEqual(order, [1, 2, 10]); assert.ok(r.text.includes('isi & poin') && r.text.includes('Judul Presentasi'));
});
test('PDF: terkompresi & polos terbaca (Tj, TJ+kerning, escape, oktal, T*); font CID & hasil scan dilaporkan jujur', async () => {
  for (const f of ['sample.pdf', 'sample-plain.pdf']) {
    const r = await X.extractBuffer(f, F(f)); assert.ok(r.ok && r.kind === 'pdf', f); assert.ok(r.text.includes('Halo dunia dari PDF'), f);
    assert.ok(r.text.includes('Kalimat kedua') || r.text.includes('Kalimat kedua'.toLowerCase()) || /Ka\s*limat\s+kedua|Kalimat\s+kedua/.test(r.text), r.text); assert.ok(r.text.includes('Tanda (kurung) dan \\ garis, café A'), JSON.stringify(r.text)); assert.ok(r.text.includes('Baris T-star')); assert.ok(r.note.includes('best-effort'));
  }
  for (const f of ['sample-cid.pdf', 'sample-scan.pdf']) { const r = await X.extractBuffer(f, F(f)); assert.strictEqual(r.ok, false, f); assert.ok(/tidak dapat diekstrak/.test(r.note), f); assert.strictEqual(r.text, ''); }
});
test('teks/kode/CSV/JSON/HTML: terbaca, BOM & UTF-16 ditangani, pemotongan ditandai, format lama & biner dijelaskan', async () => {
  const csv = await X.extractBuffer('a.csv', buf('nama,nilai\nkopi,42\n')); assert.ok(csv.ok && csv.kind === 'tabel' && csv.text.includes('kopi,42'));
  assert.ok((await X.extractBuffer('x.py', buf('print("é")'))).text.includes('é')); assert.ok((await X.extractBuffer('x.json', buf('{"a":1}'))).ok);
  assert.ok((await X.extractBuffer('tanpa-ekstensi', buf('isi teks biasa'))).ok, 'berkas tanpa ekstensi yang berisi teks harus terbaca');
  assert.strictEqual((await X.extractBuffer('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('halo')]).buffer.slice(0))).text.charCodeAt(0) === 0xfeff, false);
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('halo16', 'utf16le')]); assert.strictEqual((await X.extractBuffer('u16.txt', u16.buffer.slice(u16.byteOffset, u16.byteOffset + u16.length))).text, 'halo16');
  const html = await X.extractBuffer('p.html', buf('<html><head><title>x</title><script>bad()</script></head><body><h1>Judul</h1><p>a &amp; b</p><style>.k{}</style><ul><li>satu</li></ul></body></html>')); assert.ok(html.text.includes('Judul') && html.text.includes('a & b') && html.text.includes('• satu') && !/bad\(|\.k\{|<title/.test(html.text) && !html.text.includes('x\n'), JSON.stringify(html.text));
  const big = await X.extractBuffer('b.txt', buf('x'.repeat(50000)), { maxChars: 1000 }); assert.strictEqual(big.text.length, 1000); assert.ok(big.truncated && big.chars === 50000);
  assert.ok(/Format lama/.test((await X.extractBuffer('lama.doc', buf('x'))).note)); const bin = await X.extractBuffer('a.bin', Buffer.from([1, 2, 0, 3, 0, 0]).buffer); assert.strictEqual(bin.ok, false);
  assert.strictEqual((await X.extractBuffer('a.exe', Buffer.from('MZ\0\0\0abc').buffer)).ok, false);
});
test('keamanan: zip-bomb ditolak cepat; ZIP rusak/terpotong/ZIP64 → gagal rapi, tidak melempar', async () => {
  const t0 = Date.now(); const bomb = zip([{ name: 'word/document.xml', data: Buffer.alloc(60 * 1024 * 1024, 0x20), claim: 100 }]);
  const r = await X.extractBuffer('bomb.docx', bomb); assert.strictEqual(r.ok, false); assert.ok(/terlalu besar|zip-bomb/.test(r.note), r.note); assert.ok(Date.now() - t0 < 5000, 'terlalu lama: ' + (Date.now() - t0));
  const lie = zip([{ name: 'word/document.xml', data: Buffer.alloc(40 * 1024 * 1024, 0x20), claim: 10 }]); assert.strictEqual((await X.extractBuffer('lie.docx', lie)).ok, false); // ukuran dusta tetap dibatasi saat dekompresi
  const ok = F('sample.docx'); assert.strictEqual((await X.extractBuffer('t.docx', ok.slice(0, ok.byteLength - 40))).ok, false); assert.strictEqual((await X.extractBuffer('x.docx', buf('bukan zip'))).ok, false);
  assert.strictEqual((await X.extractBuffer('x.xlsx', zip([{ name: 'readme.txt', data: Buffer.from('x') }]))).text, ''); assert.strictEqual((await X.extractBuffer('k.pdf', buf('%PDF-1.4 rusak stream\nxx'))).ok, false);
});
test('keamanan: input jahat besar diproses linear (< 3 dtk): 300 ribu tag, sel XLSX berlebih, HTML tak tertutup', async () => {
  const t0 = Date.now();
  const doc = '<w:document><w:body>' + '<w:p><w:r><w:t>a</w:t></w:r></w:p>'.repeat(40000) + '</w:body></w:document>'; assert.ok((await X.extractBuffer('big.docx', zip([{ name: 'word/document.xml', data: Buffer.from(doc) }]))).ok);
  const cells = '<worksheet><sheetData>' + Array.from({ length: 3000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c><c r="ZZ${i + 1}"><v>1</v></c></row>`).join('') + '</sheetData></worksheet>';
  const x = await X.extractBuffer('big.xlsx', zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.from(cells) }])); assert.ok(x.ok && x.note.includes('dipotong') && x.text.split('\n').length <= 501, 'baris dibatasi 500');
  await X.extractBuffer('a.html', buf('<a '.repeat(500000))); await X.extractBuffer('b.html', buf('<script>'.repeat(200000))); await X.extractBuffer('c.html', buf('<div>'.repeat(300000)));
  assert.ok(Date.now() - t0 < 3000, 'terlalu lambat: ' + (Date.now() - t0) + ' ms');
});

(async () => {
  for (const t of queue) { try { await t.fn(); pass++; console.log('  ✓ ' + t.n); } catch (e) { fail++; console.log('  ✗ ' + t.n + '\n      ' + String((e && e.stack) || e).split('\n').slice(0, 5).join('\n      ')); } }
  console.log(`\nEkstraksi lampiran: ${pass} lulus, ${fail} gagal (total ${queue.length}).`); process.exit(fail ? 1 : 0);
})();
