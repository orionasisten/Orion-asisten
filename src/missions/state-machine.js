'use strict';
// Pure mission/task state machine. No I/O, no Electron. Safe to unit-test in Node.

const MISSION_STATES = ['queued','planning','running','waiting_approval','paused','recovering','completed','failed','cancelled'];
const TASK_STATES = ['pending','ready','running','waiting_approval','succeeded','failed','retry_wait','cancelled','outcome_unknown'];

const MISSION_TRANSITIONS = {
  queued: ['planning','cancelled'],
  planning: ['running','failed','cancelled'],
  running: ['waiting_approval','paused','completed','failed','cancelled','recovering'],
  waiting_approval: ['running','failed','cancelled'],
  paused: ['running','cancelled'],
  recovering: ['running','failed','cancelled'],
  completed: [],
  failed: ['queued'], // retry whole mission
  cancelled: []
};

const TASK_TRANSITIONS = {
  pending: ['ready','cancelled'],
  ready: ['running','cancelled'],
  running: ['waiting_approval','succeeded','failed','retry_wait','cancelled','outcome_unknown'],
  waiting_approval: ['running','cancelled','failed'],
  retry_wait: ['ready','cancelled'],
  outcome_unknown: ['running','failed','cancelled'],
  succeeded: [],
  failed: ['retry_wait','cancelled'],
  cancelled: []
};

function isMissionState(s){ return MISSION_STATES.includes(s); }
function isTaskState(s){ return TASK_STATES.includes(s); }

function canTransitionMission(from, to){ return Array.isArray(MISSION_TRANSITIONS[from]) && MISSION_TRANSITIONS[from].includes(to); }
function canTransitionTask(from, to){ return Array.isArray(TASK_TRANSITIONS[from]) && TASK_TRANSITIONS[from].includes(to); }

function assertMissionTransition(from, to){
  if(!isMissionState(from)) throw new Error('INVALID_MISSION_STATE: '+from);
  if(!isMissionState(to)) throw new Error('INVALID_MISSION_STATE: '+to);
  if(!canTransitionMission(from,to)) throw new Error('ILLEGAL_MISSION_TRANSITION: '+from+' -> '+to);
}
function assertTaskTransition(from, to){
  if(!isTaskState(from)) throw new Error('INVALID_TASK_STATE: '+from);
  if(!isTaskState(to)) throw new Error('INVALID_TASK_STATE: '+to);
  if(!canTransitionTask(from,to)) throw new Error('ILLEGAL_TASK_TRANSITION: '+from+' -> '+to);
}

// Dependency helpers (pure)
function detectCycle(tasks){
  // tasks: [{id, deps:[]}]
  const adj = new Map(tasks.map(t=>[t.id, (t.deps||[]).slice()]));
  const color = new Map(); // 0=unvisited,1=visiting,2=done
  for(const t of tasks){ color.set(t.id,0); }
  function dfs(u){
    color.set(u,1);
    for(const v of (adj.get(u)||[])){
      if(!color.has(v)) continue;
      if(color.get(v)===1) return true;
      if(color.get(v)===0 && dfs(v)) return true;
    }
    color.set(u,2);
    return false;
  }
  for(const t of tasks){ if(color.get(t.id)===0 && dfs(t.id)) return true; }
  return false;
}

function readyTasks(tasks){
  // tasks with all deps succeeded and state pending/ready
  const byId = new Map(tasks.map(t=>[t.id,t]));
  return tasks.filter(t => (t.state==='pending' || t.state==='ready') &&
    (t.deps||[]).every(d => byId.get(d) && byId.get(d).state==='succeeded'));
}

module.exports = {
  MISSION_STATES, TASK_STATES, MISSION_TRANSITIONS, TASK_TRANSITIONS,
  isMissionState, isTaskState, canTransitionMission, canTransitionTask,
  assertMissionTransition, assertTaskTransition, detectCycle, readyTasks
};
