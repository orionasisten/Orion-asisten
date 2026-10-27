'use strict';
const SM = require('./state-machine');
const StoreMod = require('./store');
const Budget = require('./budget');
const Router = require('./router');
const Adapters = require('./adapters');
const Executor = require('./executor');

class MissionRuntime {
  constructor(store, opts){
    opts = opts || {};
    this.store = store;
    this.opts = opts;
    this.unknownCostPolicy = opts.unknownCostPolicy || 'block';
    this.executor = new Executor({ workspaceRoot: opts.workspaceRoot, globalLimit: opts.globalLimit||2, perMissionLimit: opts.perMissionLimit||1 });
    this.recover();
  }

  _load(){ return this.store.loadAll(); }
  _save(missions){ this.store.saveAll(missions); }
  _find(missions, id){ return missions.find(m=>m.id===id); }

  createMission(spec){
    spec = spec || {};
    const title = String(spec.title||'Untitled mission').slice(0,120);
    const goal = String(spec.goal||'').slice(0,2000);
    const tasks = Array.isArray(spec.tasks) ? spec.tasks : [];
    const normTasks = tasks.map((t,i)=>({
      id: t.id || StoreMod.taskId(),
      title: String(t.title||('Task '+(i+1))).slice(0,120),
      deps: Array.isArray(t.deps) ? t.deps.slice() : [],
      state: 'pending',
      attempts: 0,
      maxAttempts: Number.isFinite(t.maxAttempts)? t.maxAttempts : 2,
      timeoutMs: Number.isFinite(t.timeoutMs)? t.timeoutMs : 60000,
      result: null,
      lastError: null,
      idempotencyKey: null,
      createdAt: StoreMod.now(),
      updatedAt: StoreMod.now()
    }));
    // cycle check
    if(SM.detectCycle(normTasks)) throw new Error('DEPENDENCY_CYCLE');
    // validate deps exist
    const ids = new Set(normTasks.map(t=>t.id));
    for(const t of normTasks){ for(const d of t.deps){ if(!ids.has(d)) throw new Error('UNKNOWN_DEPENDENCY: '+d); } }
    const mission = {
      id: StoreMod.id(),
      title, goal,
      state: 'queued',
      tasks: normTasks,
      budget: { limit: Number.isFinite(spec.budgetLimit)? spec.budgetLimit : null, spent: 0, reserved: 0, currency: spec.currency||'unit', ledger: [], executions: 0, maxExecutions: Number.isFinite(spec.maxExecutions)? spec.maxExecutions : 100 },
      approvals: [],
      events: [],
      artifacts: [],
      createdAt: StoreMod.now(),
      updatedAt: StoreMod.now(),
      version: 1
    };
    this._event(mission, 'mission.created', null, 'queued', {taskCount: normTasks.length});
    // auto-plan: move to planning then running if tasks ready
    this._transitionMission(mission, 'planning', 'auto-plan');
    this._transitionMission(mission, 'running', 'auto-start');
    // mark ready tasks
    this._refreshTaskReadiness(mission);
    this._saveAllMissions(mission);
    return this._public(mission);
  }

  _saveAllMissions(mission){
    const all = this.store.loadAll();
    const i = all.findIndex(m=>m.id===mission.id);
    if(i>=0) all[i]=mission; else all.unshift(mission);
    this.store.saveAll(all);
  }
  _persistMission(mission){
    mission.updatedAt = StoreMod.now();
    const all = this.store.loadAll();
    const i = all.findIndex(m=>m.id===mission.id);
    if(i>=0) all[i]=mission; else all.unshift(mission);
    this.store.saveAll(all);
  }

  _event(mission, type, taskId, stateChange, meta){
    const ev = {
      id: 'ev-'+StoreMod.now()+'-'+Math.random().toString(36).slice(2,8),
      missionId: mission.id,
      taskId: taskId||null,
      type,
      timestamp: StoreMod.now(),
      stateChange: stateChange||null,
      meta: meta||{}
    };
    mission.events = mission.events || [];
    mission.events.push(ev);
    if(mission.events.length > 500) mission.events = mission.events.slice(-500);
  }

  _transitionMission(mission, to, reason){
    SM.assertMissionTransition(mission.state, to);
    const prev = mission.state;
    mission.state = to;
    this._event(mission, 'mission.transition', null, prev+'->'+to, {reason});
  }

  _refreshTaskReadiness(mission){
    for(const t of mission.tasks){
      if(t.state==='pending'){
        const depsOk = (t.deps||[]).every(d=>{const dep=mission.tasks.find(x=>x.id===d); return dep && dep.state==='succeeded';});
        if(depsOk){ SM.assertTaskTransition(t.state,'ready'); t.state='ready'; t.updatedAt=StoreMod.now(); this._event(mission,'task.ready',t.id,'pending->ready',{}); }
      }
    }
  }

  getMission(id){ const m=this.store.get(id); return m? this._public(m): null; }
  listMissions(){ return this.store.loadAll().map(m=>this._public(m)); }

  transitionMission(id, to, reason){
    const missions = this.store.loadAll();
    const m = this._find(missions, id);
    if(!m) throw new Error('MISSION_NOT_FOUND');
    SM.assertMissionTransition(m.state, to);
    const prev=m.state; m.state=to; m.updatedAt=StoreMod.now();
    this._event(m, 'mission.transition', null, prev+'->'+to, {reason: reason||'manual'});
    this._persistMission(m);
    // if resuming to running, refresh readiness
    if(to==='running') this._refreshTaskReadiness(m);
    this._persistMission(m);
    return this._public(m);
  }

  pauseMission(id){ return this.transitionMission(id,'paused','user-pause'); }
  cancelMission(id){ return this.transitionMission(id,'cancelled','user-cancel'); }
  resumeMission(id){ return this.transitionMission(id,'running','user-resume'); }

  addTask(id, taskSpec){
    const missions=this.store.loadAll(); const m=this._find(missions,id); if(!m) throw new Error('MISSION_NOT_FOUND');
    if(['completed','cancelled','failed'].includes(m.state)) throw new Error('MISSION_TERMINAL');
    const t={
      id: taskSpec.id || StoreMod.taskId(),
      title: String(taskSpec.title||'Task').slice(0,120),
      deps: Array.isArray(taskSpec.deps)? taskSpec.deps.slice():[],
      state:'pending',
      attempts:0,
      maxAttempts: Number.isFinite(taskSpec.maxAttempts)? taskSpec.maxAttempts:2,
      timeoutMs: Number.isFinite(taskSpec.timeoutMs)? taskSpec.timeoutMs:60000,
      result:null, lastError:null, idempotencyKey:null,
      createdAt: StoreMod.now(), updatedAt: StoreMod.now()
    };
    const ids=new Set(m.tasks.map(x=>x.id)); if(ids.has(t.id)) throw new Error('DUPLICATE_TASK_ID');
    for(const d of t.deps){ if(!ids.has(d)) throw new Error('UNKNOWN_DEPENDENCY: '+d); }
    const next=[...m.tasks,t];
    if(SM.detectCycle(next)) throw new Error('DEPENDENCY_CYCLE');
    m.tasks.push(t);
    this._refreshTaskReadiness(m);
    this._persistMission(m);
    this._event(m,'task.added',t.id,null,{title:t.title});
    this._persistMission(m);
    return this._public(m);
  }

  addDependency(missionId, taskId, depId){
    const missions=this.store.loadAll(); const m=this._find(missions,missionId); if(!m) throw new Error('MISSION_NOT_FOUND');
    const t=m.tasks.find(x=>x.id===taskId); const d=m.tasks.find(x=>x.id===depId);
    if(!t||!d) throw new Error('TASK_NOT_FOUND');
    if(taskId===depId) throw new Error('SELF_DEPENDENCY');
    if(!t.deps.includes(depId)) t.deps.push(depId);
    if(SM.detectCycle(m.tasks)) { t.deps = t.deps.filter(x=>x!==depId); throw new Error('DEPENDENCY_CYCLE'); }
    t.updatedAt=StoreMod.now();
    this._event(m,'task.dependency_added',taskId,null,{dep:depId});
    this._persistMission(m);
    this._refreshTaskReadiness(m);
    this._persistMission(m);
    return this._public(m);
  }

  // Task execution helpers (called by trusted runtime/executor, not renderer directly in production;
  // exposed via IPC for minimal integration but validated).
  startTask(missionId, taskId){
    const missions=this.store.loadAll(); const m=this._find(missions,missionId); if(!m) throw new Error('MISSION_NOT_FOUND');
    const t=m.tasks.find(x=>x.id===taskId); if(!t) throw new Error('TASK_NOT_FOUND');
    if(m.state!=='running' && m.state!=='recovering') throw new Error('MISSION_NOT_RUNNING');
    // deps
    const depsOk=(t.deps||[]).every(d=>{const dep=m.tasks.find(x=>x.id===d); return dep && dep.state==='succeeded';});
    if(!depsOk) throw new Error('DEPENDENCIES_NOT_MET');
    if(t.state==='pending'||t.state==='ready'){
      if(t.state==='pending'){ SM.assertTaskTransition(t.state,'ready'); t.state='ready'; }
      SM.assertTaskTransition(t.state,'running');
      t.state='running'; t.attempts++; t.startedAt=StoreMod.now(); t.updatedAt=StoreMod.now();
      this._event(m,'task.started',taskId,'ready->running',{attempt:t.attempts});
      this._persistMission(m);
    }
    return this._public(m);
  }

  succeedTask(missionId, taskId, result, idempotencyKey){
    const missions=this.store.loadAll(); const m=this._find(missions,missionId); if(!m) throw new Error('MISSION_NOT_FOUND');
    const t=m.tasks.find(x=>x.id===taskId); if(!t) throw new Error('TASK_NOT_FOUND');
    // idempotency
    if(t.state==='succeeded'){
      if(idempotencyKey && t.idempotencyKey && t.idempotencyKey!==idempotencyKey) throw new Error('IDEMPOTENCY_KEY_MISMATCH');
      return this._public(m);
    }
    if(!['running','waiting_approval','outcome_unknown'].includes(t.state)) throw new Error('TASK_NOT_RUNNING');
    SM.assertTaskTransition(t.state,'succeeded');
    t.state='succeeded'; t.result=result||null; t.idempotencyKey=idempotencyKey||t.idempotencyKey; t.completedAt=StoreMod.now(); t.updatedAt=StoreMod.now(); t.lastError=null;
    this._event(m,'task.succeeded',taskId,t.state+'->succeeded',{});
    this._refreshTaskReadiness(m);
    this._checkMissionCompletion(m);
    this._persistMission(m);
    return this._public(m);
  }

  failTask(missionId, taskId, error, retryable){
    const missions=this.store.loadAll(); const m=this._find(missions,missionId); if(!m) throw new Error('MISSION_NOT_FOUND');
    const t=m.tasks.find(x=>x.id===taskId); if(!t) throw new Error('TASK_NOT_FOUND');
    if(t.state==='succeeded') throw new Error('TASK_ALREADY_SUCCEEDED');
    const cls = retryable ? 'retryable' : 'non_retryable';
    if(retryable && t.attempts < t.maxAttempts){
      // retry_wait
      if(['running','waiting_approval','outcome_unknown','failed'].includes(t.state)){
        // allow transition to retry_wait if legal
        if(SM.canTransitionTask(t.state,'retry_wait')){ SM.assertTaskTransition(t.state,'retry_wait'); t.state='retry_wait'; }
        else if(SM.canTransitionTask(t.state,'failed')){ SM.assertTaskTransition(t.state,'failed'); t.state='failed'; }
      }
    } else {
      if(SM.canTransitionTask(t.state,'failed')){ SM.assertTaskTransition(t.state,'failed'); t.state='failed'; }
    }
    t.lastError = { message: String(error&&error.message||error||'error').slice(0,500), class: cls, at: StoreMod.now() };
    t.updatedAt=StoreMod.now();
    this._event(m,'task.failed',taskId,null,{error:t.lastError.message, retryable:!!retryable, class:cls});
    // mission failure propagation if any task failed non-retryably? Mark mission failed only if no ready/running tasks
    const hasPending = m.tasks.some(t=>['pending','ready','running','retry_wait','waiting_approval','outcome_unknown'].includes(t.state));
    if(!hasPending && m.tasks.some(t=>t.state==='failed')){
      try { this._transitionMission(m,'failed','task_failed'); } catch(e){ /* already terminal */ }
    }
    this._persistMission(m);
    return this._public(m);
  }

  outcomeUnknown(missionId, taskId, reason){
    const missions=this.store.loadAll(); const m=this._find(missions,missionId); if(!m) throw new Error('MISSION_NOT_FOUND');
    const t=m.tasks.find(x=>x.id===taskId); if(!t) throw new Error('TASK_NOT_FOUND');
    if(t.state==='succeeded') throw new Error('TASK_ALREADY_SUCCEEDED');
    if(SM.canTransitionTask(t.state,'outcome_unknown')){ SM.assertTaskTransition(t.state,'outcome_unknown'); t.state='outcome_unknown'; }
    t.lastError = { message: String(reason||'outcome unknown').slice(0,500), class:'ambiguous', at: StoreMod.now() };
    t.updatedAt=StoreMod.now();
    this._event(m,'task.outcome_unknown',taskId,null,{reason});
    this._persistMission(m);
    return this._public(m);
  }

  requestApproval(missionId, taskId, action, resource, params, scope, ttlMs){
    const missions=this.store.loadAll(); const m=this._find(missions,missionId); if(!m) throw new Error('MISSION_NOT_FOUND');
    const t = taskId? m.tasks.find(x=>x.id===taskId): null;
    if(taskId && !t) throw new Error('TASK_NOT_FOUND');
    const fp = StoreMod.fingerprint(action, resource, params, scope);
    const approval = {
      id: 'ap-'+StoreMod.now()+'-'+Math.random().toString(36).slice(2,8),
      missionId, taskId: taskId||null,
      action, resource, scope,
      params: params||{},
      fingerprint: fp,
      status: 'pending',
      createdAt: StoreMod.now(),
      expiresAt: new Date(Date.now() + (ttlMs||600000)).toISOString()
    };
    m.approvals.push(approval);
    if(t){ try { if(SM.canTransitionTask(t.state,'waiting_approval')){ SM.assertTaskTransition(t.state,'waiting_approval'); t.state='waiting_approval'; t.updatedAt=StoreMod.now(); } } catch(e){} }
    try { if(SM.canTransitionMission(m.state,'waiting_approval')) this._transitionMission(m,'waiting_approval','approval_requested'); } catch(e){}
    this._event(m,'approval.requested',taskId||null,null,{approvalId:approval.id, action, fingerprint:fp});
    this._persistMission(m);
    return {approval: approval, mission: this._public(m)};
  }

  resolveApproval(missionId, approvalId, approved, actor){
    const missions=this.store.loadAll(); const m=this._find(missions,missionId); if(!m) throw new Error('MISSION_NOT_FOUND');
    const a = m.approvals.find(x=>x.id===approvalId); if(!a) throw new Error('APPROVAL_NOT_FOUND');
    if(a.status!=='pending') throw new Error('APPROVAL_NOT_PENDING');
    if(new Date(a.expiresAt) <= new Date()) { a.status='expired'; this._persistMission(m); throw new Error('APPROVAL_EXPIRED'); }
    a.status = approved ? 'approved' : 'rejected';
    a.resolvedAt = StoreMod.now();
    a.actor = actor||'user';
    this._event(m, approved?'approval.approved':'approval.rejected', a.taskId, null, {approvalId, fingerprint:a.fingerprint});
    // if approved and task waiting, move task back to running
    if(approved && a.taskId){
      const t = m.tasks.find(x=>x.id===a.taskId);
      if(t && t.state==='waiting_approval'){ SM.assertTaskTransition(t.state,'running'); t.state='running'; t.updatedAt=StoreMod.now(); }
    }
    // mission state
    if(approved){
      if(m.state==='waiting_approval'){ try { this._transitionMission(m,'running','approval_granted'); } catch(e){} }
    } else {
      if(m.state==='waiting_approval'){ try { this._transitionMission(m,'failed','approval_rejected'); } catch(e){} }
    }
    this._persistMission(m);
    return {approval:a, mission:this._public(m)};
  }

  validateApproval(missionId, approvalId, action, resource, params, scope){
    const m = this.store.get(missionId); if(!m) throw new Error('MISSION_NOT_FOUND');
    const a = m.approvals.find(x=>x.id===approvalId); if(!a) throw new Error('APPROVAL_NOT_FOUND');
    if(a.status!=='approved') throw new Error('APPROVAL_NOT_APPROVED');
    if(new Date(a.expiresAt) <= new Date()) throw new Error('APPROVAL_EXPIRED');
    const fp = StoreMod.fingerprint(action, resource, params, scope);
    if(fp !== a.fingerprint) throw new Error('APPROVAL_FINGERPRINT_MISMATCH');
    return true;
  }

  retryTask(missionId, taskId){
    const missions=this.store.loadAll(); const m=this._find(missions,missionId); if(!m) throw new Error('MISSION_NOT_FOUND');
    const t=m.tasks.find(x=>x.id===taskId); if(!t) throw new Error('TASK_NOT_FOUND');
    if(!['failed','retry_wait','outcome_unknown'].includes(t.state)) throw new Error('TASK_NOT_RETRYABLE');
    // reset to ready if deps ok
    const depsOk=(t.deps||[]).every(d=>{const dep=m.tasks.find(x=>x.id===d); return dep && dep.state==='succeeded';});
    if(!depsOk) throw new Error('DEPENDENCIES_NOT_MET');
    const prev=t.state; 
    // transition through retry_wait if needed
    if(t.state==='failed'){
      if(SM.canTransitionTask(t.state,'retry_wait')){ SM.assertTaskTransition(t.state,'retry_wait'); t.state='retry_wait'; }
    }
    if(t.state==='retry_wait' || t.state==='outcome_unknown'){
      if(t.state==='outcome_unknown'){
        if(SM.canTransitionTask(t.state,'failed')){ SM.assertTaskTransition(t.state,'failed'); t.state='failed'; }
        if(SM.canTransitionTask(t.state,'retry_wait')){ SM.assertTaskTransition(t.state,'retry_wait'); t.state='retry_wait'; }
      }
      SM.assertTaskTransition(t.state,'ready'); t.state='ready';
    }
    t.lastError=null; t.updatedAt=StoreMod.now();
    this._event(m,'task.retried',taskId,prev+'->ready',{});
    if(m.state==='failed' || m.state==='paused'){ try { this._transitionMission(m,'running','retry'); } catch(e){} }
    this._refreshTaskReadiness(m);
    this._persistMission(m);
    return this._public(m);
  }

  _checkMissionCompletion(m){
    const allDone = m.tasks.every(t=> t.state==='succeeded' || t.state==='cancelled');
    const anyFailed = m.tasks.some(t=>t.state==='failed' || t.state==='outcome_unknown');
    if(allDone && !anyFailed){
      try { this._transitionMission(m,'completed','all_tasks_done'); } catch(e){}
    }
  }

  _refreshTaskReadiness(m){
    for(const t of m.tasks){
      if(t.state==='pending' || t.state==='retry_wait'){
        const depsOk=(t.deps||[]).every(d=>{const dep=m.tasks.find(x=>x.id===d); return dep && dep.state==='succeeded';});
        if(depsOk && t.state==='pending'){ SM.assertTaskTransition(t.state,'ready'); t.state='ready'; t.updatedAt=StoreMod.now(); this._event(m,'task.ready',t.id,'pending->ready',{}); }
        if(depsOk && t.state==='retry_wait'){ SM.assertTaskTransition(t.state,'ready'); t.state='ready'; t.updatedAt=StoreMod.now(); this._event(m,'task.ready',t.id,'retry_wait->ready',{}); }
      }
    }
  }

  recover(){
    const missions = this.store.loadAll();
    let changed=false;
    for(const m of missions){
      if(['running','recovering','waiting_approval'].includes(m.state)){
        // mark running tasks as outcome_unknown (ambiguous)
        for(const t of m.tasks){
          if(t.state==='running'){
            if(SM.canTransitionTask(t.state,'outcome_unknown')){ t.state='outcome_unknown'; t.lastError={message:'interrupted',class:'ambiguous',at:StoreMod.now()}; t.updatedAt=StoreMod.now(); changed=true; }
          }
        }
        try { m.state='recovering'; changed=true; } catch(e){}
        this._event(m,'mission.recovered',null,null,{});
        // if no ambiguous/running, move to paused
        const hasUnknown = m.tasks.some(t=>t.state==='outcome_unknown');
        if(!hasUnknown){ try { this._transitionMission(m,'paused','recovered'); } catch(e){ m.state='paused'; } }
        m.updatedAt=StoreMod.now();
        changed=true;
      }
    }
    if(changed) this.store.saveAll(missions);
  }

  // ---- Phase 3: budget + routing + controlled execution ----
  _adaptersFromConfig(configs, apiKey){
    const out = [];
    for(const c of (configs||[])){
      if(!c || !c.base) continue;
      const pricing = c.pricing || { inputPer1k:0, outputPer1k:0, currency: c.currency||'unit' };
      const pin = Number(pricing.inputPer1k), pout = Number(pricing.outputPer1k);
      if(!isFinite(pin) || !isFinite(pout) || pin < 0 || pout < 0) continue; // skip invalid
      out.push(new Adapters.OpenAICompatibleAdapter({
        name: c.name || 'openai-compatible',
        base: c.base,
        model: c.model || '',
        apiKey: apiKey || c.apiKey || '',
        capabilities: Array.isArray(c.capabilities) ? c.capabilities : ['text','usage_reporting','cancellation'],
        pricing: { inputPer1k: pin, outputPer1k: pout, currency: pricing.currency||'unit' },
        timeoutMs: Number.isFinite(c.timeoutMs)? c.timeoutMs : 60000,
        priority: Number.isFinite(c.priority)? c.priority : 100,
        dataPolicy: c.dataPolicy || 'standard'
      }));
    }
    return out;
  }

  async executeTask(missionId, taskId, adapterConfigs, taskPayload, apiKey){
    const missions = this.store.loadAll();
    const m = this._find(missions, missionId);
    if(!m) throw new Error('MISSION_NOT_FOUND');
    const t = m.tasks.find(x=>x.id===taskId);
    if(!t) throw new Error('TASK_NOT_FOUND');
    if(m.state !== 'running' && m.state !== 'recovering') throw new Error('MISSION_NOT_RUNNING');
    // duplicate execution guard
    if(['running','outcome_unknown','succeeded'].includes(t.state) && t.startedAt && t.state!=='ready' && t.state!=='retry_wait' && t.state!=='pending'){
      // allow retry_wait/pending/ready to proceed; block active/ambiguous/done
      if(t.state==='running' || t.state==='outcome_unknown' || t.state==='succeeded'){
        return { ok:false, error:'TASK_ALREADY_RUNNING_OR_DONE', state: t.state };
      }
    }
    const depsOk = (t.deps||[]).every(d=>{const dep=m.tasks.find(x=>x.id===d); return dep && dep.state==='succeeded';});
    if(!depsOk) throw new Error('DEPENDENCIES_NOT_MET');
    // start task
    if(t.state==='pending' || t.state==='ready' || t.state==='retry_wait'){
      if(t.state==='pending'){ if(SM.canTransitionTask(t.state,'ready')){ SM.assertTaskTransition(t.state,'ready'); t.state='ready'; } }
      if(t.state==='retry_wait'){ if(SM.canTransitionTask(t.state,'ready')){ SM.assertTaskTransition(t.state,'ready'); t.state='ready'; } }
      SM.assertTaskTransition(t.state,'running');
      t.state='running'; t.attempts++; t.startedAt=StoreMod.now(); t.updatedAt=StoreMod.now();
      this._event(m,'task.started',taskId,'->running',{attempt:t.attempts});
    }
    const adapters = this._adaptersFromConfig(adapterConfigs, apiKey);
    const required = Router.requiredCapsFor(taskPayload||{});
    const routeRes = Router.route({ task: taskPayload||{}, adapters, routingClass: (taskPayload&&taskPayload.routingClass) || 'low_cost' });
    if(!routeRes.ok){
      t.lastError = { message: routeRes.reason, class:'no_adapter', at: StoreMod.now() };
      if(SM.canTransitionTask(t.state,'failed')){ SM.assertTaskTransition(t.state,'failed'); t.state='failed'; }
      this._event(m,'task.failed',taskId,null,{reason:routeRes.reason});
      this._persistMission(m);
      return { ok:false, error: routeRes.error, reason: routeRes.reason };
    }
    const adapter = routeRes.adapter;
    // capability check
    const capCheck = Adapters.hasAll(adapter.capabilities, required);
    if(!capCheck.ok){
      t.lastError = { message: 'missing capabilities: '+capCheck.missing.join(','), class:'capability', at: StoreMod.now() };
      if(SM.canTransitionTask(t.state,'failed')){ SM.assertTaskTransition(t.state,'failed'); t.state='failed'; }
      this._persistMission(m);
      return { ok:false, error:'MISSING_CAPABILITIES', missing: capCheck.missing };
    }
    // budget reservation
    // approval validation at execution boundary (if provided)
    if(taskPayload && taskPayload.approvalId){
      this.validateApproval(missionId, taskPayload.approvalId, taskPayload.approvalAction||'execute', taskPayload.approvalResource||('mission:'+missionId+'/task:'+taskId), taskPayload.approvalParams||{}, taskPayload.approvalScope||'mission');
    }
    // execution count limit
    if(!m.budget) m.budget = {limit:null,spent:0,reserved:0,currency:'unit',ledger:[],executions:0,maxExecutions:100};
    if(typeof m.budget.executions !== 'number') m.budget.executions = 0;
    if(typeof m.budget.maxExecutions !== 'number') m.budget.maxExecutions = 100;
    if(m.budget.executions >= m.budget.maxExecutions){
      t.lastError = { message:'execution limit exceeded', class:'budget', at: StoreMod.now() };
      if(SM.canTransitionTask(t.state,'failed')){ SM.assertTaskTransition(t.state,'failed'); t.state='failed'; }
      this._persistMission(m);
      return { ok:false, error:'EXECUTION_LIMIT_EXCEEDED' };
    }

    const ledger = new Budget.BudgetLedger(m);
    const estCost = adapter.estimateCost({promptTokens: (taskPayload&&taskPayload.estimatedPromptTokens)||0, completionTokens: (taskPayload&&taskPayload.estimatedCompletionTokens)||0});
    // unknown pricing policy
    const pricingUnknown = (!adapter.pricing || (adapter.pricing.inputPer1k===0 && adapter.pricing.outputPer1k===0));
  if(pricingUnknown && this.unknownCostPolicy === 'block'){
      // block unknown pricing
      t.lastError = { message: 'unknown pricing policy: block', class:'budget', at: StoreMod.now() };
      if(SM.canTransitionTask(t.state,'failed')){ SM.assertTaskTransition(t.state,'failed'); t.state='failed'; }
      this._persistMission(m);
      return { ok:false, error:'UNKNOWN_PRICING_BLOCKED' };
    }
    const resv = ledger.reserve(estCost || 0, { taskId: t.id, provider: adapter.name, model: adapter.model });
    if(!resv.ok){
      t.lastError = { message: resv.reason, class:'budget', at: StoreMod.now() };
      if(SM.canTransitionTask(t.state,'failed')){ SM.assertTaskTransition(t.state,'failed'); t.state='failed'; }
      this._event(m,'budget.rejected',taskId,null,{reason:resv.reason});
      this._persistMission(m);
      return { ok:false, error: resv.reason, remaining: resv.remaining };
    }
    this._event(m,'budget.reserved',taskId,null,{reservationId: resv.reservationId, estimate: estCost});
    m.budget.executions = (m.budget.executions||0) + 1;

    // concurrency slot
    const release = this.executor.acquire(m.id, t.id);
    if(!release){
      // cannot run now; release reservation, revert task to ready
      ledger.release(resv.reservationId, 'concurrency_limit');
      if(SM.canTransitionTask(t.state,'ready')){ SM.assertTaskTransition(t.state,'ready'); t.state='ready'; }
      this._persistMission(m);
      return { ok:false, error:'CONCURRENCY_LIMIT', queued: true };
    }

    // workspace
    let workspace = null;
    try { workspace = this.executor.createWorkspace(m.id, t.id); } catch(e){
      release();
      ledger.release(resv.reservationId, 'workspace_error');
      if(SM.canTransitionTask(t.state,'failed')){ SM.assertTaskTransition(t.state,'failed'); t.state='failed'; }
      t.lastError = { message: String(e.message), class:'workspace', at: StoreMod.now() };
      this._persistMission(m);
      return { ok:false, error:'WORKSPACE_ERROR', message: e.message };
    }

    // cancellation check
    if(m.state === 'cancelled'){ release(); ledger.release(resv.reservationId,'cancelled'); return { ok:false, error:'CANCELLED' }; }

    // execute with timeout
    const timeoutMs = Number.isFinite(taskPayload && taskPayload.timeoutMs) ? taskPayload.timeoutMs : t.timeoutMs;
    let result = null;
    let execError = null;
    let timedOut = false;
    const started = Date.now();
    try {
      result = await Promise.race([
        adapter.execute({ prompt: (taskPayload && taskPayload.prompt) || t.title, messages: taskPayload && taskPayload.messages, timeoutMs }),
        new Promise((_,rej)=>{ const tm=setTimeout(()=>{ timedOut=true; rej(new Error('TIMEOUT')); }, timeoutMs); })
      ]);
    } catch(e){
      execError = e;
      timedOut = timedOut || (e && e.message === 'TIMEOUT');
    }
    const latency = Date.now()-started;

    // reconcile
    if(execError || (result && !result.ok)){
      const errMsg = execError ? String(execError.message) : (result && result.error) || 'unknown';
      if(timedOut){
        // ambiguous outcome
        if(SM.canTransitionTask(t.state,'outcome_unknown')){ SM.assertTaskTransition(t.state,'outcome_unknown'); t.state='outcome_unknown'; }
        t.lastError = { message: errMsg, class:'timeout', at: StoreMod.now() };
        // conservative: reconcile with estimate (cost may have incurred)
        ledger.reconcile(resv.reservationId, estCost, 'ambiguous');
        this._event(m,'task.outcome_unknown',taskId,null,{reason:errMsg});
        release();
        this._persistMission(m);
        return { ok:false, error:'TIMEOUT', outcomeUnknown: true };
      }
      // failure
      const retryable = !!(result && result.timeout) || /timeout|network|5\d\d/i.test(errMsg);
      if(retryable && t.attempts < t.maxAttempts){
        if(SM.canTransitionTask(t.state,'retry_wait')){ SM.assertTaskTransition(t.state,'retry_wait'); t.state='retry_wait'; }
      } else {
        if(SM.canTransitionTask(t.state,'failed')){ SM.assertTaskTransition(t.state,'failed'); t.state='failed'; }
      }
      t.lastError = { message: errMsg, class: retryable?'retryable':'non_retryable', at: StoreMod.now() };
      // release reservation (no cost if failed before completion; but if provider charged, reconcile with estimate)
      ledger.release(resv.reservationId, 'failed');
      this._event(m,'task.failed',taskId,null,{error:errMsg, retryable});
      release();
      // mission failure propagation
      const hasPending = m.tasks.some(x=>['pending','ready','running','retry_wait','waiting_approval','outcome_unknown'].includes(x.state));
      if(!hasPending && m.tasks.some(x=>x.state==='failed')){
        try { this._transitionMission(m,'failed','task_failed'); } catch(e){}
      }
      this._persistMission(m);
      return { ok:false, error: errMsg, retryable };
    }

    // success
    // cancellation check after execution
    if(m.state === 'cancelled' || t.state === 'cancelled'){
      release();
      ledger.reconcile(resv.reservationId, estCost, 'cancelled_ambiguous');
      if(SM.canTransitionTask(t.state,'outcome_unknown')){ SM.assertTaskTransition(t.state,'outcome_unknown'); t.state='outcome_unknown'; }
      t.lastError = { message:'cancelled during execution', class:'ambiguous', at: StoreMod.now() };
      this._event(m,'task.outcome_unknown',taskId,null,{reason:'cancelled'});
      this._persistMission(m);
      return { ok:false, error:'CANCELLED', outcomeUnknown:true };
    }

    const actualCost = adapter.estimateCost(result.usage||{});
    ledger.reconcile(resv.reservationId, actualCost, 'reconciled');
    if(SM.canTransitionTask(t.state,'succeeded')){ SM.assertTaskTransition(t.state,'succeeded'); t.state='succeeded'; }
    t.result = { text: result.text, usage: result.usage, provider: result.provider, model: result.model, latencyMs: result.latencyMs, workspace };
    t.idempotencyKey = t.idempotencyKey || ('idem-'+m.id+'-'+t.id+'-'+t.attempts);
    t.completedAt = StoreMod.now(); t.updatedAt = StoreMod.now(); t.lastError=null;
    // artifact handoff: store workspace path in task result (already)
    this._event(m,'task.succeeded',taskId,null,{provider:result.provider, model:result.model, cost: actualCost});
    this._refreshTaskReadiness(m);
    this._checkMissionCompletion(m);
    release();
    this._persistMission(m);
    return { ok:true, result: t.result, cost: actualCost, reservationId: resv.reservationId };
  }

  async executeNext(missionId, adapterConfigs, apiKey, opts){
    opts = opts || {};
    const concurrency = Number.isFinite(opts.concurrency) ? opts.concurrency : 1;
    const summary = { started:0, succeeded:0, failed:0, skipped:0, results:[] };
    let progress = true;
    while(progress){
      progress = false;
      const m = this.getMission(missionId);
      if(!m || !['running','recovering'].includes(m.state)) break;
      const ready = m.tasks.filter(t => (t.state==='ready') ).slice(0, concurrency);
      if(ready.length === 0) break;
      // run ready tasks (bounded by concurrency)
      const batch = ready.slice(0, concurrency);
      const runs = batch.map(t => this.executeTask(missionId, t.id, adapterConfigs, (opts.taskPayloads && opts.taskPayloads[t.id]) || { prompt: t.title }, apiKey));
      const res = await Promise.all(runs);
      for(const r of res){ summary.started++; if(r && r.ok) summary.succeeded++; else summary.failed++; summary.results.push(r); }
      progress = true;
    }
    return summary;
  }

  _public(m){
    // return a copy (don't leak internal store reference)
    return JSON.parse(JSON.stringify(m));
  }
}

module.exports = { MissionRuntime };
