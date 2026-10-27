'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MissionRuntime } = require('../src/missions/runtime');
const { MissionStore } = require('../src/missions/store');
const SM = require('../src/missions/state-machine');

function tmpDir(){ return fs.mkdtempSync(path.join(os.tmpdir(),'orion-mr-')); }

let passed=0, failed=0;
function t(name, fn){ try { fn(); console.log('  ✓ '+name); passed++; } catch(e){ console.log('  ✗ '+name+' — '+e.message); failed++; } }

// State machine
t('legal mission transition queued->planning', ()=> assert.ok(SM.canTransitionMission('queued','planning')));
t('illegal mission transition completed->running', ()=> assert.ok(!SM.canTransitionMission('completed','running')));
t('assertMissionTransition throws on illegal', ()=> { let e=null; try{SM.assertMissionTransition('completed','running')}catch(x){e=x;} assert.ok(e && /ILLEGAL/.test(e.message)); });
t('detectCycle finds cycle', ()=> {
  const tasks=[{id:'a',deps:['b']},{id:'b',deps:['a']}];
  assert.ok(SM.detectCycle(tasks));
});
t('detectCycle false for DAG', ()=> {
  const tasks=[{id:'a',deps:[]},{id:'b',deps:['a']}];
  assert.ok(!SM.detectCycle(tasks));
});
t('readyTasks returns deps-satisfied', ()=> {
  const tasks=[{id:'a',state:'succeeded',deps:[]},{id:'b',state:'pending',deps:['a']}];
  const r=SM.readyTasks(tasks);
  assert.strictEqual(r.length,1); assert.strictEqual(r[0].id,'b');
});

// Persistence & recovery
const dir = tmpDir();
const rt = new MissionRuntime(new MissionStore(dir));
t('create mission persists', ()=>{
  const m = rt.createMission({title:'M1', goal:'g', tasks:[{title:'T1',deps:[]},{title:'T2',deps:[]}], budgetLimit:5});
  assert.ok(m.id); assert.strictEqual(m.state,'running');
  const loaded = new MissionRuntime(new MissionStore(dir));
  const m2 = loaded.getMission(m.id);
  assert.ok(m2); assert.strictEqual(m2.title,'M1'); assert.strictEqual(m2.tasks.length,2);
});

// dependency cycle rejection
t('create mission rejects dependency cycle', ()=>{
  let e=null;
  try { rt.createMission({title:'C', tasks:[{id:'a',title:'A',deps:['b']},{id:'b',title:'B',deps:['a']}]}); } catch(x){e=x;}
  assert.ok(e && /DEPENDENCY_CYCLE/.test(e.message));
});

// unknown dependency
t('create mission rejects unknown dependency', ()=>{
  let e=null;
  try { rt.createMission({title:'U', tasks:[{id:'a',title:'A',deps:['zzz']}]}); } catch(x){e=x;}
  assert.ok(e && /UNKNOWN_DEPENDENCY/.test(e.message));
});

// transition invalid
const m0 = rt.createMission({title:'M2', tasks:[{title:'A'}]});
t('invalid transition rejected', ()=>{
  let e=null;
  try { rt.transitionMission(m0.id,'queued','x'); } catch(x){e=x;}
  assert.ok(e && /ILLEGAL_MISSION_TRANSITION/.test(e.message));
});

// task lifecycle + idempotency
const m = rt.createMission({title:'M3', tasks:[{id:'t1',title:'A'},{id:'t2',title:'B',deps:['t1']}]});
rt.startTask(m.id,'t1');
rt.succeedTask(m.id,'t1',{ok:true},'key-1');
t('dependent task becomes ready after dep succeeds', ()=>{
  const mm = rt.getMission(m.id);
  const t2 = mm.tasks.find(x=>x.id==='t2');
  assert.strictEqual(t2.state,'ready');
});
// idempotency: succeed again with same key -> no duplicate
rt.succeedTask(m.id,'t1',{ok:true},'key-1');
t('idempotent succeed does not error', ()=> assert.ok(true));
// mismatched key
t('idempotency key mismatch throws', ()=>{
  let e=null;
  try { rt.succeedTask(m.id,'t1',{ok:true},'key-2'); } catch(x){e=x;}
  assert.ok(e && /IDEMPOTENCY_KEY_MISMATCH/.test(e.message));
});

// approval fingerprint
const ma = rt.createMission({title:'MA', tasks:[{title:'A'}]});
const ar = rt.requestApproval(ma.id, ma.tasks[0].id, 'publish', 'res://x', {v:1}, 'mission', 60000);
t('approval created pending', ()=> assert.strictEqual(ar.approval.status,'pending'));
const apId = ar.approval.id;
// resolve
rt.resolveApproval(ma.id, apId, true, 'user');
t('approval approved', ()=> {
  const mm = rt.getMission(ma.id);
  const a = mm.approvals.find(x=>x.id===apId);
  assert.strictEqual(a.status,'approved');
});
// fingerprint mismatch
const mb = rt.createMission({title:'MB', tasks:[{title:'A'}]});
const ar2 = rt.requestApproval(mb.id, mb.tasks[0].id, 'publish', 'res://x', {v:1}, 'mission', 60000);
rt.resolveApproval(mb.id, ar2.approval.id, true, 'user');
t('validateApproval fingerprint mismatch throws', ()=>{
  let e=null;
  try { rt.validateApproval(mb.id, ar2.approval.id, 'publish', 'res://x', {v:2}, 'mission'); } catch(x){e=x;}
  assert.ok(e && /FINGERPRINT_MISMATCH/.test(e.message));
});
t('validateApproval expired throws', ()=>{
  // create approval with past expiry by manual
  const mc = rt.createMission({title:'MC', tasks:[{title:'A'}]});
  const a = rt.requestApproval(mc.id, mc.tasks[0].id, 'act','res',{},'mission',600000).approval;
  rt.resolveApproval(mc.id, a.id, true, 'user');
  // force expiry by mutating stored
  const store = new MissionStore(dir);
  const missions = store.loadAll();
  const m = missions.find(x=>x.id===mc.id);
  const ap = m.approvals.find(x=>x.id===a.id);
  ap.expiresAt = new Date(Date.now()-1000).toISOString();
  store.saveAll(missions);
  const rt2 = new MissionRuntime(new MissionStore(dir));
  let e=null;
  try { rt2.validateApproval(mc.id, a.id, 'act','res',{},'mission'); } catch(x){e=x;}
  assert.ok(e && e.message === 'APPROVAL_EXPIRED');
});

// recovery: interrupted running task -> outcome_unknown
const dir2 = tmpDir();
const rt3 = new MissionRuntime(new MissionStore(dir2));
const m3 = rt3.createMission({title:'MR', tasks:[{title:'A'}]});
rt3.startTask(m3.id, m3.tasks[0].id);
// simulate crash: set state running but no result, then new runtime recovers
const store3 = new MissionStore(dir2);
const missions3 = store3.loadAll();
const mm3 = missions3.find(x=>x.id===m3.id);
mm3.state='running';
mm3.tasks[0].state='running';
store3.saveAll(missions3);
const rt4 = new MissionRuntime(new MissionStore(dir2));
const recovered = rt4.getMission(m3.id);
t('recovery marks running task outcome_unknown', ()=> {
  const t0 = recovered.tasks[0];
  assert.strictEqual(t0.state,'outcome_unknown');
});
t('recovery moves mission to paused/recovering', ()=> {
  assert.ok(['recovering','paused'].includes(recovered.state));
});

// retry task
const dir3 = tmpDir();
const rt5 = new MissionRuntime(new MissionStore(dir3));
const m5 = rt5.createMission({title:'Retry', tasks:[{title:'A'}]});
rt5.startTask(m5.id, m5.tasks[0].id);
rt5.failTask(m5.id, m5.tasks[0].id, new Error('boom'), true);
rt5.retryTask(m5.id, m5.tasks[0].id);
t('retry moves task to ready', ()=> {
  const mm = rt5.getMission(m5.id);
  assert.strictEqual(mm.tasks[0].state,'ready');
});

// cancel mission
const m6 = rt5.createMission({title:'Cancel', tasks:[{title:'A'}]});
rt5.cancelMission(m6.id);
t('cancel sets cancelled', ()=> assert.strictEqual(rt5.getMission(m6.id).state,'cancelled'));

// budget
const mbg = rt5.createMission({title:'Budget', tasks:[{title:'A'}], budgetLimit:0});
t('budget object present', ()=> assert.ok(mbg.budget && mbg.budget.limit===0));

console.log('\nMission runtime tests: '+passed+' lulus, '+failed+' gagal');
process.exit(failed?1:0);
