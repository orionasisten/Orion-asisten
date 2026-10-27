/* ORION — ekstraksi teks dari berkas untuk lampiran Chat. UMD: dipakai di renderer (window.OrionExtract) dan diuji di Node.
 * Mendukung: teks/kode/CSV/JSON, HTML, DOCX, XLSX, PPTX, PDF (best-effort). Tanpa dependensi; semua pemindaian linear.
 * Batas: tiap entri ZIP maks 24 MB terdekompresi (anti zip-bomb); PDF hasil scan / font CID TIDAK terbaca (dilaporkan jujur). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.OrionExtract = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAX_ENTRY = 24 * 1024 * 1024;
  const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'svg', 'css', 'scss', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'sql', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'log', 'tex', 'srt', 'vtt', 'gql', 'graphql', 'proto', 'dockerfile', 'makefile', 'gradle', 'vue', 'svelte', 'r', 'lua', 'dart']);
  const LEGACY = new Set(['doc', 'xls', 'ppt', 'rtf', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key']);
  const XENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const decodeXml = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; } catch (x) { return ''; } }
    return XENT[e.toLowerCase()] !== undefined ? XENT[e.toLowerCase()] : m;
  });
  const u8cat = chunks => { let n = 0; chunks.forEach(c => { n += c.length; }); const o = new Uint8Array(n); let p = 0; chunks.forEach(c => { o.set(c, p); p += c.length; }); return o; };
  const latin1 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + 8192))); return s; };

  async function inflate(u8, format, limit) {
    const reader = new Blob([u8]).stream().pipeThrough(new DecompressionStream(format)).getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length;
      if (total > limit) { try { await reader.cancel(); } catch (e) { /* abaikan */ } throw Object.assign(new Error('data terdekompresi terlalu besar (dugaan zip-bomb)'), { code: 'TOO_LARGE' }); }
      chunks.push(value);
    }
    return u8cat(chunks);
  }

  async function readZip(buf) {
    const u8 = new Uint8Array(buf); const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1; for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error('bukan berkas ZIP/Office yang valid');
    const count = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || p === 0xffffffff) throw new Error('ZIP64 tidak didukung');
    const entries = {};
    for (let n = 0; n < count && n < 6000; n++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) break;
      const e = { method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), usize: dv.getUint32(p + 24, true), lho: dv.getUint32(p + 42, true) };
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      entries[new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl))] = e; p += 46 + nl + el + cl;
    }
    return {
      names: Object.keys(entries),
      async read(name) {
        const e = entries[name]; if (!e) return null;
        if (e.usize > MAX_ENTRY) throw Object.assign(new Error(`entri "${name}" terlalu besar`), { code: 'TOO_LARGE' });
        const lp = e.lho; if (lp + 30 > u8.length || dv.getUint32(lp, true) !== 0x04034b50) throw new Error('struktur ZIP rusak');
        const start = lp + 30 + dv.getUint16(lp + 26, true) + dv.getUint16(lp + 28, true); const data = u8.subarray(start, start + e.csize);
        if (e.method === 0) return data;
        if (e.method === 8) return inflate(data, 'deflate-raw', MAX_ENTRY);
        throw new Error('metode kompresi ZIP tidak didukung');
      }
    };
  }

  /* pemindai XML/HTML linear */
  function scanTags(s, onTag, onText) {
    let i = 0; const n = s.length;
    while (i < n) {
      const lt = s.indexOf('<', i);
      if (lt < 0) { onText(s.slice(i)); break; }
      if (lt > i) onText(s.slice(i, lt));
      if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
      if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt + 9); onText(s.slice(lt + 9, e < 0 ? n : e)); i = e < 0 ? n : e + 3; continue; }
      const gt = s.indexOf('>', lt + 1); if (gt < 0) break;
      const raw = s.slice(lt + 1, gt); i = gt + 1;
      if (raw[0] === '?' || raw[0] === '!') continue;
      const m = /^\/?([\w:.-]+)/.exec(raw.slice(0, 80)); if (!m) continue;
      onTag(m[1], raw[0] === '/', raw[raw.length - 1] === '/', raw);
    }
  }
  const tidy = s => s.replace(/[ ]{2,}/g, ' ').replace(/ ?\| ?$/gm, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  function docxText(xml) {
    const out = []; let inT = false, cell = 0;
    scanTags(xml, (name, closing, self) => {
      if (name === 'w:t') { inT = !closing && !self; return; }
      if (name === 'w:tc') { if (closing) { cell = Math.max(0, cell - 1); out.push(' | '); } else if (!self) cell++; return; }
      if (closing) { if (name === 'w:p') out.push(cell > 0 ? ' ' : '\n'); else if (name === 'w:tr') out.push('\n'); return; }
      if (name === 'w:tab') out.push('\t'); else if (name === 'w:br' || name === 'w:cr') out.push('\n');
    }, t => { if (inT) out.push(decodeXml(t)); });
    return tidy(out.join(''));
  }
  const colNum = ref => { const m = /^([A-Z]+)(\d+)$/.exec(ref || ''); if (!m) return null; let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return { col: c, row: +m[2] }; };
  function sharedStrings(xml) {
    const list = []; let cur = null, inT = false;
    scanTags(xml, (name, closing, self) => {
      if (name === 'si') { if (closing) { list.push(cur || ''); cur = null; } else if (!self) cur = ''; else list.push(''); return; }
      if (name === 't') inT = !closing && !self;
    }, t => { if (inT && cur !== null) cur += decodeXml(t); });
    return list;
  }
  function sheetText(xml, sst, maxRows, maxCols) {
    const rows = new Map(); let cell = null; let cut = false;
    scanTags(xml, (name, closing, self, raw) => {
      if (name === 'c') {
        if (!closing) { const r = /\br="([A-Z]+\d+)"/.exec(raw), t = /\bt="(\w+)"/.exec(raw); cell = self ? null : { ref: r && r[1], t: t && t[1], v: '', is: '', cur: null }; return; }
        if (cell && cell.ref) {
          const p = colNum(cell.ref);
          if (p && (p.row > maxRows || p.col > maxCols)) cut = true;
          else if (p) {
            let val = cell.v; if (cell.t === 's') val = sst[+cell.v] || ''; else if (cell.t === 'inlineStr') val = cell.is; else if (cell.t === 'b') val = cell.v === '1' ? 'TRUE' : 'FALSE';
            if (val !== '') { if (!rows.has(p.row)) rows.set(p.row, new Map()); rows.get(p.row).set(p.col, String(val).replace(/[\t\r\n]+/g, ' ')); }
          }
        }
        cell = null; return;
      }
      if (!cell) return;
      if (name === 'v' || name === 't' || name === 'f') cell.cur = closing || self ? null : name;
    }, t => { if (!cell || !cell.cur) return; if (cell.cur === 'v') cell.v += decodeXml(t); else if (cell.cur === 't') cell.is += decodeXml(t); });
    const lines = [...rows.keys()].sort((a, b) => a - b).map(r => { const m = rows.get(r); const mx = Math.max(...m.keys()); const cells = []; for (let c = 1; c <= mx; c++) cells.push(m.get(c) || ''); return cells.join('\t'); });
    return { text: lines.join('\n'), rows: lines.length, cut };
  }
  async function xlsxText(zip) {
    const get = async n => { const d = await zip.read(n); return d ? new TextDecoder().decode(d) : null; };
    const sst = sharedStrings((await get('xl/sharedStrings.xml')) || '');
    const wb = (await get('xl/workbook.xml')) || '', rels = (await get('xl/_rels/workbook.xml.rels')) || '';
    const target = {}; scanTags(rels, (n, c, s, raw) => { if (n === 'Relationship') { const id = /\bId="([^"]+)"/.exec(raw), t = /\bTarget="([^"]+)"/.exec(raw); if (id && t) target[id[1]] = t[1].replace(/^\/?(xl\/)?/, 'xl/'); } }, () => {});
    const sheets = []; scanTags(wb, (n, c, s, raw) => { if (n === 'sheet') { const nm = /\bname="([^"]*)"/.exec(raw), id = /\br:id="([^"]+)"/.exec(raw); if (nm) sheets.push({ name: decodeXml(nm[1]), file: id && target[id[1]] }); } }, () => {});
    if (!sheets.length) zip.names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort().forEach((f, i) => sheets.push({ name: 'Sheet' + (i + 1), file: f }));
    const out = []; let notes = [];
    for (const sh of sheets.slice(0, 20)) {
      const xml = sh.file ? await get(sh.file) : null; if (xml == null) continue;
      const r = sheetText(xml, sst, 500, 40); out.push(`# Sheet: ${sh.name} (${r.rows} baris)\n${r.text}`); if (r.cut) notes.push(`sheet "${sh.name}" dipotong (maks 500 baris × 40 kolom)`);
    }
    return { text: out.join('\n\n'), note: notes.join('; ') };
  }
  async function pptxText(zip) {
    const slides = zip.names.map(n => { const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(n); return m ? { n: +m[1], name: n } : null; }).filter(Boolean).sort((a, b) => a.n - b.n).slice(0, 200);
    const out = [];
    for (const s of slides) {
      const xml = new TextDecoder().decode(await zip.read(s.name)); const t = []; let inT = false;
      scanTags(xml, (name, closing, self) => { if (name === 'a:t') inT = !closing && !self; else if (closing && name === 'a:p') t.push('\n'); }, x => { if (inT) t.push(decodeXml(x)); });
      out.push(`--- Slide ${s.n} ---\n${tidy(t.join(''))}`);
    }
    return out.join('\n\n');
  }

  /* PDF best-effort: hanya teks yang dikodekan langsung (Tj/TJ). Font CID/Identity-H dan hasil scan TIDAK terbaca. */
  function segText(seg) {
    let out = '', j = 0; const n = seg.length;
    while (j < n) {
      const ch = seg[j];
      if (ch === '(') {
        let depth = 1, k = j + 1, buf = '';
        while (k < n && depth > 0) {
          const d = seg[k];
          if (d === '\\') {
            const e = seg[k + 1];
            if (e >= '0' && e <= '7') { let o = e, m = k + 2; while (m < k + 4 && seg[m] >= '0' && seg[m] <= '7') { o += seg[m]; m++; } buf += String.fromCharCode(parseInt(o, 8) & 255); k = m; continue; }
            if (e === '\n' || e === '\r') { k += 2; continue; }
            buf += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[e] || e; k += 2; continue;
          }
          if (d === '(') depth++; else if (d === ')') { depth--; if (depth === 0) { k++; break; } }
          buf += d; k++;
        }
        out += buf; j = k; continue;
      }
      if (ch === '<' && seg[j + 1] !== '<') {
        const e = seg.indexOf('>', j); if (e < 0) break;
        const hex = seg.slice(j + 1, e).replace(/\s+/g, '');
        if (/^[0-9A-Fa-f]*$/.test(hex)) { const h = hex.length % 2 ? hex + '0' : hex; for (let q = 0; q < h.length; q += 2) out += String.fromCharCode(parseInt(h.substr(q, 2), 16)); }
        j = e + 1; continue;
      }
      if (ch === 'T') { const op = seg.slice(j, j + 2); if (op === 'Td' || op === 'TD' || op === 'T*') { out += '\n'; j += 2; continue; } }
      if (ch === "'" || ch === '"') { out += '\n'; j++; continue; }
      if (ch === '-' || (ch >= '0' && ch <= '9')) { const m = /^-?\d*\.?\d+/.exec(seg.slice(j, j + 14)); if (m) { if (parseFloat(m[0]) < -200) out += ' '; j += m[0].length; continue; } }
      j++;
    }
    return out;
  }
  async function pdfText(buf) {
    const u8 = new Uint8Array(buf); const s = latin1(u8); const pieces = []; let pos = 0, streams = 0;
    while (streams < 4000) {
      const i = s.indexOf('stream', pos); if (i < 0) break;
      if (i >= 3 && s.startsWith('end', i - 3)) { pos = i + 6; continue; }
      let st = i + 6; if (s[st] === '\r') st++; if (s[st] === '\n') st++;
      const e = s.indexOf('endstream', st); if (e < 0) break;
      const ob = s.lastIndexOf('obj', i); const dict = s.slice(ob < 0 ? Math.max(0, i - 400) : ob, i);
      pos = e + 9; streams++;
      if (/\/Type\s*\/(XObject|Font|FontDescriptor|ObjStm|XRef|Metadata)|\/Subtype\s*\/(Image|Type1C|CIDFontType0C|OpenType)|\/FontFile|\/Length1/.test(dict)) continue;
      let data = u8.subarray(st, e); while (data.length && (data[data.length - 1] === 10 || data[data.length - 1] === 13)) data = data.subarray(0, data.length - 1);
      if (/\/FlateDecode|\/Fl\b/.test(dict)) { try { data = await inflate(data, 'deflate', MAX_ENTRY); } catch (err) { continue; } } else if (/\/Filter/.test(dict)) continue;
      const c = latin1(data); let from = 0;
      for (;;) { const bt = c.indexOf('BT', from); if (bt < 0) break; const et = c.indexOf('ET', bt + 2); pieces.push(segText(c.slice(bt + 2, et < 0 ? c.length : et))); from = et < 0 ? c.length : et + 2; }
    }
    return pieces.join('\n').replace(/[^\S\n]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();
  }
  const readable = t => { if (t.length < 8) return false; let ok = 0; for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if ((c >= 32 && c < 127) || (c >= 0xc0 && c <= 0xff) || c === 10 || c === 9) ok++; } return ok / t.length >= 0.85 && /[A-Za-zÀ-ÿ]{3}/.test(t); };

  /* HTML → teks (pemindai linear) */
  const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'li', 'tr', 'blockquote', 'pre', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  function htmlText(html) {
    const out = []; let skip = null;
    scanTags(String(html).slice(0, 3000000), (name, closing, self) => {
      const n = name.toLowerCase();
      if (skip) { if (closing && n === skip) skip = null; return; }
      if (!closing && !self && (n === 'script' || n === 'style' || n === 'head' || n === 'noscript' || n === 'svg')) { skip = n; return; }
      if (n === 'br' || n === 'hr' || (closing && BLOCK.has(n))) out.push('\n'); else if (!closing && n === 'li') out.push('\n• '); else if (n === 'td' || n === 'th') out.push(' | '); else out.push(' ');
    }, t => { if (!skip) out.push(decodeXml(t)); });
    return out.join('').replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function sniffText(u8) {
    const head = u8.subarray(0, 4096); for (let i = 0; i < head.length; i++) if (head[i] === 0) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true }); return true; } catch (e) { return false; }
  }
  function decodeText(u8) {
    if (u8.length >= 2 && ((u8[0] === 0xff && u8[1] === 0xfe) || (u8[0] === 0xfe && u8[1] === 0xff))) return new TextDecoder(u8[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(u8);
    return new TextDecoder('utf-8').decode(u8).replace(/^\ufeff/, '');
  }
  const extOf = name => { const base = String(name).split(/[\\/]/).pop().toLowerCase(); const m = /\.([a-z0-9]+)$/.exec(base); return m ? m[1] : base; };

  async function extractBuffer(name, buf, opts) {
    const max = (opts && opts.maxChars) || 30000; const ext = extOf(name); const u8 = new Uint8Array(buf);
    const fin = (kind, text, note) => { const t = String(text); return { ok: true, kind, text: t.slice(0, max), chars: t.length, truncated: t.length > max, note: note || '' }; };
    const fail = (kind, note) => ({ ok: false, kind, text: '', chars: 0, truncated: false, note });
    try {
      if (ext === 'docx' || ext === 'docm') { const z = await readZip(buf); const d = await z.read('word/document.xml'); if (!d) return fail('docx', 'bukan DOCX yang valid (word/document.xml tidak ada)'); return fin('docx', docxText(new TextDecoder().decode(d))); }
      if (ext === 'xlsx' || ext === 'xlsm') { const r = await xlsxText(await readZip(buf)); return fin('xlsx', r.text, r.note); }
      if (ext === 'pptx') return fin('pptx', await pptxText(await readZip(buf)));
      if (ext === 'pdf') {
        const t = await pdfText(buf);
        if (!readable(t)) return fail('pdf', 'PDF tidak dapat diekstrak: kemungkinan hasil scan (gambar) atau memakai font tertanam khusus. Tempel teksnya, atau unggah halaman sebagai gambar.');
        return fin('pdf', t, 'Ekstraksi PDF terbatas (best-effort): tabel/kolom bisa berantakan dan urutan teks tidak dijamin.');
      }
      if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return fin('html', htmlText(decodeText(u8)));
      if (LEGACY.has(ext)) return fail(ext, `Format lama .${ext} tidak didukung. Simpan sebagai .docx/.xlsx/.pptx atau PDF lalu unggah ulang.`);
      if (TEXT_EXT.has(ext) || sniffText(u8)) { if (!TEXT_EXT.has(ext) && !sniffText(u8)) return fail('biner', 'Berkas biner.'); const t = decodeText(u8); return fin(ext === 'csv' || ext === 'tsv' ? 'tabel' : 'teks', t); }
      return fail('biner', 'Tipe berkas tidak dapat dibaca sebagai teks (biner/tidak dikenal).');
    } catch (e) { return fail(ext || 'unknown', 'Gagal membaca berkas: ' + e.message); }
  }

  return { extractBuffer, htmlText, readZip, extOf, TEXT_EXT, MAX_ENTRY };
});
