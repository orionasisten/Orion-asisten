'use strict';
/**
 * Server statis + proxy same-origin untuk Orion Web App (dipakai E2E).
 * Pola yang sama dengan yang direkomendasikan untuk produksi (Cloudflare Pages Functions).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json', '.json':'application/json'
};

function createStaticProxy({ webRoot, apiPort }){
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/v1')){
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers = Object.assign({}, req.headers, { host: '127.0.0.1:' + apiPort, 'content-length': body.length });
        headers.origin = 'http://127.0.0.1:' + apiPort;
        const p = http.request({ hostname:'127.0.0.1', port: apiPort, path: req.url, method: req.method, headers }, r => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        });
        p.on('error', () => { res.writeHead(502); res.end('{}'); });
        if (body.length) p.write(body);
        p.end();
      });
      return;
    }
    let file = path.join(webRoot, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webRoot, 'index.html');
    if (!fs.existsSync(file)){ res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}
module.exports = { createStaticProxy };
