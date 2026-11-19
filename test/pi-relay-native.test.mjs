import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { startRelayClient } from '../pi-adapter/relay-client.mjs';
const plugins = process.env.PI_WEBUI_PLUGINS_ROOT;
test('actual AgentRelay pairs, approves, forwards PI requests and revokes connection', { skip: !plugins, timeout: 20000 }, async () => {
 const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-real-relay-'));
 let relay, client, server, adapter;
 try {
  for (const name of ['agent-link', 'shared']) await cp(path.join(plugins, name), path.join(temp, name), { recursive: true });
  await mkdir(path.join(temp, 'agent-link/vendor'), { recursive: true });
  await writeFile(path.join(temp, 'agent-link/vendor/websocket.mjs'), `export { WebSocket, WebSocketServer } from ${JSON.stringify(pathToFileURL(path.resolve('node_modules/ws/wrapper.mjs')).href)};`);
  const { AgentRelay } = await import(pathToFileURL(path.join(temp, 'agent-link/websocket-relay.mjs')).href);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(temp, 'key'), '-out', path.join(temp, 'cert'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  const tls = { key: await readFile(path.join(temp, 'key')), cert: await readFile(path.join(temp, 'cert')) };
  server = createServer(tls);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `https://127.0.0.1:${server.address().port}`;
  relay = new AgentRelay({ home: temp, origin: endpoint, heartbeatMs: 100 }); await relay.open({ listen: false });
  server.on('request', (req, res) => relay.handleRequest(req, res)); server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  const invitation = await relay.invite('operator', { name: 'PI test host' });
  const enrollment = await new Promise((resolve, reject) => {
   import('node:https').then(({ request }) => {
    const req = request(endpoint + '/api/agent-link/v1/enroll', { method: 'POST', rejectUnauthorized: false, headers: { 'content-type': 'application/json' } }, res => { let text = ''; res.on('data', c => text += c); res.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }); });
    req.on('error', reject); req.end(JSON.stringify({ code: invitation.code, agent: 'Local PI', capabilities: ['projects', 'messages'] }));
   });
  });
  assert.equal(enrollment.protocol, 1);
  let paired;
  await relay.accept('operator', enrollment.id, { connect: async (owner, input) => { paired = await relay.adapter.pair({ ...input, owner }); return {}; } });
  let calls = 0;
  let events;
  adapter = httpServer(async (req, res) => {
   if (req.url === '/api/pi/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); events = res; return; }
   calls++; for await (const c of req) {} res.end('{"disposition":"started"}');
  });
  await new Promise(resolve => adapter.listen(0, '127.0.0.1', resolve));
  const stateFile = path.join(temp, 'enrollment.json'); await writeFile(stateFile, JSON.stringify(enrollment));
  class TestSocket extends WebSocket { constructor(url, protocol, options) { super(url, protocol, { ...options, rejectUnauthorized: false }); } }
  client = await startRelayClient({ endpoint, stateFile, adapterOrigin: `http://127.0.0.1:${adapter.address().port}`, WebSocketClass: TestSocket });
  // Wait for the concrete relay connection, with a bounded event-driven timeout.
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => { clearInterval(poll); reject(Error('Relay did not connect')); }, 3000); const poll = setInterval(() => { if (relay.list('operator')[0].connected) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 10); });
  const query = { endpoint: endpoint + '/agents/' + enrollment.id, token: paired.token };
  assert.deepEqual(await relay.request({ ...query, capability: 'projects', input: { action: 'list' } }), { projects: [], features: ['pi-live-v1'] });
  assert.equal((await relay.request({ ...query, capability: 'messages', input: { action: 'pi', route: '/api/pi/sessions/existing/prompt', body: { text: 'Live' } } })).disposition, 'started'); assert.equal(calls, 1);
  await assert.rejects(relay.request({ ...query, capability: 'messages', input: { action: 'pi', route: '/api/credentials' } })); assert.equal(calls, 1);
  // Streaming: the actual relay negotiates stream-delta-v1 and fans the
  // envelope out to the owner's browser listeners without any HTTP read.
  const pushed = []; const unsubscribe = relay.subscribe('operator', event => { if (event.type === 'event') pushed.push(event); });
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => { clearInterval(poll); reject(Error('No SSE stream')); }, 3000); const poll = setInterval(() => { if (events) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 10); });
  const envelope = { v: 1, epoch: 'epoch-1', session: 'existing', seq: 1, kind: 'text.delta', data: { delta: 'Live' } };
  await new Promise(resolve => setTimeout(resolve, 100));
  events.write(`data: ${JSON.stringify({ type: 'stream', envelope })}\n\n`);
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => { clearInterval(poll); reject(Error('Envelope not relayed')); }, 3000); const poll = setInterval(() => { if (pushed.length) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 10); });
  assert.deepEqual(pushed[0], { type: 'event', relayAgent: enrollment.id, envelope });
  assert.equal(calls, 1, 'streamed deltas cause no adapter read');
  // Over the 200/s budget: dropped events are followed by an invalidation that
  // comes AFTER the last dropped one (trailing), so clients always repair.
  const changes = []; const stopChanges = relay.subscribe('operator', event => { if (event.type !== 'event') changes.push(Date.now()); });
  for (let seq = 2; seq <= 260; seq++) events.write(`data: ${JSON.stringify({ type: 'stream', envelope: { ...envelope, seq } })}\n\n`);
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => { clearInterval(poll); reject(Error('Burst not relayed')); }, 3000); const poll = setInterval(() => { if (pushed.length >= 200) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 10); });
  const lastDropped = Date.now();
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.ok(pushed.length < 260, 'over-budget deltas are dropped');
  assert.ok(changes.some(at => at >= lastDropped), 'an invalidation follows the last dropped event');
  stopChanges(); pushed.length = 1;
  // The adapter SSE subscription drops while the relay socket stays up: the
  // resubscription invalidates, because events in the gap were never seen.
  const resyncs = []; const stopResync = relay.subscribe('operator', event => { if (event.type !== 'event') resyncs.push(event); });
  const previous = events; previous.destroy(); events = undefined;
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => { clearInterval(poll); reject(Error('No resubscription')); }, 5000); const poll = setInterval(() => { if (events && events !== previous) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 10); });
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => { clearInterval(poll); reject(Error('No invalidation after resubscription')); }, 3000); const poll = setInterval(() => { if (resyncs.length) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 10); });
  stopResync();
  // Events need the same grant as a `messages` request: once that scope is
  // withdrawn from the stored agent record, nothing is forwarded.
  await relay.store.change(data => { const agent = data.agents.find(value => value.id === enrollment.id); agent.capabilities = agent.capabilities.filter(value => value !== 'messages'); });
  events.write(`data: ${JSON.stringify({ type: 'stream', envelope: { ...envelope, seq: 2 } })}\n\n`);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(pushed.length, 1, 'no event forwarded without the messages scope');
  unsubscribe();
  await relay.reject('operator', enrollment.id);
  await assert.rejects(relay.request({ ...query, capability: 'messages', input: { action: 'pi', route: '/api/pi/sessions' } }));
 } finally {
  await client?.stop(); await relay?.stop(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } if (adapter) { adapter.closeAllConnections(); await new Promise(resolve => adapter.close(resolve)); } await rm(temp, { recursive: true, force: true });
 }
});
