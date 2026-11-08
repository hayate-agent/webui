import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { createDashboard } from '../server/server.mjs';

async function fixture(t) {
  const seen = [];
  const backend = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/api/auth') { res.setHeader('Content-Type', 'application/json'); res.end('{"required":false,"authenticated":true}'); }
    else if (req.url === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"chats":[]}\n\n'); }
    else { res.setHeader('Content-Type', 'application/json'); res.setHeader('Set-Cookie', '__Host-hayate_operator=fixture; Secure; HttpOnly; SameSite=Strict; Path=/'); res.end('{"ok":true}'); }
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
  t.after(async () => { await dashboard.stop(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); });
  return { origin, dashboard, backend, seen, backendOrigin: `http://127.0.0.1:${backend.address().port}` };
}

test('independent dashboard serves built assets, proxies fixed API and preserves secure cookie custody', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin)).status, 200); assert.equal((await fetch(f.origin + '/app.js')).status, 200);
  assert.equal((await fetch(f.origin + '/package.json')).status, 404);
  const response = await fetch(f.origin + '/api/state'); assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(f.seen[0].headers.host, new URL(f.backendOrigin).host);
  assert.equal(f.seen[0].headers['x-forwarded-user'], undefined);
});

test('cross-origin mutation and rebinding are refused before contacting backend', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + '/api/chats', { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Hayate-WebUI': '1' } })).status, 403);
  assert.equal((await fetch(f.origin + '/api/chats', { method: 'POST', headers: { Origin: f.origin } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = request(f.origin + '/api/state', { headers: { Host: 'evil.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end();
  });
  assert.equal(status, 403); assert.equal(f.seen.length, 0);
});

test('trusted proxy validates browser Origin before rewriting to configured API Origin', async t => {
  const f = await fixture(t);
  const response = await fetch(f.origin + '/api/chats', { method: 'POST', headers: { Origin: f.origin, 'X-Hayate-WebUI': '1', 'Content-Type': 'application/json', 'X-Forwarded-User': 'forged' }, body: '{}' });
  assert.equal(response.status, 200); assert.equal(f.seen[0].headers.origin, f.backendOrigin);
  assert.equal(f.seen[0].headers['x-forwarded-user'], undefined);
});

test('network HTTP dashboard and remote HTTP backend fail closed', async () => {
  await assert.rejects(createDashboard({ origin: 'http://dashboard.example', upstream: 'https://agent.example', host: '0.0.0.0' }), /TLS/);
  await assert.rejects(createDashboard({ origin: 'http://127.0.0.1:3210', upstream: 'http://remote.example' }), /HTTPS/);
});

test('shutdown closes an open SSE proxy rather than leaving unowned sockets', async t => {
  const f = await fixture(t);
  const response = await fetch(f.origin + '/api/events'); const reader = response.body.getReader(); await reader.read();
  await f.dashboard.stop(); await reader.cancel().catch(() => {});
});
