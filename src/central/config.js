'use strict';
/**
 * Konfigurasi Orion Central. Semua nilai berasal dari environment (tidak ada secret default
 * yang tertanam di binary). `.env` dibaca opsional bila ada (tanpa dependensi eksternal).
 * Secret TIDAK pernah dikembalikan ke renderer: config hanya dipakai proses server.
 */
const fs = require('fs');
const path = require('path');

function loadDotEnv(file){
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return out; }
  for (const raw of text.split(/\r?\n/)){
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const DEFAULTS = {
  CENTRAL_PORT: '8787',
  CENTRAL_HOST: '127.0.0.1',
  CENTRAL_DB_DRIVER: 'sqlite',
  CENTRAL_DB_FILE: 'orion-central.db',
  CENTRAL_TOKEN_TTL_HOURS: '720',
  CENTRAL_RATE_LIMIT_PER_MIN: '120',
  CENTRAL_MAX_BODY_BYTES: '1048576',
  CENTRAL_TRUST_PROXY: '0'
};

function readConfig(env){
  env = env || process.env;
  const dotenv = env.CENTRAL_ENV_FILE ? loadDotEnv(env.CENTRAL_ENV_FILE) : {};
  const get = k => (env[k] !== undefined && env[k] !== '') ? env[k] : (dotenv[k] !== undefined && dotenv[k] !== '' ? dotenv[k] : DEFAULTS[k]);
  // Platform (Railway/Heroku-like) menyediakakan PORT. Bila CENTRAL_PORT tidak diset,
  // pakai PORT platform; bila PORT platform ada, default host = 0.0.0.0 agar terjangkau
  // dari luar container (127.0.0.1 hanya mengikat loopback dalam container).
  const platformPort = (env.PORT !== undefined && env.PORT !== '') ? env.PORT : (dotenv.PORT !== undefined && dotenv.PORT !== '' ? dotenv.PORT : '');
  const explicitPort = (env.CENTRAL_PORT !== undefined && env.CENTRAL_PORT !== '') ? env.CENTRAL_PORT : (dotenv.CENTRAL_PORT !== undefined && dotenv.CENTRAL_PORT !== '' ? dotenv.CENTRAL_PORT : '');
  const port = parseInt(explicitPort || platformPort || DEFAULTS.CENTRAL_PORT, 10);
  const explicitHost = (env.CENTRAL_HOST !== undefined && env.CENTRAL_HOST !== '') ? env.CENTRAL_HOST : (dotenv.CENTRAL_HOST !== undefined && dotenv.CENTRAL_HOST !== '' ? dotenv.CENTRAL_HOST : '');
  const host = explicitHost || (platformPort ? '0.0.0.0' : DEFAULTS.CENTRAL_HOST);
  const cfg = {
    port,
    host,
    driver: get('CENTRAL_DB_DRIVER'),
    dbFile: get('CENTRAL_DB_FILE'),
    databaseUrl: get('DATABASE_URL') || '',
    pgSsl: get('CENTRAL_PG_SSL') || '',
    pgPoolMax: parseInt(get('CENTRAL_PG_POOL_MAX'), 10) || 10,
    tokenTtlHours: parseInt(get('CENTRAL_TOKEN_TTL_HOURS'), 10),
    rateLimitPerMin: parseInt(get('CENTRAL_RATE_LIMIT_PER_MIN'), 10),
    maxBodyBytes: parseInt(get('CENTRAL_MAX_BODY_BYTES'), 10),
    corsOrigins: get('CENTRAL_CORS_ORIGINS') || '',
    loginMaxAttempts: parseInt(get('CENTRAL_LOGIN_MAX_ATTEMPTS'), 10) || 10,
    provider: {
      base: get('CENTRAL_PROVIDER_BASE') || '',
      model: get('CENTRAL_PROVIDER_MODEL') || '',
      apiKey: get('CENTRAL_PROVIDER_API_KEY') || '',
      name: get('CENTRAL_PROVIDER_NAME') || 'central-provider',
      timeoutMs: parseInt(get('CENTRAL_PROVIDER_TIMEOUT_MS'), 10) || 60000
    },
    setupPassword: get('CENTRAL_SETUP_PASSWORD') || '',
    trustProxyValue: String(get('CENTRAL_TRUST_PROXY')),
    trustProxy: String(get('CENTRAL_TRUST_PROXY')) === '1',
    dataDir: get('CENTRAL_DATA_DIR') || '',
    nodeEnv: get('NODE_ENV') || 'development'
  };
  return cfg;
}

/** Validasi konfigurasi wajib. Melempar error deskriptif (tanpa membocorkan nilai secret). */
function validateConfig(cfg){
  const problems = [];
  // port 0 = "pilih port bebas" (dipakai tes & dev lokal)
  if (!Number.isFinite(cfg.port) || cfg.port < 0 || cfg.port > 65535) problems.push('CENTRAL_PORT tidak valid');
  if (!['sqlite', 'postgres'].includes(cfg.driver)) problems.push('CENTRAL_DB_DRIVER harus sqlite|postgres');
  if (cfg.driver === 'postgres' && !cfg.databaseUrl) problems.push('DATABASE_URL wajib diisi untuk driver postgres');
  if (cfg.driver === 'sqlite' && !cfg.dbFile) problems.push('CENTRAL_DB_FILE wajib diisi untuk driver sqlite');
  if (!Number.isFinite(cfg.tokenTtlHours) || cfg.tokenTtlHours < 1) problems.push('CENTRAL_TOKEN_TTL_HOURS tidak valid');
  if (!Number.isFinite(cfg.maxBodyBytes) || cfg.maxBodyBytes < 1024) problems.push('CENTRAL_MAX_BODY_BYTES tidak valid');
  // Rate limit 0/NaN/negatif akan membuat Map menolak semua request atau tidak membatasi.
  if (!Number.isFinite(cfg.rateLimitPerMin) || cfg.rateLimitPerMin < 1 || cfg.rateLimitPerMin > 100000){
    problems.push('CENTRAL_RATE_LIMIT_PER_MIN harus integer 1..100000');
  }
  if (!Number.isFinite(cfg.loginMaxAttempts) || cfg.loginMaxAttempts < 1 || cfg.loginMaxAttempts > 1000){
    problems.push('CENTRAL_LOGIN_MAX_ATTEMPTS harus integer 1..1000');
  }
  if (!['0', '1'].includes(String(cfg.trustProxyValue))) problems.push('CENTRAL_TRUST_PROXY harus 0|1');
  if (cfg.driver === 'postgres' && cfg.nodeEnv === 'production' && !cfg.trustProxy && cfg.host !== '127.0.0.1' && cfg.host !== 'localhost'){
    // Bukan blocker mutlak (bisa di belakang proxy tepercaya dengan set 1), tetapi
    // salah konfigurasi membuat rate limit per-IP melihat semua klien sebagai proxy.
    problems.push('CENTRAL_TRUST_PROXY=1 diperlukan di production di belakang reverse proxy');
  }
  return { ok: problems.length === 0, problems };
}

/** Redaksi untuk log: jangan pernah tampilkan nilai secret. */
function redactConfig(cfg){
  return {
    port: cfg.port, host: cfg.host, driver: cfg.driver, tokenTtlHours: cfg.tokenTtlHours,
    rateLimitPerMin: cfg.rateLimitPerMin, maxBodyBytes: cfg.maxBodyBytes,
    databaseUrl: cfg.databaseUrl ? '***' : '(unset)', dataDir: cfg.dataDir || '(default)', nodeEnv: cfg.nodeEnv
  };
}

module.exports = { readConfig, validateConfig, redactConfig, loadDotEnv, DEFAULTS };
