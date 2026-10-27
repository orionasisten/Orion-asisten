'use strict';
const RegistryMod = require('./registry');
const StoreMod = require('./store');
const { validateMemoryRecord, STATUSES, VERIFICATION, ORIGINS } = require('./registry');

function now(){ return new Date().toISOString(); }

// Access-scope compatibility: callerScope vs record.scope.
// Returns true if caller may read the record (record must not be deleted).
function canAccess(record, callerScope){
  if(!record) return false;
  if(record.status === 'deleted') return false;
  if(callerScope === 'global') return true;
  if(callerScope === 'skill') return record.sensitivity !== 'private';
  if(callerScope === record.scope) return true;
  // a 'session' caller may not enter another mission's private memory
  if(record.scope === 'mission' && callerScope === 'session') return false;
  return false;
}

class MemoryService {
  constructor(store, opts){
    opts = opts || {};
    this.store = store;
    this.owner = opts.owner || 'user';
    // audit log of memory mutations (references only, no content leakage)
    this.audit = opts.audit || [];
  }

  // ---- CREATE ----
  create(rec, callerScope){
    rec = rec || {};
    // never trust renderer-supplied owner/trust status; owner forced to service owner
    const r = {
      id: rec.id || ('mem-'+Date.now()+'-'+Math.random().toString(36).slice(2,8)),
      schemaVersion: RegistryMod.SCHEMA,
      type: rec.type || 'fact',
      content: rec.content || '',
      origin: rec.origin, // REQUIRED; renderer must declare origin
      sourceRef: rec.sourceRef || '',
      excerpt: rec.excerpt || String(rec.content||'').slice(0,200),
      created: rec.created || now(),
      updated: now(),
      confidence: Number.isFinite(rec.confidence) ? rec.confidence : 0.5,
      verificationStatus: 'unverified', // renderer cannot forge trust status
      owner: this.owner, // IGNORE rec.owner — renderer cannot forge ownership
      scope: rec.scope || 'global',
      missionId: rec.missionId || null,
      sensitivity: rec.sensitivity || 'internal',
      status: 'active',
      version: 1,
      expiry: rec.expiry || null
    };
    const v = RegistryMod.validateMemoryRecord(r);
    if(!v.ok) throw new Error('MEMORY_INVALID: '+v.errors.join(','));
    // agent inference is never promoted to verified fact
    if(r.origin === 'agent') r.verificationStatus = 'inferred';
    // redact secrets before persisting
    r.content = RegistryMod.redactSecrets(r.content||'');
    r.excerpt = RegistryMod.redactSecrets(r.excerpt||String(r.content||'').slice(0,200));
    r.integrityHash = RegistryMod.hashContent(JSON.stringify({type:r.type,content:r.content,origin:r.origin,sourceRef:r.sourceRef||'',created:r.created}));
    const all = this.store.loadAll();
    // prevent duplicate id
    if(all.find(x=>x.id===r.id)) throw new Error('MEMORY_DUPLICATE_ID');
    all.unshift(r);
    this.store.saveAll(all);
    this._audit('memory.create', r.id, {origin:r.origin, type:r.type, scope:r.scope});
    return { ...r }; // copy
  }

  // ---- GET with access control ----
  get(id, callerScope){
    const r = this.store.get(id);
    if(!r) return null;
    if(!canAccess(r, callerScope)) return null;
    // never expose deleted/superseded content details beyond status; return redacted copy
    return this._public(r);
  }

  // ---- LIST with filters + access control ----
  list({scope, type, status, missionId, callerScope}={}){
    return this.store.loadAll()
      .filter(r => {
        if(!canAccess(r, callerScope)) return false;
        if(status && r.status!==status) return false;
        if(type && r.type!==type) return false;
        if(scope && r.scope!==scope) return false;
        if(missionId && r.missionId!==missionId) return false;
        return true;
      })
      .map(r => this._public(r));
  }

  // ---- SEARCH with provenance in results ----
  search(query, filters={}){
    const q = String(query||'').toLowerCase();
    const results = this.store.loadAll()
      .filter(r => {
        if(!canAccess(r, filters.callerScope)) return false;
        if(filters.status && r.status!==filters.status) return false;
        if(filters.type && r.type!==filters.type) return false;
        if(filters.missionId && r.missionId!==filters.missionId) return false;
        if(!q) return true;
        const hay = (r.content+' '+r.excerpt+' '+(r.sourceRef||'')).toLowerCase();
        return hay.includes(q);
      })
      .map(r => ({...this._public(r), relevance: 1}));
    if(results.length === 0 && q){
      return { results: [], insufficientEvidence: true, reason: 'No accessible memory matches the query.' };
    }
    return { results, insufficientEvidence: false };
  }

  // ---- UPDATE (mutable fields only; provenance fields immutable) ----
  update(id, patch, callerScope){
    const all = this.store.loadAll();
    const r = all.find(x=>x.id===id);
    if(!r) throw new Error('MEMORY_NOT_FOUND');
    if(!canAccess(r, callerScope)) throw new Error('MEMORY_ACCESS_DENIED');
    const next = Object.assign({}, r, patch||{}, { updated: now(), version: r.version+1 });
    next.id = r.id; next.created = r.created; next.origin = r.origin; next.owner = r.owner;
    next.content = RegistryMod.redactSecrets(next.content||'');
    next.excerpt = RegistryMod.redactSecrets(next.excerpt||String(next.content||'').slice(0,200));
    const v = RegistryMod.validateMemoryRecord(next);
    if(!v.ok) throw new Error('MEMORY_INVALID: '+v.errors.join(','));
    next.integrityHash = RegistryMod.hashContent(JSON.stringify({type:next.type,content:next.content,origin:next.origin,sourceRef:next.sourceRef||'',created:next.created}));
    const i = all.findIndex(x=>x.id===id); all[i]=next; this.store.saveAll(all);
    this._audit('memory.update', id, {version:next.version});
    return this._public(next);
  }

  // ---- SUPERSEDE (mark old, keep audit history) ----
  supersede(id, reason, callerScope){
    const r = this.store.get(id); if(!r) throw new Error('MEMORY_NOT_FOUND');
    if(!canAccess(r, callerScope)) throw new Error('MEMORY_ACCESS_DENIED');
    const next = Object.assign({}, r, { status:'superseded', supersededReason: String(reason||''), updated: now(), version: r.version+1 });
    next.integrityHash = RegistryMod.hashContent(JSON.stringify({type:next.type,content:next.content,origin:next.origin,sourceRef:next.sourceRef||'',created:next.created}));
    const all = this.store.loadAll(); const i = all.findIndex(x=>x.id===id); all[i]=next; this.store.saveAll(all);
    this._audit('memory.supersede', id, {reason});
    return this._public(next);
  }

  // ---- SOFT DELETE ----
  delete(id, callerScope){
    const r = this.store.get(id); if(!r) throw new Error('MEMORY_NOT_FOUND');
    if(!canAccess(r, callerScope)) throw new Error('MEMORY_ACCESS_DENIED');
    return this.update(id, { status:'deleted', deletedAt: now() }, callerScope);
  }

  // ---- conflict detection: same scope + similar content but different source ----
  detectConflict(rec, callerScope){
    const all = this.store.loadAll();
    const needle = String(rec.content||'').toLowerCase();
    const conflicts = all.filter(r => {
      if(!canAccess(r, callerScope)) return false;
      if(r.status !== 'active') return false;
      if(r.id === rec.id) return false;
      const hay = String(r.content||'').toLowerCase();
      return hay.includes(needle) || needle.includes(hay);
    });
    return conflicts.map(c=>this._public(c));
  }

  _public(r){
    // return a copy without leaking internal audit references
    return JSON.parse(JSON.stringify(r));
  }
  _audit(kind, id, meta){
    this.audit.push({ kind, id, at: now(), ...meta });
    if(this.audit.length>500) this.audit=this.audit.slice(-500);
  }
}

module.exports = { MemoryService, canAccess, STATUSES, VERIFICATION, ORIGINS };
