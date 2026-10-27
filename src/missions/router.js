'use strict';
const Ad = require('./adapters');

const TRANSIENT_STATUSES = new Set([408,425,429,500,502,503,504]);
function isTransient(err){
  if(!err) return false;
  if(err.timeout) return true;
  const msg = String(err.error||err.message||err).toLowerCase();
  if(msg.includes('timeout') || msg.includes('econnreset') || msg.includes('enotfound') || msg.includes('network')) return true;
  if(typeof err.status === 'number' && TRANSIENT_STATUSES.has(err.status)) return true;
  return false;
}

// routingClass: 'free' | 'low_cost' | 'high_capability' | 'vision' | 'audio' | 'explicit'
function requiredCapsFor(task){
  const caps = ['text'];
  const t = String(task && task.type || '').toLowerCase();
  if(t.includes('vision') || t.includes('image')) caps.push('vision');
  if(t.includes('audio') || t.includes('transcri')) caps.push('audio_transcription');
  if(task && task.requireTools) caps.push('tool_calling');
  if(task && task.requireJson) caps.push('json_output');
  return caps;
}

function route({ task, adapters, policy, budget, routingClass }){
  policy = policy || {};
  const required = requiredCapsFor(task||{});
  const rc = routingClass || (task && task.routingClass) || 'low_cost';
  // filter by capabilities
  const compatible = (adapters||[]).filter(a => Ad.hasAll(a.capabilities, required).ok);
  if(compatible.length === 0){
    return { ok:false, error:'NO_CAPABLE_ADAPTER', reason:'no adapter supports required capabilities: '+required.join(','), required };
  }
  // data policy: if task sensitive, exclude non-local dataPolicy
  const sensitive = !!(task && task.sensitive);
  const pool = sensitive ? compatible.filter(a => a.dataPolicy === 'local_only') : compatible;
  if(pool.length === 0){
    return { ok:false, error:'DATA_POLICY_VIOLATION', reason:'no adapter satisfies data policy', required };
  }
  // budget filter: adapter pricing estimate? We can't know exact; filter by remaining budget if provided
  let candidates = pool.slice();
  // sort by policy
  if(rc === 'free' || rc === 'low_cost'){
    candidates.sort((a,b) => (a.priority - b.priority) || (a.pricing.inputPer1k + a.pricing.outputPer1k) - (b.pricing.inputPer1k + b.pricing.outputPer1k));
  } else if(rc === 'high_capability'){
    candidates.sort((a,b) => (b.priority - a.priority));
  } else {
    candidates.sort((a,b) => (a.priority - b.priority));
  }
  // budget check: if budget remaining known and conservative reservation would exceed, try cheaper
  const chosen = candidates[0];
  const fallbacks = candidates.slice(1);
  return { ok:true, adapter: chosen, reason: 'selected by '+rc, required, fallbacks, routingClass: rc };
}

function eligibleFallbacks(routeResult, failedAdapter, failedErr){
  if(!routeResult || !routeResult.fallbacks) return [];
  if(!isTransient(failedErr)) return [];
  return routeResult.fallbacks.filter(a => a.name !== (failedAdapter && failedAdapter.name));
}

module.exports = { route, isTransient, requiredCapsFor, eligibleFallbacks, TRANSIENT_STATUSES };
