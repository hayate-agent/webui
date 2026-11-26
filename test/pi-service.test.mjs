import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
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

test('a retried creation with the same key returns the same session, even while the first start is still running', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-service-key-'));
 let spawned = 0, release;
 const gate = new Promise(resolve => { release = resolve; });
 class Slow extends EventEmitter {
  constructor() { super(); this.id = `session-${++spawned}`; this.cwd = directory; }
  async ready() { await gate; return { sessionId: this.id }; }
  async close() { this.emit('exit'); }
 }
 const service = await createPiService({ directory, roots: [directory], makeRpc: () => new Slow() });
 const origin = `http://127.0.0.1:${service.server.address().port}`;
 const post = body => fetch(origin + '/api/pi/sessions', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: JSON.stringify(body) });
 const key = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
 try {
  const first = post({ cwd: directory, idempotencyKey: key });
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = post({ cwd: directory, idempotencyKey: key });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(spawned, 1, 'the retry must not start a second PI');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal((await a.json()).id, 'session-1'); assert.equal((await b.json()).id, 'session-1');
  assert.equal(spawned, 1);
  const other = await post({ cwd: directory, idempotencyKey: '7f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f' });
  assert.equal((await other.json()).id, 'session-2', 'another key is another session');
  const plain = await post({ cwd: directory }); assert.equal(plain.status, 201);
  assert.equal(spawned, 3, 'requests without a key always start a session');
 } finally { release(); await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('a refused creation can be retried with the same key', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-service-retry-'));
 let spawned = 0;
 class Fake extends EventEmitter { constructor() { super(); this.id = `ok-${++spawned}`; this.cwd = directory; } async ready() { return { sessionId: this.id }; } async close() { this.emit('exit'); } }
 const service = await createPiService({ directory, roots: [directory], makeRpc: () => new Fake() });
 const origin = `http://127.0.0.1:${service.server.address().port}`;
 const post = body => fetch(origin + '/api/pi/sessions', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: JSON.stringify(body) });
 const key = '8f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
 try {
  assert.equal((await post({ cwd: os.tmpdir(), idempotencyKey: key })).status, 403);
  const retry = await post({ cwd: directory, idempotencyKey: key });
  assert.equal(retry.status, 201); assert.equal((await retry.json()).id, 'ok-1');
 } finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('folder listing shows only directories inside the configured roots', async () => {
 const base = await mkdtemp(path.join(os.tmpdir(), 'pi-dirs-'));
 const root = path.join(base, 'root'), outside = path.join(base, 'outside');
 const { mkdir, symlink } = await import('node:fs/promises');
 await mkdir(path.join(root, 'alpha', 'inner'), { recursive: true }); await mkdir(path.join(root, '.hidden')); await mkdir(outside);
 await writeFile(path.join(root, 'file.txt'), 'x'); await symlink(outside, path.join(root, 'escape')); await symlink(path.join(root, 'alpha'), path.join(root, 'link-inside'));
 const priv = await mkdtemp(path.join(os.tmpdir(), 'pi-dirs-bridge-'));
 const service = await createPiService({ directory: priv, roots: [root], makeRpc: () => { throw Error('no worker'); } });
 const origin = `http://127.0.0.1:${service.server.address().port}`;
 const get = async query => { const r = await fetch(origin + '/api/pi/dirs' + query); return { status: r.status, body: await r.json() }; };
 try {
  const real = await (await import('node:fs/promises')).realpath(root);
  assert.deepEqual((await get('')).body, { roots: [real] });
  const top = (await get('?path=' + encodeURIComponent(root))).body;
  assert.equal(top.directory, real); assert.equal(top.parent, null, 'the root has no parent in the picker');
  assert.deepEqual(top.entries.map(e => e.name), ['alpha', 'link-inside'], 'no files, no hidden folders, no symlink out of the root');
  const inner = (await get('?path=' + encodeURIComponent(path.join(root, 'alpha')))).body;
  assert.equal(inner.parent, real); assert.deepEqual(inner.entries.map(e => e.name), ['inner']);
  await mkdir(path.join(root, 'many')); for (let i = 0; i < 520; i++) await mkdir(path.join(root, 'many', 'd' + String(i).padStart(3, '0')));
  assert.equal((await get('?path=' + encodeURIComponent(path.join(root, 'many')))).body.entries.length, 500, 'listing is bounded');
  assert.equal((await get('?path=' + encodeURIComponent(outside))).status, 403);
  assert.equal((await get('?path=' + encodeURIComponent(path.join(root, 'escape')))).status, 403, 'a symlink out of the root is refused');
  assert.equal((await get('?path=' + encodeURIComponent(path.join(root, '..')))).status, 403);
  assert.equal((await get('?path=' + encodeURIComponent(path.join(root, 'missing')))).status, 404);
  const hostile = await fetch(origin + '/api/pi/dirs?path=' + encodeURIComponent(root), { headers: { origin: 'http://evil.test' } });
  assert.equal(hostile.status, 403);
 } finally { await service.stop(); await rm(base, { recursive: true, force: true }); await rm(priv, { recursive: true, force: true }); }
});

test('fork from a chosen message rewinds the copy, returns the text, removes the discarded full copy and never touches the original', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-service-forkmsg-'));
 const sessions = path.join(directory, 'sessions'); await mkdir(sessions);
 const original = path.join(sessions, 'original.jsonl'); await writeFile(original, '{"type":"session"}\n');
 let n = 0, rewind;
 class Fake extends EventEmitter {
  constructor(options) {
   super(); this.cwd = directory; this.fresh = options.forkFrom !== undefined;
   // PI writes a full copy next to the original as soon as it starts with --fork.
   this.sessionFile = path.join(sessions, options.forkFrom ? `copy-${++n}.jsonl` : 'original.jsonl'); this.id = options.forkFrom ? `fork-${n}` : 'source';
   if (options.forkFrom) writeFileSync(this.sessionFile, 'FULL COPY\n');
  }
  async ready() { return { sessionId: this.id, sessionFile: this.sessionFile }; }
  async snapshot() { return { entries: [], leafId: null, busy: false, sessionFile: this.sessionFile }; }
  async command(type, data) {
   if (type === 'fork') {
    rewind = data;
    if (data.entryId === 'unknown') throw Error('PI rejected command');
    if (data.entryId === 'cancelled') return { cancelled: true };
    this.sessionFile = path.join(sessions, `rewound-${n}.jsonl`); this.id = `rewound-${n}`; writeFileSync(this.sessionFile, 'REWOUND\n');
    return { text: 'the original question', cancelled: false };
   }
   return { sessionFile: this.sessionFile, isStreaming: false, pendingMessageCount: 0 };
  }
  async close() { this.emit('exit'); }
 }
 const service = await createPiService({ directory, roots: [directory], makeRpc: options => new Fake(options) });
 const origin = `http://127.0.0.1:${service.server.address().port}`;
 const post = (route, body) => fetch(origin + route, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: JSON.stringify(body) });
 try {
  assert.equal((await post('/api/pi/sessions', { cwd: directory })).status, 201);
  const files = async () => (await readdir(sessions)).sort();
  assert.deepEqual(await files(), ['original.jsonl']);
  const ok = await post('/api/pi/sessions/source/fork', { entryId: 'abc-123' });
  assert.equal(ok.status, 201); const forked = await ok.json();
  assert.equal(forked.text, 'the original question'); assert.equal(forked.id, 'rewound-1');
  assert.deepEqual(rewind, { entryId: 'abc-123' });
  assert.deepEqual(await files(), ['original.jsonl', 'rewound-1.jsonl'], 'the full copy is gone, the original stays');
  assert.equal(await readFile(original, 'utf8'), '{"type":"session"}\n');
  for (const [entryId, status] of [['unknown', 409], ['cancelled', 409], ['../../etc/passwd', 400], [42, 400]]) {
   const refused = await post('/api/pi/sessions/source/fork', { entryId });
   assert.equal(refused.status, status, `entryId ${JSON.stringify(entryId)}`);
   assert.deepEqual(await files(), ['original.jsonl', 'rewound-1.jsonl'], `no file left behind after ${JSON.stringify(entryId)}`);
  }
  assert.equal((await readFile(original, 'utf8')), '{"type":"session"}\n');
  const plain = await post('/api/pi/sessions/source/fork', {});
  assert.equal(plain.status, 201); assert.equal((await plain.json()).text, undefined, 'a plain fork returns no text');
  const after = await files();
  assert.equal(after.filter(file => file.startsWith('copy-')).length, 1, `a plain fork keeps its copy (${after.join(', ')})`);
 } finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('discarding the full copy never removes the original or a file outside the session folder', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-service-forkguard-'));
 const sessions = path.join(directory, 'sessions'), elsewhere = path.join(directory, 'elsewhere'); await mkdir(sessions); await mkdir(elsewhere);
 const original = path.join(sessions, 'original.jsonl'); await writeFile(original, 'ORIGINAL\n');
 const foreign = path.join(elsewhere, 'foreign.jsonl'); await writeFile(foreign, 'FOREIGN\n');
 const notSession = path.join(sessions, 'notes.txt'); await writeFile(notSession, 'NOTES\n');
 const inPlace = path.join(sessions, 'in-place.jsonl'); await writeFile(inPlace, 'IN PLACE\n');
 let mode = 'same-as-source';
 class Fake extends EventEmitter {
  constructor(options) { super(); this.cwd = directory; this.id = options.forkFrom ? `fork-${mode}` : 'source'; this.sessionFile = options.forkFrom ? (mode === 'same-as-source' ? original : mode === 'foreign' ? foreign : mode === 'in-place' ? inPlace : notSession) : original; }
  async ready() { return { sessionId: this.id, sessionFile: this.sessionFile }; }
  async snapshot() { return { entries: [], leafId: null, busy: false, sessionFile: original }; }
  async command(type) { if (type === 'fork') { if (mode !== 'in-place') this.sessionFile = path.join(sessions, 'rewound.jsonl'); this.id = 'rewound'; return { text: 't', cancelled: false }; } return { sessionFile: this.sessionFile, isStreaming: false, pendingMessageCount: 0 }; }
  async close() { this.emit('exit'); }
 }
 const service = await createPiService({ directory, roots: [directory], makeRpc: options => new Fake(options) });
 const origin = `http://127.0.0.1:${service.server.address().port}`;
 const post = (route, body) => fetch(origin + route, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: JSON.stringify(body) });
 try {
  assert.equal((await post('/api/pi/sessions', { cwd: directory })).status, 201);
  for (const next of ['same-as-source', 'foreign', 'not-jsonl', 'in-place']) {
   mode = next;
   const response = await post('/api/pi/sessions/source/fork', { entryId: 'abc' });
   assert.equal(response.status, 201, next);
   // Remove the fork again so the next round can create one with the same ids.
   await post(`/api/pi/sessions/${(await response.json()).id}/release`, {}).catch(() => {});
   assert.equal(await readFile(original, 'utf8'), 'ORIGINAL\n', `${next}: original kept`);
   assert.equal(await readFile(foreign, 'utf8'), 'FOREIGN\n', `${next}: file outside the folder kept`);
   assert.equal(await readFile(notSession, 'utf8'), 'NOTES\n', `${next}: non-session file kept`);
   assert.equal(await readFile(inPlace, 'utf8'), 'IN PLACE\n', `${next}: a file the fork still uses is kept`);
  }
 } finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});
