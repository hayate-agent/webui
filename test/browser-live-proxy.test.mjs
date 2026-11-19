import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createDashboard } from '../server/server.mjs';
test('browser websocket proxy binds origin cookie and protocol, pushes events and refuses foreign origin', async () => {
 const backend = createServer((req, res) => { res.setHeader('ETag', '"revision-one"'); res.writeHead(req.headers['if-none-match'] === '"revision-one"' ? 304 : 200); res.end(); });
 const wss = new WebSocketServer({ noServer: true, handleProtocols: p => p.has('hayate.workspace.v1') ? 'hayate.workspace.v1' : false });
 let accepted = 0;
 backend.on('upgrade', (req, socket, head) => {
  assert.equal(req.headers.cookie, 'session=fixture');
  assert.equal(req.headers.origin, `http://127.0.0.1:${backend.address().port}`);
  wss.handleUpgrade(req, socket, head, ws => { accepted++; ws.send(JSON.stringify({ type: 'changed', revision: 'one' })); });
 });
 await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
 const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
 const origin = `http://127.0.0.1:${port}`;
 const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
 let ws;
 try {
  ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/workspace/live', 'hayate.workspace.v1', { origin, headers: { Cookie: 'session=fixture' } });
  const [message] = await once(ws, 'message'); assert.deepEqual(JSON.parse(message), { type: 'changed', revision: 'one' });
  const response = await fetch(origin + '/api/workspace/revision', { method: 'HEAD', headers: { 'If-None-Match': '"revision-one"' } });
  assert.equal(response.status, 304); assert.equal(response.headers.get('etag'), '"revision-one"');
  const bad = new WebSocket(origin.replace('http:', 'ws:') + '/api/workspace/live', 'hayate.workspace.v1', { origin: 'https://foreign.example' });
  await new Promise(resolve => { bad.on('error', resolve); bad.on('open', () => { assert.fail('foreign origin accepted'); }); });
  assert.equal(accepted, 1);
 } finally { ws?.terminate(); await dashboard.stop(); for (const c of wss.clients) c.terminate(); wss.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
});
