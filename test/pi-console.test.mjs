import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { attachConsole } from '../pi-adapter/console.mjs';

test('terminal attaches through HTTP to same owner; no second PI runtime', async () => {
 const input = new PassThrough(), output = new PassThrough();
 let text = '', received, events;
 output.on('data', chunk => { text += chunk; });
 const done = new Promise(resolve => { received = resolve; });
 const server = http.createServer(async (req, res) => {
  if (req.url === '/api/pi/events') { events = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET') return res.end(JSON.stringify({ messages: [{ role: 'assistant', text: 'prior history' }], dialogs: [{ id: 'permission', method: 'confirm', title: 'Allow operation?' }] }));
  let body = ''; for await (const chunk of req) body += chunk;
  received({ route: req.url, body: JSON.parse(body) }); res.end('{}');
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const controller = new AbortController();
 const attached = attachConsole({ origin: `http://127.0.0.1:${server.address().port}`, sessionId: 'rpc-session', input, output, signal: controller.signal });
 try {
  // Send only once initial history/connection announcement has arrived.
  await new Promise(resolve => { if (text.includes('Attached')) resolve(); else output.on('data', () => { if (text.includes('Attached')) resolve(); }); });
  input.write('/answer permission no\n');
  const result = await done;
  assert.equal(result.route, '/api/pi/sessions/rpc-session/dialog');
  assert.deepEqual(result.body, { id: 'permission', answer: { confirmed: false } });
  assert.match(text, /prior history/);
  input.end(); await attached;
 } finally { controller.abort(); events?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
