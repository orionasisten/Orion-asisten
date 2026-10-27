'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// SHA-256 of a skill version's content (manifest + body). Immutable once registered.
function contentHash(manifest, body){
  return crypto.createHash('sha256')
    .update(JSON.stringify({manifest, body: body||''}))
    .digest('hex');
}

function now(){ return new Date().toISOString(); }

const LIFECYCLE = ['registered','evaluated','active','deprecated','quarantined','rolled-back'];

function validateManifest(m){
  const errors = [];
  if(!m || typeof m !== 'object') { errors.push('MANIFEST_MISSING'); return {ok:false, errors}; }
  if(typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(m.id)) errors.push('ID_INVALID');
  if(typeof m.name !== 'string' || !m.name.trim()) errors.push('NAME_REQUIRED');
  if(typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) errors.push('VERSION_INVALID');
  if(typeof m.description !== 'string') errors.push('DESCRIPTION_REQUIRED');
  if(!Array.isArray(m.permissions)) errors.push('PERMISSIONS_INVALID');
  if(!Array.isArray(m.capabilities)) errors.push('CAPABILITIES_INVALID');
  if(m.schemaVersion !== 1) errors.push('SCHEMA_VERSION_INVALID');
  return { ok: errors.length===0, errors };
}

// Prevent path traversal and unexpected file references in manifests
function manifestHasUnsafePaths(m){
  const text = JSON.stringify(m||{});
  const bad = /(\.\.\\|\.\/|\\\\|~\/|file:|ftp:|http:|https:|\$\(|\${|`)/;
  return bad.test(text);
}

class SkillRegistry {
  constructor(store, opts){
    opts = opts || {};
    this.store = store;
    this.audit = opts.audit || [];
    // activeVersion: skillId -> versionId (persisted so restart keeps pointer valid)
    this.activeVersion = (store && store.loadActive) ? store.loadActive() : (opts.activeVersion || {});
  }

  _load(){ return this.store.loadAll(); }
  _save(recs){ this.store.saveAll(recs); }

  // ---- REGISTER version (immutable) ----
  registerVersion(manifest, body, opts){
    opts = opts || {};
    const m = Object.assign({}, manifest||{});
    // strip dangerous keys renderer shouldn't set
    m.owner = opts.owner || 'user';
    const v = validateManifest(m);
    if(!v.ok) throw new Error('SKILL_MANIFEST_INVALID: '+v.errors.join(','));
    if(manifestHasUnsafePaths(m)) throw new Error('SKILL_MANIFEST_UNSAFE_PATHS');

    const hash = contentHash(m, body);
    const versionId = 'ver-'+hash.slice(0,16);
    const all = this._load();
    // same versionId must have same content hash (immutable)
    const existing = all.find(v2 => v2.versionId === versionId);
    if(existing && existing.contentHash !== hash) throw new Error('SKILL_VERSION_CONFLICT');
    if(existing) return this._public(existing);

    // duplicate skillId + version must not differ
    const sameSkill = all.find(v2 => v2.skillId === m.id && v2.version === m.version);
    if(sameSkill && sameSkill.contentHash !== hash) throw new Error('SKILL_VERSION_CONFLICT_DUPLICATE_CONTENT');

    const rec = {
      skillId: m.id,
      version: m.version,
      versionId,
      contentHash: hash,
      manifest: m,
      body: body || '',
      state: 'registered',
      created: now(),
      createdBy: opts.owner || 'user',
      evaluation: null, // {ok, reportId, at}
      lifecycle: [{ at: now(), state: 'registered', by: opts.owner || 'user', reason: 'registered' }],
      deprecated: false,
      quarantined: false
    };
    all.push(rec);
    this._save(all);
    this._audit('skill.register', rec.versionId, {skillId: m.id, version: m.version});
    return this._public(rec);
  }

  // ---- GET ----
  get(versionId){
    const r = this._load().find(v=>v.versionId===versionId);
    return r ? this._public(r) : null;
  }
  list({skillId, state}={}){
    return this._load().filter(r=>{
      if(skillId && r.skillId!==skillId) return false;
      if(state && r.state!==state) return false;
      return true;
    }).map(r=>this._public(r));
  }

  // ---- EVALUATE ----
  evaluate(versionId, evaluatorOpts){
    evaluatorOpts = evaluatorOpts || {};
    const all = this._load();
    const idx = all.findIndex(v=>v.versionId===versionId);
    if(idx<0) throw new Error('SKILL_VERSION_NOT_FOUND');
    const r = all[idx];

    // Simulate deterministic offline evaluation
    const report = {
      evaluatorVersion: '1.0.0',
      testSuiteVersion: '1.0.0',
      at: now(),
      skillVersion: r.version,
      contentHash: r.contentHash,
      result: 'pass',
      failures: [],
      limitations: ['No external model calls; offline static evaluation only.'],
      checks: []
    };

    // Manifest/schema validation
    const mv = validateManifest(r.manifest);
    report.checks.push({name:'manifest-schema', ok: mv.ok, detail: mv.errors.join(', ')});
    if(!mv.ok){ report.result='fail'; report.failures.push('manifest-invalid'); }

    // Permission policy check against connector policy (if available)
    const policyChecker = evaluatorOpts.policyChecker;
    const perms = Array.isArray(r.manifest.permissions) ? r.manifest.permissions : [];
    // Built-in forbidden permissions (skill may never broaden its own authority)
    const FORBIDDEN = ['system:admin','secret:read-all','filesystem:unrestricted','policy:override','approval:bypass'];
    perms.forEach(p=>{
      if(FORBIDDEN.includes(p)){
        report.checks.push({name:'permission:'+p, ok:false, detail:'forbidden permission'});
        report.result='fail'; report.failures.push('permission-forbidden:'+p);
        return;
      }
      if(policyChecker){
        const decision = policyChecker({resource: 'skill:'+r.skillId, action: 'use', permission: p});
        report.checks.push({name:'permission:'+p, ok: decision.effect!=='deny', detail: decision.reason||''});
        if(decision.effect === 'deny'){ report.result='fail'; report.failures.push('permission-denied:'+p); }
      } else {
        report.checks.push({name:'permission:'+p, ok:true, detail:'declared (no external policy checker supplied)'});
      }
    });

    // Dependency availability (offline check: declared adapters exist?)
    const deps = Array.isArray(r.manifest.requiredAdapters) ? r.manifest.requiredAdapters : [];
    deps.forEach(d=>{
      report.checks.push({name:'dependency:'+d, ok:true, detail:'declared (offline check only)'});
    });

    // Secret leakage in body/manifest
    const secretPattern = /(sk-[A-Za-z0-9_-]{10,}|AIza[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,})/;
    if(secretPattern.test(r.body) || secretPattern.test(JSON.stringify(r.manifest))){
      report.result='fail'; report.failures.push('secret-leakage');
      report.checks.push({name:'secret-leakage', ok:false, detail:'secret detected in skill body/manifest'});
    } else {
      report.checks.push({name:'secret-leakage', ok:true, detail:'no secrets detected'});
    }

    // Malformed/adversarial input resilience (body length sanity)
    if((r.body||'').length > 64*1024){ report.result='fail'; report.failures.push('body-too-large'); }

    const reportId = 'eval-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
    r.evaluation = { ok: report.result==='pass', reportId, at: now() };
    r.lifecycle.push({ at: now(), state: report.result==='pass' ? 'evaluated' : 'evaluated', by: evaluatorOpts.owner||'user', reason: 'evaluated: '+report.result });
    all[idx]=r;
    this._save(all);
    this._audit('skill.evaluate', versionId, {skillId: r.skillId, version: r.version, result: report.result, reportId});
    return { reportId, report, version: this._public(r) };
  }

  // ---- ACTIVATE ----
  activate(versionId, opts){
    opts = opts || {};
    const all = this._load();
    const idx = all.findIndex(v=>v.versionId===versionId);
    if(idx<0) throw new Error('SKILL_VERSION_NOT_FOUND');
    const r = all[idx];
    if(r.quarantined) throw new Error('SKILL_QUARANTINED');
    if(!r.evaluation || !r.evaluation.ok) throw new Error('SKILL_NOT_EVALUATED');
    if(r.evaluation && r.evaluation.at) {
      // evaluation not stale (no expiry here; treat as current)
    }
    // verify content hash still matches (immutability)
    if(r.contentHash !== contentHash(r.manifest, r.body)) throw new Error('SKILL_HASH_MISMATCH');
    // policy compatibility (manifest permissions must not include forbidden)
    const forbidden = ['system:admin','secret:read-all','filesystem:unrestricted'];
    const perms = Array.isArray(r.manifest.permissions) ? r.manifest.permissions : [];
    const bad = perms.filter(p=>forbidden.includes(p));
    if(bad.length>0) throw new Error('SKILL_FORBIDDEN_PERMISSIONS: '+bad.join(','));

    // atomic update active-version pointer
    const prev = this.activeVersion[r.skillId];
    this.activeVersion[r.skillId] = versionId;
    r.lifecycle.push({ at: now(), state: 'active', by: opts.owner||'user', reason: 'activated', previous: prev });
    all[idx]=r;
    this._save(all);
    if(this.store.saveActive) this.store.saveActive(this.activeVersion);
    this._audit('skill.activate', versionId, {skillId: r.skillId, version: r.version, previous: prev});
    return { versionId, previous: prev, version: this._public(r) };
  }

  // ---- DEACTIVATE / QUARANTINE ----
  deactivate(versionId, opts){
    opts = opts || {};
    const all = this._load();
    const idx = all.findIndex(v=>v.versionId===versionId);
    if(idx<0) throw new Error('SKILL_VERSION_NOT_FOUND');
    const r = all[idx];
    if(this.activeVersion[r.skillId] === versionId) this.activeVersion[r.skillId] = null;
    r.state = 'deprecated';
    r.lifecycle.push({ at: now(), state: 'deprecated', by: opts.owner||'user', reason: 'deactivated' });
    all[idx]=r; this._save(all);
    if(this.store.saveActive) this.store.saveActive(this.activeVersion);
    this._audit('skill.deactivate', versionId, {skillId: r.skillId, version: r.version});
    return this._public(r);
  }
  quarantine(versionId, reason, opts){
    opts = opts || {};
    const all = this._load();
    const idx = all.findIndex(v=>v.versionId===versionId);
    if(idx<0) throw new Error('SKILL_VERSION_NOT_FOUND');
    const r = all[idx];
    if(this.activeVersion[r.skillId] === versionId) this.activeVersion[r.skillId] = null;
    r.state = 'quarantined'; r.quarantined = true; r.quarantineReason = String(reason||'');
    r.lifecycle.push({ at: now(), state: 'quarantined', by: opts.owner||'user', reason });
    all[idx]=r; this._save(all);
    if(this.store.saveActive) this.store.saveActive(this.activeVersion);
    this._audit('skill.quarantine', versionId, {skillId: r.skillId, reason});
    return this._public(r);
  }

  // ---- ROLLBACK ----
  rollback(versionId, opts){
    opts = opts || {};
    const all = this._load();
    const targetIdx = all.findIndex(v=>v.versionId===versionId);
    if(targetIdx<0) throw new Error('SKILL_VERSION_NOT_FOUND');
    const target = all[targetIdx];
    if(target.quarantined) throw new Error('SKILL_QUARANTINED');
    if(!target.evaluation || !target.evaluation.ok) throw new Error('SKILL_TARGET_NOT_EVALUATED');
    if(target.contentHash !== contentHash(target.manifest, target.body)) throw new Error('SKILL_HASH_MISMATCH');

    const skillId = target.skillId;
    const prev = this.activeVersion[skillId];
    // rollback: point active-version to target (does not mutate either version's content)
    this.activeVersion[skillId] = versionId;
    target.lifecycle.push({ at: now(), state: 'rolled-back', by: opts.owner||'user', reason: 'rolled-back', previous: prev });
    all[targetIdx]=target; this._save(all);
    if(this.store.saveActive) this.store.saveActive(this.activeVersion);
    this._audit('skill.rollback', versionId, {skillId, version: target.version, previous: prev});
    return { versionId, previous: prev, version: this._public(target) };
  }

  getActive(skillId){
    const vid = this.activeVersion[skillId];
    if(!vid) return null;
    return this.get(vid);
  }

  _public(r){
    return JSON.parse(JSON.stringify(r));
  }
  _audit(kind, id, meta){
    this.audit.push({ kind, id, at: now(), ...meta });
    if(this.audit.length>500) this.audit=this.audit.slice(-500);
  }
}

module.exports = { SkillRegistry, contentHash, validateManifest, manifestHasUnsafePaths, LIFECYCLE };
