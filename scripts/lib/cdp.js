'use strict';
/**
 * Klien DevTools Protocol minimal (CDP) — untuk mengendarai jendela Electron
 * (aplikasi desktop ORION) dari skrip E2E. Tanpa unduhan browser tambahan.
 */
const http = require('http');

function listTargets(port){
  return new Promise((resolve, reject)=>{
    http.get('http://127.0.0.1:'+port+'/json/list', res=>{
      let b='';
      res.on('data', d => b+=d);
      res.on('end', ()=>{ try { resolve(JSON.parse(b)); } catch(e){ reject(e); } });
    }).on('error', reject);
  });
}
async function waitTarget(port, match, timeoutMs){
  const deadline = Date.now() + (timeoutMs || 30000);
  while (Date.now() < deadline){
    try {
      const list = await listTargets(port);
      const hit = list.find(t => t.type === 'page' && (!match || (t.url||'').includes(match)));
      if (hit && hit.webSocketDebuggerUrl) return hit;
    } catch (e) { /* belum siap */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}
function connect(wsUrl){
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)){
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('error', e => reject(new Error('WS error')));
  });
  const send = (method, params) => {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  };
  return {
    ready, send,
    async evaluate(expression, awaitPromise){
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });
      if (r && r.exceptionDetails){
        const d = r.exceptionDetails;
        const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'evaluate error';
        throw new Error(String(desc));
      }
      return r && r.result ? r.result.value : undefined;
    },
    close(){ try { ws.close(); } catch (e) { /* ignore */ } }
  };
}
async function evalUntil(client, expr, timeoutMs, intervalMs){
  const deadline = Date.now() + (timeoutMs || 15000);
  let last;
  while (Date.now() < deadline){
    try { last = await client.evaluate(expr, true); if (last) return last; } catch (e) { last = null; }
    await new Promise(r => setTimeout(r, intervalMs || 250));
  }
  return last;
}
module.exports = { listTargets, waitTarget, connect, evalUntil };
