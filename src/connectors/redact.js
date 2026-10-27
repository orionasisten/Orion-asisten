'use strict';
/* Penyaringan secret dari log, audit, dan pesan error. Defense-in-depth: nilai secret yang diketahui
 * + pola umum token/key. Tidak menggantikan kebijakan "jangan pernah memasukkan secret ke log". */
const MARK = '[REDACTED]';
const PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
];
const KV = /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization|cookie|signature)["']?\s*[:=]\s*["']?)([^&\s"',;]{3,})/gi;

function redactText(text, secrets) {
  let s = String(text == null ? '' : text);
  (secrets || []).forEach(v => { if (v && String(v).length >= 6) s = s.split(String(v)).join(MARK); });
  PATTERNS.forEach(re => { s = s.replace(re, MARK); });
  s = s.replace(KV, (_m, k) => k + MARK);
  return s;
}

const SENSITIVE_PARAM = /^(api[_-]?key|apikey|key|token|access[_-]?token|auth|authorization|secret|password|signature|sig|appid|app_id|client_secret)$/i;
function redactUrl(urlLike, extraNames) {
  let u;
  try { u = new URL(String(urlLike)); } catch (e) { return redactText(urlLike); }
  const names = new Set((extraNames || []).map(x => String(x).toLowerCase()));
  for (const k of [...u.searchParams.keys()]) {
    if (SENSITIVE_PARAM.test(k) || names.has(k.toLowerCase())) u.searchParams.set(k, 'REDACTED');
  }
  u.username = ''; u.password = '';
  return u.toString();
}

const DROP_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-amz-security-token)$|(-token|-key|-secret)$/i;
function safeHeaders(h) {
  const out = {};
  Object.keys(h || {}).forEach(k => { if (!DROP_HEADER.test(k)) out[k] = h[k]; });
  return out;
}

module.exports = { redactText, redactUrl, safeHeaders, MARK };
