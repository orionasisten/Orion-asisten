'use strict';
/* Minta potret renderer app asli via DevTools protocol (remote debugging).
 * Pemakaian: node scripts/devtools-probe.js "<command electron+args>" — app sudah jalan dengan --remote-debugging-port=9222 */
const http = require('http');

function jsonList() {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9222/json/list', r => {
      let b = '';
      r.on('data', d => (b += d));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
(async () => {
  const list = await jsonList();
  const page = list.find(t => t.type === 'page') || list[0];
  if (!page) { console.log('TIDAK ADA TARGET'); process.exit(2); }
  console.log('TARGET ' + page.url.slice(0, 120));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = e => bad(new Error('ws gagal')); });
  const jq = expr => new Promise(res => {
    const id = Math.floor(Math.random() * 1e6);
    const f = ev => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', f); res(m.result && m.result.result ? m.result.result.value : null); }
    };
    ws.addEventListener('message', f);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  const d = await jq('(function(){var boot=document.querySelector("#boot");' +
    'return JSON.stringify({bootStill:!!boot,bootText:boot?(boot.textContent||"").slice(0,150):null,' +
    'lastErr:(window.__orionLastError||null),' +
    'halo:(document.querySelector("#hero-state")||{}).textContent,' +
    'views:[].slice.call(document.querySelectorAll(".view"),0,4).map(function(s){return s.id+(s.hidden?"(h)":"(v)");}),' +
    'zoom:(function(){try{return parseFloat(getComputedStyle(document.body).zoom||"1");}catch(e){return -1;}})(),' +
    'bodyLen:document.body.innerHTML.length});})()');
  console.log('DOM ' + d);
  process.exit(0);
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
