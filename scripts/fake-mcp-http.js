'use strict';
/* Server MCP "Streamable HTTP" palsu untuk pengujian: token Bearer, session id, balasan JSON dan SSE. */
const http = require('http');
const TOKEN = 'sekret', SESSION = 'sess-1';

function start() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401).end('unauthorized'); return; }
      if (req.method === 'DELETE') { server.deleted = true; res.writeHead(200).end(); return; }
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const m = JSON.parse(raw);
        const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (m.method === 'initialize') {
          res.setHeader('Mcp-Session-Id', SESSION);
          return json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '1' } } });
        }
        if (req.headers['mcp-session-id'] !== SESSION) { res.writeHead(400).end('session missing'); return; }
        if (m.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
        if (m.method === 'tools/list') return json({ jsonrpc: '2.0', id: m.id, result: { tools: [
          { name: 'echo', description: 'Gema', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'ping2', description: 'Tes', inputSchema: { type: 'object', properties: {} } }] } });
        if (m.method === 'tools/call') { // dibalas lewat SSE, didahului sebuah notifikasi
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } }) + '\n\n');
          res.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + (m.params.arguments.text || '') }] } }) + '\n\n');
          return;
        }
        json({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
module.exports = { start };
