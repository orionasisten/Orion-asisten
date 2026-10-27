'use strict';
/**
 * Membangun app/index.html dari source/Orion_v_4_0.html:
 *  1) menyisipkan Content-Security-Policy,
 *  2) menambahkan menu & view "Desktop Hub" + memuat orion-desktop.js,
 *  3) menyambungkan tombol Test/Konfigurasi di Tools & Integrations ke adapter desktop,
 *  4) menanam font lokal (jika paket @fontsource terpasang) agar jalan offline.
 * Sumber asli tidak diubah. Skrip ini idempotent — aman dijalankan berulang.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SRC = path.join(root, 'source', 'Orion_v_4_0.html');
const OUT_DIR = path.join(root, 'app');

let html = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function patch(label, re, replacement) {
  const before = html;
  html = html.replace(re, replacement);
  if (html === before) throw new Error('Patch gagal (anchor tidak ditemukan): ' + label + '\nSumber HTML kemungkinan berubah — perbarui scripts/prepare-app.js.');
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "connect-src 'self' http: https: ws://localhost:* ws://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

patch('csp', /<meta charset="UTF-8">/, '<meta charset="UTF-8">\n<meta http-equiv="Content-Security-Policy" content="' + CSP + '">');

patch('tools-test', /toast\(`Test \$\{t\.name\}: GAGAL/,
  'if(window.OrionHub){window.OrionHub.testTool(t);return;}\n    toast(`Test ${t.name}: GAGAL');

patch('tools-config', /(\n\s*)(openModal\(`<div class="frow">\s*<div class="note"><b>\$\{t\.name\}<\/b> memerlukan adapter)/,
  '$1if(window.OrionHub){window.OrionHub.openConnectors();return;}$1$2');

patch('nav', /(<li data-view="tools">[^\n]*<\/li>)/,
  '$1\n      <li data-view="hub"><svg class="ic"><use href="#i-shield"/></svg>Desktop Hub</li>');

patch('section', /(\n\s*)(<footer id="app-footer">)/,
  '$1<section id="view-hub" class="view" hidden>\n      <div class="page-head"><h2>Desktop Hub</h2><p>Workspace, skill, plugin, dan connector untuk ORION Desktop.</p></div>\n      <div class="wrap-pad" id="hub-wrap"></div>\n    </section>\n$1$2');

patch('script', /<\/body>/, '<script src="orion-stt.js"></script>\n<script src="orion-desktop.js"></script>\n<script src="orion-api.js"></script>\n<script src="orion-health.js"></script>\n<script src="orion-extract.js"></script>\n<script src="orion-input.js"></script>\n<script src="orion-web.js"></script>\n<script src="orion-capabilities.js"></script>\n<script src="orion-cloud.js"></script>\n</body>');


patch('responsive-css', /<\/head>/, '<style id="orion-responsive-fixes">\n' + fs.readFileSync(path.join(root, 'app-src', 'orion-fixes.css'), 'utf8') + '</style>\n</head>');
patch('chat-timeout', /const to=setTimeout\(\(\)=>this\.abort\?\.abort\(\),60000\);/, "const to=setTimeout(()=>this.abort?.abort(),(window.__chatTimeoutMs||60000));");
/* Perbaikan bug sumber: data dibuat dengan `updatedAt` tetapi UI membaca `updated` → "Invalid Date". */
patch('fmtT-safe', /const fmtT=iso=>new Date\(iso\)\.toLocaleTimeString\('id-ID',\{hour:'2-digit',minute:'2-digit'\}\);/,
  "const fmtT=iso=>{const d=new Date(iso);return isNaN(d)?'—':d.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});};");
patch('fmtD-safe', /const fmtD=iso=>new Date\(iso\)\.toLocaleDateString\('id-ID',\{day:'numeric',month:'short'\}\);/,
  "const fmtD=iso=>{const d=new Date(iso);return isNaN(d)?'—':d.toLocaleDateString('id-ID',{day:'numeric',month:'short'});};");
patch('updated-new', /createdAt:nowISO\(\),updatedAt:nowISO\(\)/g, 'createdAt:nowISO(),updatedAt:nowISO(),updated:nowISO()');
patch('updated-normalize', /\nconst Chat=\{/, "\n/* normalisasi data lama: UI membaca .updated, sedangkan data lama hanya punya .updatedAt */\n[State.convos,State.projects,State.missions].forEach(l=>(l||[]).forEach(x=>{if(x&&!x.updated)x.updated=x.updatedAt||x.createdAt||nowISO();}));\nconst Chat={");

/* font lokal (opsional) */
const FONTS = [
  { pkg: 'space-grotesk', family: 'Space Grotesk', weights: [400, 500, 600, 700] },
  { pkg: 'inter', family: 'Inter', weights: [400, 500, 600, 700] },
  { pkg: 'jetbrains-mono', family: 'JetBrains Mono', weights: [400, 500, 600] }
];
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT_DIR, 'fonts'), { recursive: true });

const faces = [];
let missing = 0;
FONTS.forEach(f => f.weights.forEach(w => {
  const name = `${f.pkg}-latin-${w}-normal.woff2`;
  const file = path.join(root, 'node_modules', '@fontsource', f.pkg, 'files', name);
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, path.join(OUT_DIR, 'fonts', name));
    faces.push(`@font-face{font-family:'${f.family}';font-style:normal;font-weight:${w};font-display:swap;src:url(fonts/${name}) format('woff2')}`);
  } else missing++;
}));
if (!missing) {
  html = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\n?/g, '').replace(/<link[^>]*fonts\.gstatic\.com[^>]*>\n?/g, '');
  html = html.replace('</head>', '<style>/* font lokal */\n' + faces.join('\n') + '\n</style>\n</head>');
  console.log('[prepare] font lokal tertanam (offline siap).');
} else {
  console.warn('[prepare] @fontsource belum terpasang (jalankan npm install). Font memakai Google Fonts bila online, atau font sistem bila offline.');
}

fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);
['orion-stt.js', 'orion-desktop.js', 'orion-api.js', 'orion-health.js', 'orion-extract.js', 'orion-input.js', 'orion-web.js', 'orion-capabilities.js', 'orion-cloud.js'].forEach(f => fs.copyFileSync(path.join(root, 'app-src', f), path.join(OUT_DIR, f)));
console.log('[prepare] app/index.html siap (' + Math.round(html.length / 1024) + ' KB).');
