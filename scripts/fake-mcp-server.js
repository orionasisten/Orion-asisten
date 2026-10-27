'use strict';
/* Server MCP minimal untuk pengujian (stdio, JSON-RPC newline-delimited). */
const rl = require('readline').createInterface({ input: process.stdin });
const send = o => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'echo', description: 'Gema teks', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'boom', description: 'Selalu error', inputSchema: { type: 'object', properties: {} } },
    { name: 'envvar', description: 'Baca env FAKE_VAR', inputSchema: { type: 'object', properties: {} } },
    { name: 'structured', description: 'Hanya structuredContent', inputSchema: { type: 'object', properties: {} } }] } });
  if (m.method === 'tools/call') {
    if (m.params.name === 'echo') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + m.params.arguments.text }] } });
    if (m.params.name === 'envvar') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'FAKE_VAR=' + (process.env.FAKE_VAR || '') }] } });
    if (m.params.name === 'structured') return send({ jsonrpc: '2.0', id: m.id, result: { structuredContent: { ok: true, n: 3 } } });
    return send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'meledak' }] } });
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
});
