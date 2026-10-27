'use strict';
/**
 * Penjaga jaringan untuk API Connector Hub (mitigasi SSRF).
 * Tidak mengandalkan pemeriksaan string URL: setiap alamat hasil resolusi DNS divalidasi di dalam
 * fungsi `lookup` yang dipakai langsung oleh socket, sehingga IP yang divalidasi = IP yang dihubungi
 * (menutup celah DNS rebinding / TOCTOU).
 */
const dns = require('dns');
const net = require('net');

class GuardError extends Error {
  constructor(code, message) { super(message); this.name = 'GuardError'; this.code = code; }
}

/* Hook pengujian hanya berlaku bila ORION_TESTING=1 dan tidak pernah diteruskan dari IPC/UI. */
const testingOn = () => process.env.ORION_TESTING === '1';

/* ───── IPv4 ───── */
const v4int = ip => { const p = ip.split('.').map(Number); return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0; };
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];
const inV4 = (ip, [base, bits]) => { const m = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return ((v4int(ip) & m) >>> 0) === ((v4int(base) & m) >>> 0); };
const isBlockedV4 = ip => V4_BLOCKS.some(b => inV4(ip, b));

/* ───── IPv6 ───── */
function parseIPv6(str) {
  let s = String(str).toLowerCase();
  const z = s.indexOf('%'); if (z >= 0) s = s.slice(0, z);
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    if (!net.isIPv4(m[1])) return null;
    const p = m[1].split('.').map(Number);
    s = s.slice(0, m.index) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let all;
  if (parts.length === 1) { if (head.length !== 8) return null; all = head; }
  else { const fill = 8 - head.length - rest.length; if (fill < 1) return null; all = head.concat(Array(fill).fill('0'), rest); }
  if (all.length !== 8) return null;
  const out = all.map(h => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}
const emb4 = (g, i) => `${g[i] >> 8}.${g[i] & 255}.${g[i + 1] >> 8}.${g[i + 1] & 255}`;
function isBlockedV6(ip) {
  const g = parseIPv6(ip);
  if (!g) return true; // tidak bisa diurai → tolak
  const z5 = g.slice(0, 5).every(x => x === 0);
  if (g.every(x => x === 0)) return true;                                   // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true;         // ::1
  if (z5 && g[5] === 0xffff) return isBlockedV4(emb4(g, 6));                // ::ffff:a.b.c.d (IPv4-mapped)
  if (z5 && g[5] === 0) return true;                                        // IPv4-compatible (usang)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isBlockedV4(emb4(g, 6)); // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;          // NAT64 local-use
  if ((g[0] & 0xfe00) === 0xfc00) return true;                              // fc00::/7 (termasuk metadata AWS fd00:ec2::254)
  if ((g[0] & 0xffc0) === 0xfe80) return true;                              // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;                              // site-local
  if ((g[0] & 0xff00) === 0xff00) return true;                              // multicast
  if (g[0] === 0x2001 && g[1] === 0) return true;                           // Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                      // dokumentasi
  if (g[0] === 0x2002) return isBlockedV4(emb4(g, 1));                      // 6to4
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard
  if ((g[0] & 0xe000) !== 0x2000) return true;                              // hanya unicast global 2000::/3
  return false;
}

const isAddressAllowed = ip => (net.isIPv4(ip) ? !isBlockedV4(ip) : net.isIPv6(ip) ? !isBlockedV6(ip) : false);

/* ───── hostname ───── */
const BLOCKED_SUFFIX = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.home.arpa', '.localdomain'];
const isBlockedHostname = h => h === 'localhost' || !h.includes('.') || BLOCKED_SUFFIX.some(s => h.endsWith(s));

const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
function validateHostPattern(p) {
  const s = String(p || '').toLowerCase();
  if (!HOST_PATTERN.test(s)) throw new GuardError('BAD_HOST_PATTERN', `Pola host tidak valid: ${p}`);
  if (s.startsWith('*.') && s.slice(2).split('.').length < 2) throw new GuardError('BAD_HOST_PATTERN', `Wildcard terlalu luas: ${p}`);
  if (isBlockedHostname(s.replace(/^\*\./, ''))) throw new GuardError('BAD_HOST_PATTERN', `Host internal tidak boleh diizinkan: ${p}`);
  return s;
}
function matchHost(host, patterns) {
  return (patterns || []).some(p => (p.startsWith('*.') ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p));
}

function createNetGuard(opts) {
  const o = opts || {};
  const t = testingOn() && o.testing ? o.testing : null;
  const resolver = (t && t.resolve) || o.resolve || (h => dns.promises.lookup(h, { all: true, verbatim: true }));
  const addrOk = t && t.allowAddress ? (ip => !!t.allowAddress(ip) || isAddressAllowed(ip)) : isAddressAllowed;
  const allowHttp = !!(t && t.allowHttp);

  function validateUrl(input, cfg) {
    const c = cfg || {};
    const allowedPorts = c.allowedPorts || [443];
    const raw = String(input);
    if (raw.length > 2048) throw new GuardError('URL_TOO_LONG', 'URL terlalu panjang.');
    if (/[\u0000-\u0020\u007f\\]/.test(raw)) throw new GuardError('URL_AMBIGUOUS', 'URL mengandung spasi, karakter kontrol, atau backslash.');
    let u;
    try { u = new URL(raw); } catch (e) { throw new GuardError('URL_INVALID', 'URL tidak valid.'); }
    if (!(u.protocol === 'https:' || (allowHttp && u.protocol === 'http:'))) throw new GuardError('PROTOCOL_BLOCKED', 'Hanya https:// yang diizinkan.');
    if (u.username || u.password) throw new GuardError('URL_CREDENTIALS', 'Kredensial di dalam URL tidak diizinkan.');
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!host) throw new GuardError('URL_INVALID', 'Host kosong.');
    if (net.isIP(host.replace(/^\[|\]$/g, ''))) throw new GuardError('IP_LITERAL_BLOCKED', 'Alamat IP langsung tidak diizinkan; gunakan nama host.');
    if (isBlockedHostname(host)) throw new GuardError('HOST_BLOCKED', `Host internal tidak diizinkan: ${host}`);
    if (!c.anyPublic && !matchHost(host, c.allowedHosts)) throw new GuardError('HOST_NOT_ALLOWED', `Host tidak ada di allowlist connector: ${host}`);
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    if (!(t && t.allowAnyPort) && !allowedPorts.includes(port)) throw new GuardError('PORT_BLOCKED', `Port ${port} tidak diizinkan.`);
    u.hash = '';
    return u;
  }

  async function resolveValidated(host) {
    let addrs;
    try { addrs = await resolver(host); } catch (e) { throw new GuardError('DNS_FAILED', `DNS gagal untuk ${host}.`); }
    if (!addrs || !addrs.length) throw new GuardError('DNS_FAILED', `DNS tidak mengembalikan alamat untuk ${host}.`);
    for (const a of addrs) {
      if (!addrOk(a.address)) throw new GuardError('SSRF_BLOCKED', `Host ${host} mengarah ke alamat yang tidak diizinkan.`);
    }
    return addrs;
  }

  /* Dipakai sebagai opsi `lookup` http(s).request: validasi ULANG pada setiap koneksi. */
  function lookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    resolveValidated(String(hostname).toLowerCase()).then(addrs => {
      const list = addrs.map(a => ({ address: a.address, family: a.family || net.isIP(a.address) }));
      if (options && options.all) cb(null, list); else cb(null, list[0].address, list[0].family);
    }, err => cb(err));
  }

  return { validateUrl, resolveValidated, lookup, isAddressAllowed: addrOk };
}

module.exports = { createNetGuard, GuardError, isAddressAllowed, parseIPv6, validateHostPattern, matchHost, isBlockedHostname };
