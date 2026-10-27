'use strict';
// Atomic JSON file store for memory records. Lives under userData/memory so the
// main process can enforce access control (renderer cannot reach it directly).
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

class MemoryStore {
  constructor(dir){ this.dir = dir; ensureDir(dir); this.file = path.join(dir,'records.json'); }
  loadAll(){ const d = readJson(this.file, {v:1, records:[]}); return Array.isArray(d.records)? d.records : []; }
  saveAll(records){ writeJsonAtomic(this.file, {v:1, savedAt:new Date().toISOString(), records}); }
  get(id){ return this.loadAll().find(r=>r.id===id) || null; }
  upsert(record){
    const all = this.loadAll();
    const i = all.findIndex(r=>r.id===record.id);
    if(i>=0) all[i]=record; else all.unshift(record);
    this.saveAll(all);
    return record;
  }
  remove(id){
    const all = this.loadAll().filter(r=>r.id!==id);
    this.saveAll(all);
  }
}

module.exports = { MemoryStore, ensureDir, readJson, writeJsonAtomic };
