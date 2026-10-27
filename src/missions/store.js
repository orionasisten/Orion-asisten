'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Atomic JSON store for durable mission runtime. Directory must be provided (userData/missions).
// Stores one file missions.json (array of mission objects with embedded tasks).
// Append-only events stored in events.jsonl? We'll store events array inside mission for simplicity,
// but also a global events.jsonl for audit. Keep minimal: events inside mission.

function ensureDir(dir){ if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true}); }

function readJson(file, fallback){
  try { if(!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch(e){ return fallback; }
}
function writeJsonAtomic(file, data){
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data,null,2), 'utf8');
  // fsync
  try { const fd=fs.openSync(tmp,'r+'); fs.fsyncSync(fd); fs.closeSync(fd); } catch(e){}
  fs.renameSync(tmp, file);
}

class MissionStore {
  constructor(dir){ this.dir = dir; ensureDir(dir); this.file = path.join(dir,'missions.json'); }
  loadAll(){ const d = readJson(this.file, {v:1, missions:[]}); return Array.isArray(d.missions)? d.missions : []; }
  saveAll(missions){ writeJsonAtomic(this.file, {v:1, savedAt:new Date().toISOString(), missions}); }
  get(id){ return this.loadAll().find(m=>m.id===id) || null; }
  upsert(mission){
    const all = this.loadAll();
    const i = all.findIndex(m=>m.id===mission.id);
    if(i>=0) all[i]=mission; else all.unshift(mission);
    this.saveAll(all);
    return mission;
  }
  remove(id){
    const all = this.loadAll().filter(m=>m.id!==id);
    this.saveAll(all);
  }
}

function id(){ return 'ms-' + crypto.randomBytes(6).toString('hex'); }
function taskId(){ return 'tk-' + crypto.randomBytes(4).toString('hex'); }
function now(){ return new Date().toISOString(); }
function fingerprint(action, resource, params, scope){
  const payload = JSON.stringify({action,resource,scope,params: params||{}}); // keys sorted not required for minimal
  return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = { MissionStore, id, taskId, now, fingerprint, ensureDir, readJson, writeJsonAtomic };
