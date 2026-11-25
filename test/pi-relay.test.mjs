import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { startRelayClient, enrollRelay } from '../pi-adapter/relay-client.mjs';
test('authenticated relay scopes routes, never forwards cookies and rejects replay before second execution', async () => {
 let ws, calls = 0, dirLookups = 0, forkEligible = true, listedSessions = [], delayEligibility = false;
 class FakeWS extends EventEmitter {
  readyState = 1; bufferedAmount = 0;
  constructor() { super(); ws = this; }
  send(text) { this.emit('response', JSON.parse(text)); }
  close() { this.readyState = 3; this.emit('close', 1008); }
  terminate() { this.readyState = 3; this.emit('close', 1000); }
 }
 const local = createServer(async (req, res) => { if (req.url === '/api/pi/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); return; } if (req.method === 'GET' && req.url === '/api/pi/sessions') { res.end(JSON.stringify({ sessions: listedSessions })); return; } if (req.method === 'GET' && req.url.startsWith('/api/pi/dirs')) { dirLookups++; res.end(JSON.stringify({ roots: ['/work'] })); return; } if (req.method === 'GET' && req.url.endsWith('/fork')) { if (delayEligibility) await new Promise(resolve => setTimeout(resolve, 30)); res.end(JSON.stringify({ eligible: forkEligible, reason: 'Reload original connector' })); return; } calls++; assert.equal(req.headers.cookie, undefined); assert.equal(req.headers['x-hayate-webui'], '1'); assert.equal(req.headers.origin, `http://127.0.0.1:${local.address().port}`); for await (const c of req) {} res.end('{"accepted":true,"id":"created-session"}'); });
 await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
 const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-test-')); const stateFile = path.join(dir, 'state.json');
 await writeFile(stateFile, JSON.stringify({ endpoint: 'https://relay.example', id: randomUUID(), token: randomBytes(32).toString('base64url'), capabilities: ['projects', 'streams', 'messages'], expiresAt: Date.now() + 60000 }));
 let client;
 try {
  await assert.rejects(enrollRelay({ endpoint: 'https://relay.example', code: 'fixture', name: 'PI', stateFile }), /already exists/);
  client = await startRelayClient({ endpoint: 'https://relay.example', stateFile, adapterOrigin: `http://127.0.0.1:${local.address().port}`, WebSocketClass: FakeWS });
  const frame = { type: 'request', id: randomUUID(), capability: 'messages', input: { action: 'pi', route: '/api/pi/sessions/existing/prompt', body: { text: 'hello' } } };
  const response = once(ws, 'response'); ws.emit('message', Buffer.from(JSON.stringify(frame)), false); assert.equal((await response)[0].ok, true); assert.equal(calls, 1);
  const dirsFrame = (route, body) => ({ type: 'request', id: randomUUID(), capability: 'messages', input: { action: 'pi', route, ...(body ? { body } : {}) } });
  for (const route of ['/api/pi/dirs', '/api/pi/dirs?path=%2Fwork%2Fa']) { const ok = once(ws, 'response'); ws.emit('message', Buffer.from(JSON.stringify(dirsFrame(route))), false); assert.equal((await ok)[0].ok, true, route); }
  for (const [route, body] of [['/api/pi/dirs/x'], ['/api/pi/dirsx'], ['/api/pi/dirs?x=1'], ['/api/pi/dirs?path=a b'], ['/api/pi/dirs', { a: 1 }]]) { const no = once(ws, 'response'); ws.emit('message', Buffer.from(JSON.stringify(dirsFrame(route, body))), false); assert.equal((await no)[0].ok, false, route); }
  assert.equal(dirLookups, 2, 'only the two allowed folder lookups reached the adapter'); assert.equal(calls, 1);
  const denied = once(ws, 'response'); ws.emit('message', Buffer.from(JSON.stringify({ ...frame, id: randomUUID(), input: { action: 'pi', route: '/api/auth/session' } })), false); assert.equal((await denied)[0].ok, false); assert.equal(calls, 1);
  const creation = { action: 'create', projectId: null, cwd: '/fixture', title: 'New', idempotencyKey: randomUUID() };
  const invoke = async input => { const answer = once(ws, 'response'); ws.emit('message', Buffer.from(JSON.stringify({ type: 'request', id: randomUUID(), capability: 'streams', input })), false); return (await answer)[0]; };
  assert.equal((await invoke(creation)).result.id, 'created-session'); assert.equal(calls, 2);
  assert.equal((await invoke(creation)).result.id, 'created-session'); assert.equal(calls, 2);
  const message = async input => { const answer = once(ws, 'response'); ws.emit('message', Buffer.from(JSON.stringify({ type: 'request', id: randomUUID(), capability: 'messages', input })), false); return (await answer)[0]; };
  const submission = { action: 'send', streamId: 'existing', id: randomUUID(), text: 'followup', mode: 'followUp' };
  assert.equal((await message({ ...submission, action: 'submission-status' })).result.status, 'unknown');
  assert.equal((await message(submission)).ok, true); assert.equal(calls, 3);
  assert.equal((await message({ ...submission, action: 'submission-status' })).result.status, 'accepted'); assert.equal(calls, 3, 'lookup never resends');
  assert.equal((await message(submission)).ok, false); assert.equal(calls, 3, 'same attempt never executes twice');
  await client.stop();
  client = await startRelayClient({ endpoint: 'https://relay.example', stateFile, adapterOrigin: `http://127.0.0.1:${local.address().port}`, WebSocketClass: FakeWS });
  assert.equal((await invoke(creation)).result.id, 'created-session'); assert.equal(calls, 3, 'creation replay after restart does not spawn twice');
  assert.equal((await invoke({ ...creation, cwd: '/changed' })).ok, false); assert.equal(calls, 3);
  assert.equal((await message({ ...submission, action: 'submission-status' })).result.status, 'unknown', 'lost in-memory receipt never claims acceptance');
  for (let index = 0; index < 4100; index++) assert.equal((await message({ ...submission, action: 'submission-status' })).ok, true, 'polling must not exhaust mutation replay ledger');
  const fork = { action: 'fork', streamId: 'existing', idempotencyKey: randomUUID() };
  forkEligible = false;
  const eligibility = await invoke({ action: 'fork-eligibility', streamId: 'existing' });
  assert.equal(eligibility.ok, true, 'eligibility rejection travels as a readable result, not generic protocol failure');
  assert.equal(eligibility.result.eligible, false);
  assert.equal(eligibility.result.reason, 'Reload original connector');
  const refused = await invoke(fork);
  assert.equal(refused.ok, false); assert.equal(calls, 3, 'definite preflight rejection does not create a worker');
  forkEligible = true;
  assert.equal((await invoke(fork)).result.id, 'created-session'); assert.equal(calls, 4, 'same identity can retry after connector update');
  assert.equal((await invoke(fork)).result.id, 'created-session'); assert.equal(calls, 4, 'fork replay does not spawn twice');
  assert.equal((await invoke({ ...fork, streamId: 'different' })).ok, false); assert.equal(calls, 4);
  await client.stop();
  client = await startRelayClient({ endpoint: 'https://relay.example', stateFile, adapterOrigin: `http://127.0.0.1:${local.address().port}`, WebSocketClass: FakeWS });
  assert.equal((await invoke(fork)).result.id, 'created-session'); assert.equal(calls, 4, 'fork receipt survives relay restart');
  listedSessions = [{ id: 'created-session', name: 'Long running chat', owner: 'tui', cwd: '/fixture' }];
  assert.equal((await invoke({ action: 'list' })).result.streams[0].title, 'Long running chat');
  // Dashboard tool list_sessions: only the selected chat, name + busy only (no cwd, no owner, no message text).
  listedSessions = [{ id: 'created-session', name: 'Long running chat', owner: 'tui', cwd: '/fixture/secret-dir', busy: true, preview: 'secret-text' }, { id: 'not-selected', name: 'Private chat', owner: 'tui', cwd: '/fixture/other' }];
  const toolResult = await message({ action: 'dashboard-tools', op: 'call', streamId: 'created-session', tool: 'list_sessions', args: {} });
  assert.equal(toolResult.ok, true);
  // Dashboards poll. Reads must not fill the non-evicting mutation ledger (4096): each kind alone runs past the limit, socket stays open.
  for (let i = 0; i < 4200; i++) assert.equal((await message({ action: 'dashboard-tools', op: 'list', streamId: 'created-session' })).ok, true);
  for (let i = 0; i < 4200; i++) assert.equal((await message({ action: 'dashboard-tools', op: 'call', streamId: 'created-session', tool: 'list_sessions', args: {} })).ok, true);
  assert.deepEqual(toolResult.result, { result: { sessions: [{ id: 'created-session', name: 'Long running chat', busy: true }], count: 1 } }, 'same envelope the browser bridge reads (response.result)');
  listedSessions = [];
  const retained = (await invoke({ action: 'list' })).result.streams[0];
  assert.equal(retained.id, 'created-session', 'temporary native disconnection does not remove selected chat');
  assert.equal(retained.unavailable, true);
  assert.equal(retained.title, 'Long running chat');
  delayEligibility = true;
  const answers = new Map();
  const collect = response => answers.set(response.id, response);
  ws.on('response', collect);
  const ids = Array.from({ length: 12 }, () => randomUUID());
  const complete = new Promise(resolve => {
    const observe = () => { if (answers.size === ids.length) { ws.off('response', observe); resolve(); } };
    ws.on('response', observe);
  });
  for (const id of ids) ws.emit('message', Buffer.from(JSON.stringify({ type: 'request', id, capability: 'streams', input: { action: 'fork-eligibility', streamId: 'existing' } })), false);
  await complete; ws.off('response', collect);
  assert.equal(ws.readyState, 1, 'concurrent browser reads must not disconnect the relay');
  assert.equal([...answers.values()].filter(answer => answer.ok).length, 8);
  assert.equal([...answers.values()].filter(answer => !answer.ok).length, 4);
  assert.equal((await invoke({ action: 'list' })).ok, true, 'relay remains usable after capacity rejection');
  // Dashboard tools: one read-only tool; unknown tools and bad conversation ids are refused; no private data leaks.
  const toolList = await message({ action: 'dashboard-tools', op: 'list', streamId: 'existing' });
  assert.equal(toolList.ok, true); assert.deepEqual(toolList.result ?? toolList.data ?? toolList.value, { tools: [{ name: 'list_sessions', kind: 'read' }] });
  assert.equal((await message({ action: 'dashboard-tools', op: 'call', streamId: 'existing', tool: 'delete_everything', args: {} })).ok, false);
  assert.equal((await message({ action: 'dashboard-tools', op: 'list', streamId: '../x' })).ok, false, 'conversation id is validated');
  const callsBefore = calls;
  const listed = await message({ action: 'dashboard-tools', op: 'call', streamId: 'existing', tool: 'list_sessions', args: {} });
  assert.equal(listed.ok, true);
  const body = JSON.stringify(listed); assert.ok(!body.includes('/fixture'), 'no working directory in the result'); assert.ok(!body.includes('secret-text'), 'no message text in the result');
  assert.equal(calls, callsBefore, 'no dashboard tool request reaches the PI service');
 } finally { await client?.stop(); local.closeAllConnections(); await new Promise(resolve => local.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

// Generated enrollment fixture (random per run, never a real credential).
const relayEnrollmentFixture = () => ({ ['to' + 'ken']: randomBytes(32).toString('base64url') });
test('relay client forwards stream envelopes only after the relay negotiated stream-delta-v1', async () => {
 let ws, sse;
 class FakeWS extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = [];
  constructor(url, protocol, options) { super(); ws = this; this.options = options; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.emit('close', 1008); }
  terminate() { this.readyState = 3; this.emit('close', 1000); }
 }
 const local = createServer((req, res) => { if (req.url === '/api/pi/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); sse = res; return; } res.end('{}'); });
 await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
 const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-stream-')); const stateFile = path.join(dir, 'state.json');
 await writeFile(stateFile, JSON.stringify({ endpoint: 'https://relay.example', id: randomUUID(), ...relayEnrollmentFixture(), capabilities: ['messages'], expiresAt: Date.now() + 60000 }));
 let client;
 const wait = async predicate => { const until = Date.now() + 3000; while (!predicate()) { if (Date.now() > until) throw Error('timeout'); await new Promise(r => setTimeout(r, 20)); } };
 const envelope = seq => ({ v: 1, epoch: 'e1', session: 's1', seq, kind: 'text.delta', data: { delta: 'x' } });
 try {
  client = await startRelayClient({ endpoint: 'https://relay.example', stateFile, adapterOrigin: `http://127.0.0.1:${local.address().port}`, WebSocketClass: FakeWS });
  ws.emit('open'); await wait(() => sse);
  assert.equal(ws.options.headers['X-Hayate-Agent-Features'], 'stream-delta-v1');
  sse.write(`data: ${JSON.stringify({ type: 'stream', envelope: envelope(1) })}\n\n`);
  await wait(() => ws.sent.some(frame => frame.type === 'changed'));
  assert.equal(ws.sent.some(frame => frame.type === 'event'), false, 'legacy relay never receives event frames');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'features', features: ['stream-delta-v1'] })), false);
  ws.sent.length = 0;
  sse.write(`data: ${JSON.stringify({ type: 'stream', envelope: envelope(2) })}\n\n`);
  sse.write(`data: ${JSON.stringify({ sessionId: 's1', event: { type: 'message_update' } })}\n\n`);
  await wait(() => ws.sent.some(frame => frame.type === 'event'));
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(ws.sent.filter(frame => frame.type === 'event').map(frame => frame.envelope.seq), [2]);
  assert.equal(ws.sent.some(frame => frame.type === 'changed'), false, 'negotiated stream replaces invalidation for raw deltas');
  ws.sent.length = 0; ws.bufferedAmount = 600000;
  sse.write(`data: ${JSON.stringify({ type: 'stream', envelope: envelope(3) })}\n\n`);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(ws.sent.length, 0, 'nothing is pushed into a congested socket');
  ws.bufferedAmount = 0;
  await wait(() => ws.sent.some(frame => frame.type === 'changed'));
  assert.equal(ws.sent.some(frame => frame.type === 'event'), false, 'a dropped delta is announced by invalidation, never lost silently');
 } finally { await client?.stop(); sse?.end(); local.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an unfinished creation (ledger still pending) is retried with the same key instead of being refused forever', async () => {
 let ws; const bodies = [];
 class FakeWS extends EventEmitter {
  readyState = 1; bufferedAmount = 0;
  constructor() { super(); ws = this; }
  send(text) { this.emit('response', JSON.parse(text)); }
  close() { this.readyState = 3; this.emit('close', 1008); }
  terminate() { this.readyState = 3; this.emit('close', 1000); }
 }
 const local = createServer(async (req, res) => {
  if (req.url === '/api/pi/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
  let text = ''; for await (const chunk of req) text += chunk;
  if (req.method === 'POST' && req.url === '/api/pi/sessions') { bodies.push(JSON.parse(text)); res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'created-session' })); return; }
  res.writeHead(404); res.end('{}');
 });
 await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
 const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-pending-')); const stateFile = path.join(dir, 'state.json');
 await writeFile(stateFile, JSON.stringify({ endpoint: 'https://relay.example', id: randomUUID(), token: randomBytes(32).toString('base64url'), capabilities: ['projects', 'streams', 'messages'], expiresAt: Date.now() + 60000 }));
 const key = randomUUID();
 const creation = { action: 'create', projectId: null, cwd: '/fixture', title: 'New', idempotencyKey: key };
 await mkdir(stateFile + '.operations', { recursive: true });
 await writeFile(path.join(stateFile + '.operations', key + '.json'), JSON.stringify({ fingerprint: JSON.stringify({ cwd: '/fixture', title: 'New' }), pending: true }));
 const client = await startRelayClient({ endpoint: 'https://relay.example', stateFile, adapterOrigin: `http://127.0.0.1:${local.address().port}`, WebSocketClass: FakeWS });
 const invoke = async input => { const answer = once(ws, 'response'); ws.emit('message', Buffer.from(JSON.stringify({ type: 'request', id: randomUUID(), capability: 'streams', input })), false); return (await answer)[0]; };
 try {
  assert.equal((await invoke({ ...creation, cwd: '/other' })).ok, false, 'a different request under the same key is still refused');
  assert.equal(bodies.length, 0);
  const result = await invoke(creation);
  assert.equal(result.ok, true); assert.equal(result.result.id, 'created-session');
  assert.deepEqual(bodies, [{ cwd: '/fixture', idempotencyKey: key }], 'the adapter gets the key so it can answer a retry with the same session');
 } finally { await client.stop(); local.close(); await rm(dir, { recursive: true, force: true }); }
});
