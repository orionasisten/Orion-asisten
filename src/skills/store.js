'use strict';
// Atomic JSON file store for skill versions. Separate from memory store so the
// two registries never share a file (avoids mixing record types / migration risk).
const fs = require('fs');
const path = require('path');

function ensureDir(dir){ if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true}); }
function readJson(file, fallback){
  try { if(!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch(e){ return fallback; }
}
function writeJsonAtomic(file, data){
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data,null,2), 'utf8');
  try { const fd=fs.openSync(tmp,'r+'); fs.fsyncSync(fd); fs.closeSync(fd); } catch(e){}
  fs.renameSync(tmp, file);
}

class SkillStore {
  constructor(dir){ this.dir = dir; ensureDir(dir); this.file = path.join(dir,'versions.json'); this.metaFile = path.join(dir,'state.json'); }
  loadAll(){ const d = readJson(this.file, {v:1, versions:[]}); return Array.isArray(d.versions)? d.versions : []; }
  saveAll(versions){ writeJsonAtomic(this.file, {v:1, savedAt:new Date().toISOString(), versions}); }
  get(id){ return this.loadAll().find(v=>v.versionId===id) || null; }
  remove(id){ this.saveAll(this.loadAll().filter(v=>v.versionId!==id)); }
  // active-version pointer (skillId -> versionId), persisted separately & atomically
  loadActive(){ const d = readJson(this.metaFile, {v:1, active:{}}); return (d && d.active && typeof d.active==='object') ? d.active : {}; }
  saveActive(active){ writeJsonAtomic(this.metaFile, {v:1, active: active||{}}); }
  // backup for recovery
  backup(destDir){
    ensureDir(destDir);
    const stamp = Date.now();
    const out = [];
    try { fs.copyFileSync(this.file, path.join(destDir, 'versions-'+stamp+'.json')); out.push(path.join(destDir,'versions-'+stamp+'.json')); } catch(e){}
    try { fs.copyFileSync(this.metaFile, path.join(destDir, 'state-'+stamp+'.json')); out.push(path.join(destDir,'state-'+stamp+'.json')); } catch(e){}
    return out;
  }
}

module.exports = { SkillStore, ensureDir, readJson, writeJsonAtomic };
