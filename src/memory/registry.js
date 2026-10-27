'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 1;
const TYPES = ['fact','user_assertion','verified_fact','agent_inference','preference','project_decision'];
const ORIGINS = ['user','import','tool','agent','external'];
const STATUSES = ['active','superseded','archived','deleted'];
const VERIFICATION = ['unverified','verified','conflicting','inferred'];

function hashContent(content){
  return crypto.createHash('sha256').update(String(content)).digest('hex');
}
function isValidScope(scope){ return ['global','project','mission','session','skill'].includes(scope); }
function isValidSensitivity(s){ return ['public','internal','private'].includes(s); }
function redactSecrets(text){
  // naive secret redaction for persisted evidence
  return String(text||'').replace(/(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]+)/g, '[redacted]');
}
function validateMemoryRecord(rec){
  const errors = [];
  if(!rec) { errors.push('RECORD_MISSING'); return {ok:false, errors}; }
  if(!rec.id) errors.push('ID_MISSING');
  if(rec.schemaVersion !== SCHEMA) errors.push('SCHEMA_VERSION');
  if(!TYPES.includes(rec.type)) errors.push('TYPE_INVALID');
  if(!ORIGINS.includes(rec.origin)) errors.push('ORIGIN_REQUIRED');
  if(!rec.content) errors.push('CONTENT_MISSING');
  if(!isValidScope(rec.scope)) errors.push('SCOPE_INVALID');
  if(!isValidSensitivity(rec.sensitivity)) errors.push('SENSITIVITY_INVALID');
  if(!STATUSES.includes(rec.status)) errors.push('STATUS_INVALID');
  if(!VERIFICATION.includes(rec.verificationStatus)) errors.push('VERIFICATION_INVALID');
  if(!rec.created) errors.push('CREATED_MISSING');
  if(rec.origin === 'import' && !rec.sourceRef) errors.push('SOURCE_REF_REQUIRED_FOR_IMPORT');
  if(!rec.owner) errors.push('OWNER_MISSING');
  if(rec.verificationStatus === 'verified' && rec.origin === 'agent') errors.push('AGENT_CANNOT_SELF_VERIFY');
  return { ok: errors.length===0, errors };
}

class MemoryRegistry {
  constructor(store){ this.store = store; }
  _load(){ const d = this.store.load('memory'); return Array.isArray(d) ? d : []; }
  _save(recs){ this.store.save('memory', recs); }
  list({scope, type, status, missionId}={}){
    return this._load().filter(r=>{
      if(status && r.status!==status) return false;
      if(type && r.type!==type) return false;
      if(scope && r.scope!==scope) return false;
      if(missionId && r.missionId!==missionId) return false;
      return true;
    });
  }
  get(id){ return this._load().find(r=>r.id===id) || null; }
  create(rec){
    const now = new Date().toISOString();
    const r = Object.assign({
      id: 'mem-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),
      schemaVersion: SCHEMA, type:'fact', content:'', origin:'user', sourceRef:'', excerpt:'',
      created: now, updated: now, confidence: 0.5, verificationStatus:'unverified', owner:'user',
      scope:'global', missionId:null, sensitivity:'internal', status:'active', version:1, expiry:null
    }, rec||{});
    r.excerpt = redactSecrets(r.excerpt || String(r.content||'').slice(0,200));
    r.content = redactSecrets(r.content);
    if(!r.sourceRef) delete r.sourceRef;
    const v = validateMemoryRecord(r);
    if(!v.ok) throw new Error('MEMORY_INVALID: '+v.errors.join(','));
    // integrity
    r.integrityHash = hashContent(JSON.stringify({type:r.type,content:r.content,origin:r.origin,sourceRef:r.sourceRef||'',created:r.created}));
    const all = this._load();
    all.unshift(r);
    this._save(all);
    return r;
  }
  update(id, patch){
    const all = this._load(); const r = all.find(x=>x.id===id);
    if(!r) throw new Error('MEMORY_NOT_FOUND');
    const next = Object.assign({}, r, patch||{}, { updated: new Date().toISOString(), version: r.version+1 });
    // immutable provenance fields
    next.id = r.id; next.created = r.created; next.origin = r.origin; next.owner = r.owner;
    next.integrityHash = hashContent(JSON.stringify({type:next.type,content:next.content,origin:next.origin,sourceRef:next.sourceRef||'',created:next.created}));
    const v = validateMemoryRecord(next);
    if(!v.ok) throw new Error('MEMORY_INVALID: '+v.errors.join(','));
    const i = all.findIndex(x=>x.id===id); all[i]=next; this._save(all);
    return next;
  }
  supersede(id, reason, byId){
    const r = this.update(id, { status:'superseded', supersededReason: String(reason||'') });
    if(byId) r.supersededBy = byId;
    return r;
  }
  delete(id){
    const r = this.get(id); if(!r) throw new Error('MEMORY_NOT_FOUND');
    return this.update(id, { status:'deleted', deletedAt: new Date().toISOString() });
  }
  search(query, filters){
    const q = String(query||'').toLowerCase();
    return this.list(filters||{}).filter(r=>{
      if(!q) return true;
      const hay = (r.content+' '+r.excerpt+' '+(r.sourceRef||'')).toLowerCase();
      return hay.includes(q);
    }).map(r=>({...r, relevance: 1}));
  }
  // access control: caller scope must be allowed to see record
  canAccess(record, callerScope){
    if(!record) return false;
    if(record.status === 'deleted') return false;
    if(callerScope === 'global') return true;
    if(callerScope === 'skill') return record.sensitivity !== 'private';
    if(callerScope === record.scope) return true;
    if(record.scope === 'mission' && callerScope === 'session') return false;
    return false;
  }
}

module.exports = { MemoryRegistry, validateMemoryRecord, redactSecrets, hashContent, SCHEMA, TYPES, ORIGINS, STATUSES, VERIFICATION };
