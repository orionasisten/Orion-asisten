'use strict';
/**
 * Auth web untuk Orion Central: login Owner (email + password), pengiriman cookie sesi
 * yang aman, CORS allowlist, dan proteksi CSRF (double-submit).
 *
 * Prinsip:
 * - Password Owner disimpan sebagai hash scrypt + salt (TIDAK pernah plaintext, tidak pernah
 *   dikirim ke renderer, tidak masuk log).
 * - Refresh token HANYA lewat cookie `HttpOnly` (+ `Secure` saat HTTPS) — tidak pernah
 *   dikembalikan ke skrip browser dan tidak pernah disimpan di localStorage.
 * - CSRF: untuk request yang mengubah state dan diautentikasi via cookie, header
 *   `X-CSRF-Token` wajib cocok dengan cookie `orion_csrf` (pola double-submit).
 * - CORS: allowlist eksplisit (tanpa wildcard + kredensial). Token bearer tidak terpengaruh CORS.
 */
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPassword(password){
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return 'scrypt$' + SCRYPT.N + '$' + SCRYPT.r + '$' + SCRYPT.p + '$' + salt.toString('base64') + '$' + key.toString('base64');
}
const MAX_PASSWORD_CHARS = 1024;

function verifyPassword(password, stored){
  try {
    if (!stored) return false;
    const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const pw = String(password === undefined || password === null ? '' : password);
    // Batas panjang mencegah scrypt DoS lewat body besar; tetap verifikasi hash dummy
    // untuk email tidak dikenal agar waktu respons tidak membocorkan keberadaan akun.
    const key = crypto.scryptSync(pw.slice(0, MAX_PASSWORD_CHARS), salt, expected.length, { N: +N, r: +r, p: +p });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch (e) { return false; }
}

// Hash dummy (bukan secret) untuk menyamakan biaya verifikasi saat email tidak ada.
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(24).toString('base64url'));

/* ── cookies ── */
function parseCookies(header){
  const out = {};
  if (!header) return out;
  String(header).split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
  });
  return out;
}
function serializeCookie(name, value, opts){
  opts = opts || {};
  const parts = [name + '=' + encodeURIComponent(value)];
  parts.push('Path=' + (opts.path || '/'));
  if (opts.maxAge !== undefined) parts.push('Max-Age=' + Math.floor(opts.maxAge));
  if (opts.expires) parts.push('Expires=' + new Date(opts.expires).toUTCString());
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push('SameSite=' + (opts.sameSite || 'Lax'));
  return parts.join('; ');
}
const COOKIE = {
  ACCESS: 'orion_at',
  REFRESH: 'orion_rt',
  CSRF: 'orion_csrf'
};

/**
 * Cookie sesi hanya boleh `Secure` bila koneksi HTTPS (atau deployment yang memaksa HTTPS).
 * SameSite: 'Strict' untuk same-origin; 'None' hanya bila cross-site + HTTPS (butuh
 * SameSite=None agar browser mengirim cookie lintas origin) — dipakai hanya bila
 * origin web diizinkan & HTTPS.
 */
function sessionCookies({ accessToken, refreshToken, csrfToken, accessExpiresAt, refreshExpiresAt, secure, crossSite }){
  const sameSite = crossSite ? 'None' : 'Strict';
  const list = [
    serializeCookie(COOKIE.ACCESS, accessToken, { httpOnly:true, secure:!!secure, sameSite, path:'/', expires: accessExpiresAt }),
    serializeCookie(COOKIE.REFRESH, refreshToken, { httpOnly:true, secure:!!secure, sameSite, path:'/', expires: refreshExpiresAt })
  ];
  // CSRF cookie HARUS dibaca skrip (double-submit) → tanpa HttpOnly
  list.push(serializeCookie(COOKIE.CSRF, csrfToken, { httpOnly:false, secure:!!secure, sameSite, path:'/' }));
  return list;
}
function clearSessionCookies(secure, crossSite){
  const sameSite = crossSite ? 'None' : 'Strict';
  return [
    serializeCookie(COOKIE.ACCESS, '', { httpOnly:true, secure:!!secure, sameSite, path:'/', maxAge:0 }),
    serializeCookie(COOKIE.REFRESH, '', { httpOnly:true, secure:!!secure, sameSite, path:'/', maxAge:0 }),
    serializeCookie(COOKIE.CSRF, '', { httpOnly:false, secure:!!secure, sameSite, path:'/', maxAge:0 })
  ];
}

/* ── CORS ── */
function corsOrigins(cfg){
  return String((cfg && cfg.corsOrigins) || '').split(',').map(s => s.trim()).filter(Boolean);
}
function isAllowedOrigin(origin, cfg){
  if (!origin) return false;
  return corsOrigins(cfg).includes(origin);
}

/* ── login throttle (in-memory per email+IP) ── */
function createLoginThrottle(limit, windowMs){
  const hits = new Map();
  return function check(key){
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < (windowMs || 15 * 60 * 1000));
    if (list.length >= (limit || 10)){ hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}

module.exports = {
  hashPassword, verifyPassword, DUMMY_PASSWORD_HASH, MAX_PASSWORD_CHARS,
  parseCookies, serializeCookie, sessionCookies, clearSessionCookies,
  COOKIE, corsOrigins, isAllowedOrigin, createLoginThrottle,
  hashToken: t => crypto.createHash('sha256').update(String(t)).digest('hex'),
  randomCsrf: () => crypto.randomBytes(24).toString('base64url')
};
