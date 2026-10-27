'use strict';
const path = require('path');
const fs = require('fs');

class Executor {
  constructor(opts){
    opts = opts || {};
    this.globalLimit = Number.isFinite(opts.globalLimit) ? opts.globalLimit : 2;
    this.perMissionLimit = Number.isFinite(opts.perMissionLimit) ? opts.perMissionLimit : 1;
    this.workspaceRoot = opts.workspaceRoot;
    this.running = new Map(); // missionId -> Set of taskIds
    this.globalRunning = 0;
    this.queue = [];
  }
  _ensureRoot(){ if(!this.workspaceRoot) throw new Error('NO_WORKSPACE_ROOT'); if(!fs.existsSync(this.workspaceRoot)) fs.mkdirSync(this.workspaceRoot,{recursive:true}); }
  // Validate and create a workspace dir for a task. Returns absolute path or throws.
  createWorkspace(missionId, taskId){
    this._ensureRoot();
    const safeId = String(missionId).replace(/[^a-zA-Z0-9_-]/g,'');
    const safeTask = String(taskId).replace(/[^a-zA-Z0-9_-]/g,'');
    if(!safeId || !safeTask) throw new Error('INVALID_ID');
    const dir = path.join(this.workspaceRoot, safeId, safeTask);
    // ensure within root
    const resolved = path.resolve(dir);
    const rootResolved = path.resolve(this.workspaceRoot);
    if(!resolved.startsWith(rootResolved + path.sep)) throw new Error('WORKSPACE_ESCAPE');
    fs.mkdirSync(resolved, {recursive:true});
    return resolved;
  }
  // Validate an artifact path is inside a given workspace root.
  validatePath(workspace, rel){
    if(typeof rel !== 'string' || !rel) throw new Error('INVALID_PATH');
    const root = path.resolve(workspace);
    const full = path.resolve(workspace, rel);
    if(full !== root && !full.startsWith(root + path.sep)) throw new Error('PATH_TRAVERSAL');
    // reject symlink escape
    try {
      const real = fs.realpathSync(full);
      if(real !== full && !real.startsWith(root + path.sep) && real !== root) throw new Error('SYMLINK_ESCAPE');
    } catch(e){ if(e.code !== 'ENOENT') throw e; }
    return full;
  }
  canStart(missionId){
    if(this.globalRunning >= this.globalLimit) return false;
    const set = this.running.get(missionId) || new Set();
    if(set.size >= this.perMissionLimit) return false;
    return true;
  }
  // Acquire slot; returns release function.
  acquire(missionId, taskId){
    if(!this.canStart(missionId)) return null;
    if(!this.running.has(missionId)) this.running.set(missionId, new Set());
    this.running.get(missionId).add(taskId);
    this.globalRunning++;
    let released = false;
    return () => {
      if(released) return;
      released = true;
      const set = this.running.get(missionId);
      if(set) set.delete(taskId);
      this.globalRunning = Math.max(0, this.globalRunning-1);
    };
  }
  cleanupWorkspace(workspace){
    // only delete if inside root
    const root = path.resolve(this.workspaceRoot);
    const ws = path.resolve(workspace);
    if(!ws.startsWith(root + path.sep)) throw new Error('CLEANUP_ESCAPE');
    if(fs.existsSync(ws)) fs.rmSync(ws, {recursive:true, force:true});
  }
  getStats(){ return { globalRunning: this.globalRunning, globalLimit: this.globalLimit, missions: Object.fromEntries([...this.running.entries()].map(([k,v])=>[k,v.size])) }; }
}

module.exports = Executor;
