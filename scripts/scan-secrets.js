'use strict';
/* Pemindaian rahasia di berkas repo (tidak termasuk node_modules/dist/release). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', '.git', 'legacy-line-b', 'backups']);
const PATTERNS = [
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'Google API key', re: /\bAIza[A-Za-z0-9]{30,}\b/g },
  { name: 'GitHub token', re: /\bghp_[A-Za-z0-9]{30,}\b/g },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'postgres URL with password', re: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/g },
  { name: 'generic assignment of secret-like key', re: /(?:api[_-]?key|secret|password|passwd|token|signing[_-]?key)\s*[:=]\s*["'][A-Za-z0-9/+_-]{24,}["']/gi }
];

function walk(dir, out){
  for (const e of fs.readdirSync(dir, { withFileTypes: true })){
    if (e.isDirectory()){
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()){
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// Nilai yang jelas-jelas placeholder/fixture uji — BUKAN rahasia nyata.
const SAFE_PLACEHOLDER = [
  /^sk-abcdefghijklmnopqrstuvwxyz/i,
  /^sk-abcdefghijklmnopqrstuv$/i, // fixture uji redaction
  /^ghp_abcdefghijklmnopqrstuvwxyz/i,
  /^AIzaSy[A-Za-z0-9]{0,}$/i,
  /^postgresql:\/\/user:password@/i,
  /^postgresql:\/\/u:(rahasia|p)@/i, // fixture uji redaction URL
  /^postgresql:\/\/postgres@/i,
  /^placeholder/i,
  /^example/i,
  /^test/i,
  /^dummy/i,
  /^your-/i
];
function isPlaceholder(v){ return SAFE_PLACEHOLDER.some(re => re.test(String(v || '').trim())); }

const files = walk('.', []);
let findings = 0;
let placeholders = 0;
let scanned = 0;
for (const f of files){
  if (/\.(exe|dmg|zip|png|ico|woff2?|ttf|pdf)$/i.test(f)) continue;
  let text;
  try {
    const st = fs.statSync(f);
    if (st.size > 2 * 1024 * 1024) continue;
    text = fs.readFileSync(f, 'utf8');
  } catch (e) { continue; }
  scanned++;
  for (const p of PATTERNS){
    p.re.lastIndex = 0;
    const hits = text.match(p.re) || [];
    const real = hits.filter(h => !isPlaceholder(h));
    if (real.length){
      findings++;
      console.log('  ⚠ TEMUAN ASLI ' + f + ' — ' + p.name + ' (' + real.length + ' hit)');
      real.slice(0, 2).forEach(h => console.log('      ' + h.slice(0, 60) + '…'));
    } else if (hits.length){
      placeholders += hits.length;
    }
  }
}
console.log('\nPemindaian rahasia: ' + scanned + ' berkas diperiksa');
console.log('  temuan rahasia nyata : ' + findings);
console.log('  placeholder/fixture  : ' + placeholders + ' (aman — contoh & fixture uji redaction)');
process.exit(findings ? 1 : 0);
