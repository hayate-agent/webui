import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiService, projectEntries } from '../pi-adapter/service.mjs';

test('projection preserves tool calls and correlated tool results', () => {
 const entries = [
  { id: 'call', parentId: null, type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'README.md' } }] } },
  { id: 'result', parentId: 'call', type: 'message', message: { role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', content: [{ type: 'text', text: 'file content' }] } },
 ];
 const messages = projectEntries(entries, 'result');
 assert.deepEqual(messages[0].toolCalls, [{ id: 'tool-1', name: 'read', arguments: { path: 'README.md' } }]);
 assert.equal(messages[1].toolCallId, 'tool-1'); assert.equal(messages[1].toolName, 'read');
});

test('projection follows active parent chain, not abandoned branch', () => {
 const entries = [
  { id: 'u', parentId: null, type: 'message', message: { role: 'user', content: 'question' } },
  { id: 'abandoned', parentId: 'u', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'wrong branch' }] } },
  { id: 'active', parentId: 'u', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'right branch' }] } },
 ];
 assert.deepEqual(projectEntries(entries, 'active').map(message => message.text), ['question', 'right branch']);
});

test('service refuses hostile origin and outside cwd; creates native worker through injected runtime', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-service-'));
 let spawned = 0;
 class Fake extends EventEmitter {
  id = 'new-session'; cwd = directory;
  async ready() { spawned++; return { sessionId: this.id }; }
  async snapshot() { return { entries: [], leafId: null, busy: false, sessionFile: path.join(directory, 'session.jsonl') }; }
  async command(type, data) { if (type === 'get_state') return { sessionFile: path.join(directory, 'session.jsonl'), isStreaming: false, pendingMessageCount: 0 }; return { type, data }; }
  async close() { this.emit('exit'); }
 }
 let forkOptions;
 const service = await createPiService({ directory, roots: [directory], makeRpc: options => { const fake = new Fake(); if (options.forkFrom) { forkOptions = options; fake.id = 'fork-session'; } return fake; } });
 const origin = `http://127.0.0.1:${service.server.address().port}`;
 const post = (route, body, override = {}) => fetch(origin + route, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1', ...override }, body: JSON.stringify(body) });
 try {
  assert.equal((await fetch(origin + '/api/pi/sessions', { headers: { origin: 'http://evil.test' } })).status, 403);
  assert.equal((await post('/api/pi/sessions', { cwd: directory }, { origin: 'http://evil.test' })).status, 403);
  assert.equal((await post('/api/pi/sessions', { cwd: os.tmpdir() })).status, 403);
  assert.equal(spawned, 0);
  assert.equal((await post('/api/pi/sessions', { cwd: directory })).status, 201);
  assert.equal(spawned, 1);
  const sessions = await (await fetch(origin + '/api/pi/sessions')).json();
  assert.equal(sessions.sessions[0].id, 'new-session');
  assert.equal((await post('/api/pi/sessions/new-session/prompt', { text: '/new' })).status, 400);
  assert.equal((await post('/api/pi/sessions/new-session/prompt', { text: 'hello', mode: 'steer' })).status, 200);
  assert.equal((await post('/api/pi/sessions/new-session/release', {})).status, 409);
  await writeFile(path.join(directory, 'session.jsonl'), '{"type":"session"}\n');
  const renamed = await post('/api/pi/sessions/new-session/rename', { name: 'Named browser session' });
  assert.equal(renamed.status, 200);
  const roster = await (await fetch(origin + '/api/pi/sessions')).json();
  assert.equal(roster.sessions.find(session => session.id === 'new-session').name, 'Named browser session');
  const forked = await post('/api/pi/sessions/new-session/fork', {});
  assert.equal(forked.status, 201); assert.equal((await forked.json()).id, 'fork-session');
  assert.equal(forkOptions.forkFrom, path.join(directory, 'session.jsonl'));
  assert.ok((await (await fetch(origin + '/api/pi/sessions')).json()).sessions.some(session => session.id === 'new-session'), 'fork preserves original owner');
  const released = await post('/api/pi/sessions/new-session/release', {});
  assert.equal(released.status, 200);
  assert.deepEqual((await released.json()).args, ['--session', path.join(directory, 'session.jsonl')]);
  assert.deepEqual((await (await fetch(origin + '/api/pi/sessions')).json()).sessions.map(session => session.id), ['fork-session']);
 } finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});
