'use strict';
const { URL } = require('url');

const CAPABILITIES = ['text','streaming','tool_calling','json_output','vision','audio_transcription','speech','usage_reporting','cancellation'];

function hasAll(adapterCaps, required){
  const caps = adapterCaps || [];
  const missing = (required||[]).filter(c => !caps.includes(c));
  return { ok: missing.length===0, missing };
}

class AdapterResult {
  constructor(o){ Object.assign(this, o||{}); }
}

class OpenAICompatibleAdapter {
  constructor(cfg){
    cfg = cfg || {};
    this.name = String(cfg.name||'openai-compatible');
    this.base = String(cfg.base||'').replace(/\/+$/,'');
    this.model = String(cfg.model||'');
    this.apiKey = cfg.apiKey || '';
    this.capabilities = Array.isArray(cfg.capabilities) ? cfg.capabilities.slice() : ['text','usage_reporting','cancellation'];
    this.pricing = cfg.pricing || { inputPer1k: 0, outputPer1k: 0, currency: 'unit' };
    this.timeoutMs = Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 60000;
    this.priority = Number.isFinite(cfg.priority) ? cfg.priority : 100;
    this.dataPolicy = cfg.dataPolicy || 'standard'; // standard | local_only
  }
  async execute(req){
    req = req || {};
    const timeoutMs = Number.isFinite(req.timeoutMs) ? req.timeoutMs : this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const url = this.base + '/chat/completions';
      const headers = { 'Content-Type':'application/json' };
      if(this.apiKey) headers['Authorization'] = 'Bearer ' + this.apiKey;
      const body = { model: this.model, messages: req.messages || [{role:'user',content:req.prompt||''}], temperature: req.temperature != null ? req.temperature : 0.7 };
      const res = await fetch(url, { method:'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch(e){}
      if(!res.ok){
        return new AdapterResult({ ok:false, error: 'HTTP '+res.status, status: res.status, provider:this.name, model:this.model, latencyMs: Date.now()-started });
      }
      const content = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
      const usage = (json && json.usage) || {};
      const promptTokens = Number(usage.prompt_tokens||usage.promptTokens||0);
      const completionTokens = Number(usage.completion_tokens||usage.completionTokens||0);
      const totalTokens = Number(usage.total_tokens||usage.totalTokens||(promptTokens+completionTokens));
      return new AdapterResult({ ok:true, text: content, usage: { promptTokens, completionTokens, totalTokens }, provider:this.name, model:this.model, latencyMs: Date.now()-started });
    } catch(e){
      const isTimeout = e && (e.name === 'AbortError');
      return new AdapterResult({ ok:false, error: isTimeout ? 'TIMEOUT' : String((e&&e.message)||e), timeout: isTimeout, provider:this.name, model:this.model, latencyMs: Date.now()-started });
    } finally {
      clearTimeout(timer);
    }
  }
  estimateCost(usage){
    const u = usage || {};
    const inCost = (Number(u.promptTokens||0)/1000) * (this.pricing.inputPer1k||0);
    const outCost = (Number(u.completionTokens||0)/1000) * (this.pricing.outputPer1k||0);
    return inCost + outCost;
  }
}

function checkCapabilities(adapter, required){
  return hasAll(adapter.capabilities, required);
}

module.exports = { CAPABILITIES, hasAll, checkCapabilities, OpenAICompatibleAdapter, AdapterResult };
