'use strict';
/**
 * Router HTTP minimal (node:http) untuk Orion Central — berversi, default-deny.
 * Route: 'METHOD /path' → handler(ctx) → { status, body }.
 * Handler TIDAK boleh melempar stack trace ke klien: error disanitasi di sini.
 */
const { PolicyError } = require('../policy/scope');

class Router {
  constructor(){
    this.routes = new Map(); // method+path -> handler
  }
  add(method, pattern, handler, opts){
    this.routes.set(method.toUpperCase() + ' ' + pattern, { handler, pattern, opts: opts || {} });
    return this;
  }
  get(p, h, o){ return this.add('GET', p, h, o); }
  post(p, h, o){ return this.add('POST', p, h, o); }
  put(p, h, o){ return this.add('PUT', p, h, o); }
  patch(p, h, o){ return this.add('PATCH', p, h, o); }
  delete(p, h, o){ return this.add('DELETE', p, h, o); }

  match(method, pathname){
    const key = method.toUpperCase() + ' ' + pathname;
    if (this.routes.has(key)) return { route: this.routes.get(key), params: {} };
    // parameterized: /v1/missions/:id
    const parts = pathname.split('/').filter(Boolean);
    for (const [k, route] of this.routes){
      const [m, pat] = k.split(' ');
      if (m !== method.toUpperCase()) continue;
      const pparts = pat.split('/').filter(Boolean);
      if (pparts.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < pparts.length; i++){
        if (pparts[i].startsWith(':')) params[pparts[i].slice(1)] = decodeURIComponent(parts[i]);
        else if (pparts[i] !== parts[i]) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

function errorBody(code, message, extra){
  return Object.assign({ error: { code, message: message || code } }, extra || {});
}

module.exports = { Router, errorBody, PolicyError };
