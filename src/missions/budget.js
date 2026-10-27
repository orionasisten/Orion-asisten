'use strict';
// Hard budget policy for mission runtime. Uses integer minor currency units (cents) to avoid float errors.
// All limit checks must be called from trusted runtime code.

const MINOR = 100; // 1 unit = 100 minor units

function toMinor(amount){
  if(typeof amount !== 'number' || !isFinite(amount) || amount < 0) return null;
  // round to 2 decimals safely
  return Math.round(amount * MINOR);
}
function fromMinor(m){ return (m||0)/MINOR; }

class BudgetLedger {
  constructor(mission){
    this.mission = mission;
    mission.budget = mission.budget || { limit: null, spent: 0, reserved: 0, currency: mission.budget && mission.budget.currency || 'unit', ledger: [] };
    if(!Array.isArray(mission.budget.ledger)) mission.budget.ledger = [];
    if(typeof mission.budget.reserved !== 'number') mission.budget.reserved = 0;
    if(typeof mission.budget.spent !== 'number') mission.budget.spent = 0;
  }
  _limitMinor(){ return this.mission.budget.limit == null ? null : toMinor(this.mission.budget.limit); }
  _spentMinor(){ return toMinor(this.mission.budget.spent) || 0; }
  _reservedMinor(){ return toMinor(this.mission.budget.reserved) || 0; }

  // Reserve estimated cost. Returns {ok, reservationId, reason} . Atomic-ish (single-threaded Node).
  reserve(estimate, meta){
    const estMinor = toMinor(estimate);
    if(estMinor === null) return { ok:false, reason:'INVALID_ESTIMATE' };
    const limit = this._limitMinor();
    const current = this._spentMinor() + this._reservedMinor();
    if(limit !== null && current + estMinor > limit){
      return { ok:false, reason:'BUDGET_EXCEEDED', remaining: fromMinor(limit-current) };
    }
    const rid = 'res-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
    const rec = { id: rid, estimate: estMinor, actual: null, status: 'reserved', meta: meta||{}, createdAt: new Date().toISOString(), reconciledAt: null };
    this.mission.budget.reserved = fromMinor(this._reservedMinor() + estMinor);
    this.mission.budget.ledger.push(rec);
    return { ok:true, reservationId: rid, estimatedMinor: estMinor };
  }

  reconcile(reservationId, actual, status){
    const rec = this.mission.budget.ledger.find(r=>r.id===reservationId);
    if(!rec) return { ok:false, reason:'RESERVATION_NOT_FOUND' };
    if(rec.status === 'reconciled') return { ok:true, reason:'ALREADY_RECONCILED' }; // idempotent
    const actualMinor = (actual == null) ? rec.estimate : toMinor(actual);
    if(actualMinor === null) return { ok:false, reason:'INVALID_ACTUAL' };
    const reservedMinor = rec.estimate;
    // adjust reserved down by reserved, spent up by actual
    this.mission.budget.reserved = fromMinor(Math.max(0, this._reservedMinor() - reservedMinor));
    this.mission.budget.spent = fromMinor(this._spentMinor() + actualMinor);
    rec.actual = actualMinor;
    rec.status = status || 'reconciled';
    rec.reconciledAt = new Date().toISOString();
    return { ok:true, reservationId, actualMinor };
  }

  release(reservationId, reason){
    const rec = this.mission.budget.ledger.find(r=>r.id===reservationId);
    if(!rec) return { ok:false, reason:'RESERVATION_NOT_FOUND' };
    if(rec.status === 'reconciled') return { ok:true, reason:'ALREADY_RECONCILED' };
    this.mission.budget.reserved = fromMinor(Math.max(0, this._reservedMinor() - rec.estimate));
    rec.status = 'released';
    rec.releasedAt = new Date().toISOString();
    rec.releaseReason = reason||'released';
    return { ok:true, reservationId };
  }

  summary(){
    return {
      limit: this.mission.budget.limit,
      spent: this.mission.budget.spent,
      reserved: this.mission.budget.reserved,
      remaining: this.mission.budget.limit == null ? null : Math.max(0, this.mission.budget.limit - this.mission.budget.spent - this.mission.budget.reserved),
      currency: this.mission.budget.currency
    };
  }
}

// Unknown pricing policy: 'block' | 'require_approval' | 'conservative'
function unknownCostPolicy(policy){ return ['block','require_approval','conservative'].includes(policy) ? policy : 'block'; }

module.exports = { BudgetLedger, toMinor, fromMinor, unknownCostPolicy, MINOR };
