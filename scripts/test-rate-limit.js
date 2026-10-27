'use strict';
/** Rate limiter regression + shared-store interface test */
const assert = require('assert');
const path = require('path');

// 1. Import implementations directly
const { InMemoryRateLimiter, PgRateLimiter } = require('../src/central/rate-limit/store');

function runInMemory() {
  const lim = InMemoryRateLimiter(3); // 3 per minute for quick test
  // 3 hits allowed
  lim.check('test');
  lim.check('test');
  lim.check('test');
  try {
    lim.check('test');
    assert.fail('Harus 429');
  } catch (e) {
    assert.strictEqual(e.code, 'RATE_LIMITED');
    assert.strictEqual(e.status, 429);
  }
  // Different key unaffected
  lim.check('other');
  console.log('InMemoryRateLimiter PASS');
}

// 2. Basic interface check for PgRateLimiter (without DB we can't fully call, but verify structure)
function runInterface() {
  const mockDb = { query: async () => { throw new Error('MOCK_DB_NO_REAL_CALL'); }, close: async () => {} };
  const pg = PgRateLimiter(10, mockDb);
  assert.strictEqual(pg.type, 'postgres');
  assert(typeof pg.check === 'function');
  console.log('PgRateLimiter interface PASS');
}

async function runPgStructure() {
  const mockDb = { query: async () => { throw new Error('MOCK_NO_REAL_DB'); }, close: async () => {} };
  const pg = PgRateLimiter(5, mockDb);
  assert.strictEqual(pg.type, 'postgres');
  assert.strictEqual(typeof pg.check, 'function');
  console.log('PgRateLimiter structure PASS');
  try { await pg.check('any'); } catch (e) { assert.ok(e); }
}

runInMemory();
runInterface();
runPgStructure().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
}).then(() => {
  console.log('=== Semua tes rate-limit lulus ===');
  process.exit(0);
});
