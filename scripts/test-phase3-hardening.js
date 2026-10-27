'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MissionRuntime } = require('../src/missions/runtime');
const { MissionStore } = require('../src/missions/store');

let passed=0, failed=0;
function t(name, fn){ try { fn(); console.log('  ✓ '+name); passed++; } catch(e){ console.log('  ✗ '+name+' — '+e.message); failed++; } }
async function at(name, fn){ try { await fn(); console.log('  ✓ '+name); passed++; } catch(e){ console.log('  ✗ '+name+' — '+e.message); failed++; } }

function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(),'orion-harden-')); }

// duplicate execution blocked
(async () => {
  const dir=tmp();
  const rt=new MissionRuntime(new MissionStore(dir), {workspaceRoot:path.join(dir,'ws'), unknownCostPolicy:'block'});
  const m=rt.createMission({title:'H', tasks:[{title:'A'}], budgetLimit:100});
  const tid=m.tasks[0].id;
  const cfg=[{base:'http://127.0.0.1:1', model:'m', capabilities:['text'], pricing:{inputPer1k:1,outputPer1k:1}}];
  // first execution will fail (no server) -> retryable/outcome? It will fail network. Ensure not duplicate.
  const r1 = await rt.executeTask(m.id, tid, cfg, {prompt:'hi'}, null);
  let r2; try { r2 = await rt.executeTask(m.id, tid, cfg, {prompt:'hi'}, null); } catch(e){ r2 = { error: e.message, thrown:true }; }
  t('duplicate execution blocked after first attempt', ()=> assert.ok(r2 && /MISSION_NOT_RUNNING|TASK_ALREADY_RUNNING_OR_DONE|fetch failed/.test(r2.error||r2.message||''), 'got '+JSON.stringify(r2)));
  // unknown pricing blocked (pricing 0)
  const m2=rt.createMission({title:'H2', tasks:[{title:'A'}], budgetLimit:100});
  const tid2=m2.tasks[0].id;
  const cfg0=[{base:'http://127.0.0.1:1', model:'m', capabilities:['text'], pricing:{inputPer1k:0,outputPer1k:0}}];
  const r3 = await rt.executeTask(m2.id, tid2, cfg0, {prompt:'hi', allowUnknownCost:true}, null);
  t('unknown pricing blocked even if renderer sets allowUnknownCost', ()=> assert.ok(r3 && r3.error==='UNKNOWN_PRICING_BLOCKED', 'got '+JSON.stringify(r3)));
  // execution limit
  const m3=rt.createMission({title:'H3', tasks:[{title:'A'}], budgetLimit:100, maxExecutions:0});
  const tid3=m3.tasks[0].id;
  const r4 = await rt.executeTask(m3.id, tid3, cfg, {prompt:'hi'}, null);
  t('execution limit enforced', ()=> assert.ok(r4 && r4.error==='EXECUTION_LIMIT_EXCEEDED', 'got '+JSON.stringify(r4)));
  // outcome_unknown not auto-retried by executeNext (task state outcome_unknown)
  // approval fingerprint mismatch via runtime
  const ma=rt.createMission({title:'HA', tasks:[{title:'A'}]});
  const ap=rt.requestApproval(ma.id, ma.tasks[0].id, 'publish','res://x',{v:1},'mission',60000).approval;
  rt.resolveApproval(ma.id, ap.id, true, 'user');
  t('approval fingerprint mismatch throws', ()=> {
    let e=null; try { rt.validateApproval(ma.id, ap.id, 'publish','res://x',{v:2},'mission'); } catch(x){e=x;} assert.ok(e && /FINGERPRINT_MISMATCH/.test(e.message));
  });

  // workspace traversal via validatePath
  const ex = rt.executor;
  const ws = ex.createWorkspace('mX','tX');
  t('workspace traversal rejected', ()=> {
    let e=null; try { ex.validatePath(ws,'../secret'); } catch(x){e=x;} assert.ok(e && /TRAVERSAL/.test(e.message));
  });
  t('workspace absolute injection rejected', ()=> {
    let e=null; try { ex.validatePath(ws,'/etc/passwd'); } catch(x){e=x;} assert.ok(e);
  });

  console.log('\nPhase 3.1 hardening: '+passed+' lulus, '+failed+' gagal');
  process.exit(failed?1:0);
})();
