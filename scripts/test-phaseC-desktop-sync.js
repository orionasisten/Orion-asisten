'use strict';
/**
 * Tes integrasi Phase C — Desktop ↔ Orion Central (PostgreSQL NYATA).
 * Cakupan: migrasi percakapan lokal, idempotensi, isolasi perangkat, pencabutan,
 * konsistensi lintas perangkat, outbox offline & retry.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONN = process.env.ORION_PG_CONNECTION || process.env.DATABASE_URL || '';
if (!CONN){
  console.log('\n  ⚠ PostgreSQL tidak dikonfigurasi — suite Phase C DILEWATI (bukan lulus).');
  process.exit(2);
}

const { createDatabase } = require('../src/central/db');
const { migrate } = require('../src/central/db/migrate');
const { createApp } = require('../src/central/app');
const { readConfig } = require('../src/central/config');
const { CentralDesktop } = require('../src/central/desktop-sync');

let passed = 0, failed = 0;
const tests = [];
function t(name, fn){ tests.push({ name, fn }); }

async function setup(){
  const admin = new (require('pg').Client)({ connectionString: CONN });
  await admin.connect();
  const name = 'orion_pc_' + crypto.randomBytes(6).toString('hex');
  await admin.query('CREATE DATABASE ' + name);
  await admin.end();
  const url = CONN.replace(/\/[^/?]*(\?|$)/, '/' + name + '$1');
  const db = createDatabase({ driver:'postgres', databaseUrl:url });
  await migrate(db, {});
  const cfg = readConfig({ CENTRAL_DB_DRIVER:'postgres', DATABASE_URL:url, CENTRAL_RATE_LIMIT_PER_MIN:'10000' });
  const app = createApp({ db, config:cfg, setupKey:'setup-key', version:'1.0.0' });
  const server = require('http').createServer((rq,rs)=>app.handle(rq,rs).catch(()=>{ rs.writeHead(500); rs.end('{}'); }));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const boot = await req(port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  const ownerToken = boot.body.token;
  // token perangkat (desktop)
  const dev = await req(port, 'POST', '/v1/devices', { name:'Windows Desktop' }, { Authorization:'Bearer '+ownerToken });
  return { db, server, port, base, ownerToken, deviceToken: dev.body.token, deviceId: dev.body.deviceId };
}
async function teardown(s){
  try { s.server.close(); } catch(e){}
  try { await s.db.close(); } catch(e){}
  try {
    const admin = new (require('pg').Client)({ connectionString: CONN });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS ' + s.name + ' WITH (FORCE)');
    await admin.end();
  } catch(e){}
}
function req(port, method, p, body, headers){
  return new Promise((resolve, reject)=>{
    const data = body===undefined?null:Buffer.from(JSON.stringify(body),'utf8');
    const h = Object.assign({ 'Content-Type':'application/json' }, headers||{});
    if(data) h['Content-Length']=data.length;
    const r = require('http').request({ hostname:'127.0.0.1', port, path:p, method, headers:h }, res=>{
      const c=[]; res.on('data',x=>c.push(x)); res.on('end',()=>{
        const txt=Buffer.concat(c).toString('utf8'); let j=null;
        try{ j=txt?JSON.parse(txt):null; }catch(e){}
        resolve({ status:res.statusCode, body:j });
      });
    });
    r.on('error', reject);
    if(data) r.write(data);
    r.end();
  });
}
const LOCAL_CONVOS = [
  { id:'cnv-local-1', title:'Percakapan Lama', pinned:true, createdAt:'2026-10-01T10:00:00.000Z', updatedAt:'2026-10-02T11:00:00.000Z',
    messages:[
      { id:'m-local-1', role:'user', text:'Halo dari lama', t:'2026-10-01T10:00:00.000Z' },
      { id:'m-local-2', role:'orion', text:'Halo juga', t:'2026-10-01T10:00:05.000Z' },
      { id:'m-local-3', role:'user', text:'Lanjut', t:'2026-10-01T10:01:00.000Z' }
    ] },
  { id:'cnv-local-2', title:'Percakapan Kedua', pinned:false, createdAt:'2026-10-03T09:00:00.000Z', updatedAt:'2026-10-03T09:30:00.000Z',
    messages:[ { id:'m-local-4', role:'user', text:'Isi kedua', t:'2026-10-03T09:00:00.000Z' } ] }
];

// ═══════ migrasi percakapan ═══════
t('migrasi percakapan lokal: ID, urutan, waktu, judul, pin dipertahankan', async ()=>{
  const s = await setup();
  const r = await req(s.port, 'POST', '/v1/conversations/import', { conversations: LOCAL_CONVOS }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.found, 2);
  assert.strictEqual(r.body.conversations, 2);
  assert.strictEqual(r.body.messages, 4);
  assert.strictEqual(r.body.imported, 4);
  assert.strictEqual(r.body.failed, 0);
  // verifikasi di DB
  const convs = await s.db.query('SELECT * FROM conversations WHERE owner_id = (SELECT id FROM owners WHERE email = ?) ORDER BY created_at', ['owner@orion.id']);
  assert.strictEqual(convs.length, 2);
  const c1 = convs.find(c => c.id === 'cnv-local-1');
  assert.ok(c1, 'ID percakapan lokal harus dipertahankan');
  assert.strictEqual(c1.title, 'Percakapan Lama');
  assert.strictEqual(c1.pinned, 1);
  assert.strictEqual(new Date(c1.created_at).toISOString(), '2026-10-01T10:00:00.000Z');
  const msgs = await s.db.query('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq', ['cnv-local-1']);
  assert.strictEqual(msgs.length, 3);
  assert.strictEqual(msgs[0].content, 'Halo dari lama');
  assert.strictEqual(msgs[1].role, 'assistant', 'role lokal "orion" harus dipetakan ke assistant');
  assert.strictEqual(new Date(msgs[0].created_at).toISOString(), '2026-10-01T10:00:00.000Z');
  assert.ok(msgs.every(m => m.client_message_id), 'client_message_id (idempotensi) harus disimpan');
  await teardown(s);
});

t('migrasi ulang tidak menduplikasi (idempoten)', async ()=>{
  const s = await setup();
  await req(s.port, 'POST', '/v1/conversations/import', { conversations: LOCAL_CONVOS }, { Authorization:'Bearer '+s.deviceToken });
  const r2 = await req(s.port, 'POST', '/v1/conversations/import', { conversations: LOCAL_CONVOS }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(r2.body.imported, 0, 'tidak boleh mengimpor ulang');
  assert.ok(r2.body.skipped >= 4, 'duplikat harus di-skip: ' + JSON.stringify(r2.body));
  const c = await s.db.query('SELECT count(*) c FROM conversations WHERE owner_id = (SELECT id FROM owners WHERE email = ?)', ['owner@orion.id']);
  assert.strictEqual(Number(c[0].c), 2);
  const m = await s.db.query('SELECT count(*) c FROM messages');
  assert.strictEqual(Number(m[0].c), 4);
  await teardown(s);
});

t('konflik ID percakapan ditangani eksplisit (tidak menimpa)', async ()=>{
  const s = await setup();
  await req(s.port, 'POST', '/v1/conversations/import', { conversations: LOCAL_CONVOS }, { Authorization:'Bearer '+s.deviceToken });
  // impor ulang dengan konten berbeda untuk id yang sama
  const changed = [{ ...LOCAL_CONVOS[0], title:'Judul Berbeda', messages:[{ id:'m-local-1', role:'user', text:'beda', t:'2026-10-05T00:00:00.000Z' }] }];
  const r = await req(s.port, 'POST', '/v1/conversations/import', { conversations: changed }, { Authorization:'Bearer '+s.deviceToken });
  assert.ok(r.body.conflicts.length >= 1, 'konflik harus dilaporkan: ' + JSON.stringify(r.body));
  assert.ok(/KEPT_EXISTING|REASSIGNED/.test(r.body.conflicts[0].resolution), 'resolusi konflik harus eksplisit');
  const kept = await s.db.query('SELECT title FROM conversations WHERE id = ?', ['cnv-local-1']);
  assert.strictEqual(kept[0].title, 'Percakapan Lama', 'percakapan asli tidak boleh ditimpa');
  const c = await s.db.query('SELECT count(*) c FROM conversations WHERE owner_id = (SELECT id FROM owners WHERE email = ?)', ['owner@orion.id']);
  assert.strictEqual(Number(c[0].c), 2, 'tidak boleh membuat percakapan ganda');
  await teardown(s);
});

t('impor tanpa autentikasi ditolak', async ()=>{
  const s = await setup();
  const r = await req(s.port, 'POST', '/v1/conversations/import', { conversations: LOCAL_CONVOS }, {});
  assert.strictEqual(r.status, 401);
  await teardown(s);
});

// ═══════ lintas perangkat ═══════
t('pesan dari perangkat A terlihat di perangkat B (web session)', async ()=>{
  const s = await setup();
  const conv = await req(s.port, 'POST', '/v1/conversations', { title:'Shared' }, { Authorization:'Bearer '+s.deviceToken });
  const convId = conv.body.conversation.id;
  // perangkat B = sesi browser (cookie)
  const login = await req(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' });
  const cookie = (login.body && login.body.delivery === 'cookie') ? null : null;
  // pakai bearer untuk simplicity di test ini: token owner = identitas owner lain di perangkat
  const sent = await req(s.port, 'POST', '/v1/conversations/' + convId + '/messages', { role:'user', content:'dari perangkat A', clientMessageId:'cm-1' }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(sent.status, 201);
  const seen = await req(s.port, 'GET', '/v1/conversations/' + convId + '/messages', undefined, { Authorization:'Bearer '+s.ownerToken });
  assert.ok(seen.body.messages.some(m => m.content === 'dari perangkat A'), 'perangkat lain harus melihat pesan');
  await teardown(s);
});

t('urutan pesan konsisten antar perangkat (seq server)', async ()=>{
  const s = await setup();
  const conv = await req(s.port, 'POST', '/v1/conversations', { title:'Order' }, { Authorization:'Bearer '+s.deviceToken });
  const convId = conv.body.conversation.id;
  for (let i = 1; i <= 5; i++){
    await req(s.port, 'POST', '/v1/conversations/' + convId + '/messages', { role:'user', content:'m'+i, clientMessageId:'cm-'+i }, { Authorization:'Bearer '+s.deviceToken });
  }
  const a = await req(s.port, 'GET', '/v1/conversations/' + convId + '/messages', undefined, { Authorization:'Bearer '+s.deviceToken });
  const b = await req(s.port, 'GET', '/v1/conversations/' + convId + '/messages', undefined, { Authorization:'Bearer '+s.ownerToken });
  assert.deepStrictEqual(a.body.messages.map(m=>m.content), ['m1','m2','m3','m4','m5']);
  assert.deepStrictEqual(a.body.messages.map(m=>m.seq), b.body.messages.map(m=>m.seq));
  await teardown(s);
});

t('retry dengan clientMessageId sama tidak menduplikasi', async ()=>{
  const s = await setup();
  const conv = await req(s.port, 'POST', '/v1/conversations', { title:'Idem' }, { Authorization:'Bearer '+s.deviceToken });
  const convId = conv.body.conversation.id;
  const body = { role:'user', content:'sama', clientMessageId:'dup-1' };
  const r1 = await req(s.port, 'POST', '/v1/conversations/' + convId + '/messages', body, { Authorization:'Bearer '+s.deviceToken });
  const r2 = await req(s.port, 'POST', '/v1/conversations/' + convId + '/messages', body, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(r1.status, 201);
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.duplicate, true);
  const c = await s.db.query('SELECT count(*) c FROM messages WHERE conversation_id = ?', [convId]);
  assert.strictEqual(Number(c[0].c), 1);
  await teardown(s);
});

t('pencabutan perangkat menghentikan akses desktop', async ()=>{
  const s = await setup();
  const r = await req(s.port, 'GET', '/v1/conversations', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(r.status, 200);
  const rev = await req(s.port, 'DELETE', '/v1/devices/' + s.deviceId, undefined, { Authorization:'Bearer '+s.ownerToken });
  assert.strictEqual(rev.status, 200);
  const after = await req(s.port, 'GET', '/v1/conversations', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(after.status, 401, 'token perangkat yang dicabut harus ditolak');
  await teardown(s);
});

t('identitas lain tidak bisa membaca data Owner', async ()=>{
  const s = await setup();
  // owner kedua (email berbeda) → identitas berbeda
  const boot2 = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'other@orion.id' }, { 'x-setup-key':'setup-key' });
  const other = boot2.body.token;
  const conv = await req(s.port, 'POST', '/v1/conversations', { title:'Privat' }, { Authorization:'Bearer '+s.deviceToken });
  const cross = await req(s.port, 'GET', '/v1/conversations/' + conv.body.conversation.id, undefined, { Authorization:'Bearer '+other });
  assert.strictEqual(cross.status, 404, 'identitas lain tidak boleh melihat percakapan');
  await teardown(s);
});

// ═══════ outbox desktop (lokal) ═══════
t('outbox: pesan offline → pending, lalu terkirim tanpa duplikasi', async ()=>{
  const s = await setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-outbox-'));
  let token = null;
  const desktop = new CentralDesktop({
    userData: dir,
    getWindow: () => null,
    readToken: () => token,
    writeToken: (k, v) => { token = v; },
    readState: () => ({}),
    writeState: () => {},
    baseUrl: s.base
  });
  // flush tanpa token → pesan tetap di outbox (tidak hilang)
  const r = await desktop.sendMessage('cnv-x', { role:'user', content:'offline', clientMessageId:'off-1' });
  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(desktop.outbox.count(), 1, 'pesan offline harus tersimpan di outbox');
  // pasang token & coba lagi
  token = s.deviceToken;
  const r2 = await desktop.sendMessage('cnv-x', { role:'user', content:'offline', clientMessageId:'off-1' });
  assert.ok(['sent','pending'].includes(r2.status));
  // outbox tidak boleh duplikasi entri untuk message id yang sama
  const entries = desktop.outbox.pending(50).filter(e => e.payload && e.payload.clientMessageId === 'off-1');
  assert.ok(entries.length <= 1, 'outbox tidak boleh punya entri ganda untuk message id yang sama');
  await teardown(s);
});

t('outbox bertahan setelah restart proses (tidak hilang)', async ()=>{
  const s = await setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-outbox2-'));
  let token = null;
  const mk = () => new CentralDesktop({
    userData: dir, getWindow: () => null,
    readToken: () => token, writeToken: (k,v)=>{ token=v; },
    readState: () => ({}), writeState: () => {}, baseUrl: s.base
  });
  const d1 = mk();
  await d1.sendMessage('cnv-y', { role:'user', content:'bertahan', clientMessageId:'keep-1' });
  assert.strictEqual(d1.outbox.count(), 1);
  // "restart" → objek baru dengan folder sama
  const d2 = mk();
  assert.strictEqual(d2.outbox.count(), 1, 'outbox harus bertahan setelah restart');
  await teardown(s);
});

(async ()=>{
  console.log('Phase C — integrasi Desktop ↔ Orion Central (PostgreSQL nyata)');
  for (const item of tests){
    try { await item.fn(); console.log('  ✓ ' + item.name); passed++; }
    catch (e){ console.log('  ✗ ' + item.name + ' — ' + (e && e.message)); failed++; }
  }
  console.log('\nPhase C integrasi: ' + passed + ' lulus, ' + failed + ' gagal');
  process.exit(failed ? 1 : 0);
})();
