'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BudgetLedger } = require('../src/missions/budget');
const Router = require('../src/missions/router');
const Executor = require('../src/missions/executor');
const Adapters = require('../src/missions/adapters');

let passed=0, failed=0;
function t(name, fn){ try { fn(); console.log('  ✓ '+name); passed++; } catch(e){ console.log('  ✗ '+name+' — '+e.message); failed++; } }

// Budget
t('budget rejects NaN estimate', ()=> {
  const m={budget:{limit:10,spent:0,reserved:0,currency:'u',ledger:[]}};
  const L=new BudgetLedger(m);
  const r=L.reserve(NaN,{}); assert.ok(!r.ok);
});
t('budget rejects negative', ()=> {
  const m={budget:{limit:10,spent:0,reserved:0,currency:'u',ledger:[]}};
  const L=new BudgetLedger(m);
  const r=L.reserve(-1,{}); assert.ok(!r.ok);
});
t('budget rejects infinite', ()=> {
  const m={budget:{limit:10,spent:0,reserved:0,currency:'u',ledger:[]}};
  const L=new BudgetLedger(m);
  const r=L.reserve(Infinity,{}); assert.ok(!r.ok);
});
t('budget single op exceeding limit rejected', ()=> {
  const m={budget:{limit:1,spent:0,reserved:0,currency:'u',ledger:[]}};
  const L=new BudgetLedger(m);
  const r=L.reserve(2,{}); assert.ok(!r.ok && r.reason==='BUDGET_EXCEEDED');
});
t('two concurrent reservations cannot exceed', ()=> {
  const m={budget:{limit:10,spent:0,reserved:0,currency:'u',ledger:[]}};
  const L=new BudgetLedger(m);
  assert.ok(L.reserve(6,{}).ok);
  const r2=L.reserve(6,{}); assert.ok(!r2.ok);
});
t('reconcile idempotent', ()=> {
  const m={budget:{limit:10,spent:0,reserved:0,currency:'u',ledger:[]}};
  const L=new BudgetLedger(m);
  const r=L.reserve(3,{}); L.reconcile(r.reservationId,2,'reconciled');
  const r2=L.reconcile(r.reservationId,2,'reconciled');
  assert.ok(r2.ok && r2.reason==='ALREADY_RECONCILED');
});
t('duplicate completion no double charge', ()=> {
  const m={budget:{limit:10,spent:0,reserved:0,currency:'u',ledger:[]}};
  const L=new BudgetLedger(m);
  const r=L.reserve(3,{}); L.reconcile(r.reservationId,2,'reconciled');
  const spent1=m.budget.spent;
  L.reconcile(r.reservationId,2,'reconciled');
  assert.strictEqual(m.budget.spent, spent1);
});
t('release on failure', ()=> {
  const m={budget:{limit:10,spent:0,reserved:0,currency:'u',ledger:[]}};
  const L=new BudgetLedger(m);
  const r=L.reserve(3,{}); L.release(r.reservationId,'failed');
  assert.strictEqual(m.budget.reserved,0);
});

// Router
const a1=new Adapters.OpenAICompatibleAdapter({name:'p1',base:'http://x',model:'m',capabilities:['text'],pricing:{inputPer1k:1,outputPer1k:1},priority:10});
const a2=new Adapters.OpenAICompatibleAdapter({name:'p2',base:'http://x',model:'m',capabilities:['text','vision'],pricing:{inputPer1k:2,outputPer1k:2},priority:5});
t('router enforces capabilities', ()=> {
  const r=Router.route({task:{type:'vision'}, adapters:[a1]});
  assert.ok(!r.ok && r.error==='NO_CAPABLE_ADAPTER');
});
t('router selects vision-capable', ()=> {
  const r=Router.route({task:{type:'vision'}, adapters:[a1,a2]});
  assert.ok(r.ok && r.adapter.name==='p2');
});
t('isTransient classifies 429', ()=> assert.ok(Router.isTransient({status:429})));
t('isTransient false for 401', ()=> assert.ok(!Router.isTransient({status:401})));
t('eligibleFallbacks empty for non-transient', ()=> {
  const r=Router.route({task:{}, adapters:[a1,a2]});
  const fb=Router.eligibleFallbacks(r, r.adapter, {status:401});
  assert.strictEqual(fb.length,0);
});

// Executor
const root = fs.mkdtempSync(path.join(os.tmpdir(),'orion-exec-'));
const ex = new Executor({workspaceRoot: root, globalLimit:2, perMissionLimit:1});
t('workspace traversal rejected', ()=> {
  const ws=ex.createWorkspace('m1','t1');
  let e=null; try { ex.validatePath(ws,'../../etc/passwd'); } catch(x){e=x;}
  assert.ok(e && /TRAVERSAL/.test(e.message));
});
t('workspace symlink escape rejected (path)', ()=> {
  const ws=ex.createWorkspace('m1','t2');
  let e=null; try { ex.validatePath(ws,'/etc/passwd'); } catch(x){e=x;}
  assert.ok(e);
});
t('createWorkspace path within root', ()=> {
  const ws=ex.createWorkspace('m2','t1');
  assert.ok(ws.startsWith(path.resolve(root)));
});
t('cleanup cannot escape root', ()=> {
  let e=null; try { ex.cleanupWorkspace('/tmp'); } catch(x){e=x;}
  assert.ok(e && /ESCAPE/.test(e.message));
});
t('concurrency global limit', ()=> {
  const e2=new Executor({workspaceRoot:root,globalLimit:1,perMissionLimit:1});
  const r1=e2.acquire('m','t1'); assert.ok(r1);
  const r2=e2.acquire('m2','t2'); assert.ok(!r2);
  r1();
  const r3=e2.acquire('m2','t2'); assert.ok(r3); r3();
});
t('per-mission concurrency limit', ()=> {
  const e3=new Executor({workspaceRoot:root,globalLimit:5,perMissionLimit:1});
  const r1=e3.acquire('m','t1'); assert.ok(r1);
  const r2=e3.acquire('m','t2'); assert.ok(!r2);
  r1();
});

// Adapters capability check
t('hasAll missing', ()=> {
  const r=Adapters.hasAll(['text'],['text','vision']);
  assert.ok(!r.ok && r.missing.includes('vision'));
});

console.log('\nPhase 3 tests: '+passed+' lulus, '+failed+' gagal');
process.exit(failed?1:0);
