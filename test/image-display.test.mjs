import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageChunk, IMAGE_CHUNK_BYTES, projectMessage } from '../pi-adapter/history-page.mjs';
import { createImageLoader, MAX_BLOBS } from '../dashboard/public/image-loader.js';
import { validPng } from './image-fixture.mjs';

const png = Buffer.concat([validPng, Buffer.alloc(150000, 7)]);
const entry = { id: 'm1', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] } };

test('a page carries image metadata only, never bytes', () => {
 const message = projectMessage(entry);
 assert.deepEqual(message.images, [{ mimeType: 'image/png', bytes: png.length }]);
 assert.ok(!JSON.stringify(message).includes(png.toString('base64').slice(0, 64)));
});
test('imageChunk returns bounded chunks that reassemble exactly', () => {
 const parts = []; let offset = 0, guard = 0;
 for (;;) { const chunk = imageChunk([entry], 'm1', 0, offset); assert.ok(Buffer.from(chunk.data, 'base64').length <= IMAGE_CHUNK_BYTES); parts.push(Buffer.from(chunk.data, 'base64')); offset = chunk.next; if (chunk.done) break; assert.ok(++guard < 20); }
 assert.ok(parts.length >= 3);
 assert.equal(Buffer.concat(parts).compare(png), 0);
});
test('imageChunk refuses unknown messages, indexes, offsets and non-raster types', () => {
 assert.throws(() => imageChunk([entry], 'nope', 0), { status: 404 });
 assert.throws(() => imageChunk([entry], 'm1', 1), { status: 404 });
 assert.throws(() => imageChunk([entry], 'm1', 0, png.length + 1), { status: 400 });
 assert.throws(() => imageChunk([entry], 'm1', -1), { status: 400 });
 const svg = { id: 's', type: 'message', message: { role: 'user', content: [{ type: 'image', mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }] } };
 assert.throws(() => imageChunk([svg], 's', 0), { status: 404 });
});
const A = { agentId: 'a', streamId: 's' };
const fetcher = () => { let calls = 0; return { calls: () => calls, fetchChunk: async ({ messageId, index, offset }) => { calls++; return imageChunk([entry], messageId, index, offset); } }; };
test('loader assembles a Blob lazily, caches it and revokes the oldest beyond the bound', async () => {
 const f = fetcher(), made = [], revoked = [];
 const loader = createImageLoader({ fetchChunk: f.fetchChunk, createUrl: blob => { made.push(blob); return 'blob:' + made.length; }, revokeUrl: url => revoked.push(url) });
 assert.equal(f.calls(), 0);
 const url = await loader.load(A, 'm1', 0);
 assert.equal(url, 'blob:1'); assert.equal(made[0].size, png.length); assert.equal(made[0].type, 'image/png');
 const before = f.calls(); assert.equal(await loader.load(A, 'm1', 0), url); assert.equal(f.calls(), before, 'second show hits the cache');
 for (let i = 0; i < MAX_BLOBS + 2; i++) await loader.load({ agentId: 'a', streamId: 's' + i }, 'm1', 0);
 assert.equal(loader.size, MAX_BLOBS); assert.ok(revoked.includes('blob:1'), 'oldest blob URL revoked');
 loader.clear(); assert.equal(loader.size, 0);
});
test('loader rejects inconsistent or oversize responses', async () => {
 const bad = createImageLoader({ fetchChunk: async () => ({ mimeType: 'image/png', size: 6 * 1024 * 1024, offset: 0, data: 'AAAA', done: true, next: 3 }), createUrl: () => 'x' });
 await assert.rejects(() => bad.load(A, 'm', 0), /too large/);
 const stuck = createImageLoader({ fetchChunk: async ({ offset }) => ({ mimeType: 'image/png', size: 10, offset, data: 'AAAA', done: false, next: offset }), createUrl: () => 'x' });
 await assert.rejects(() => stuck.load(A, 'm', 0), /invalid/);
});

import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiService } from '../pi-adapter/service.mjs';
test('service serves one bounded image block from a read-only disk session and refuses bad requests', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'img-svc-'));
 await mkdir(path.join(root, 'p'));
 const lines = [{ type: 'session', version: 3, id: 'sess-1', cwd: root, timestamp: new Date().toISOString() }, { ...entry, parentId: null }];
 await writeFile(path.join(root, 'p', '2026-sess-1.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
 const service = await createPiService({ directory: root, roots: [root], sessionRoots: [root], makeRpc: () => { throw Error('no worker'); } });
 const origin = `http://127.0.0.1:${service.server.address().port}`;
 try {
  const list = await (await fetch(origin + '/api/pi/sessions')).json();
  const id = list.sessions.find(session => session.cwd === root)?.id; assert.ok(id?.startsWith('disk_'));
  const ok = await fetch(`${origin}/api/pi/sessions/${id}/image?message=m1&index=0&offset=0`);
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  const body = await ok.json(); assert.equal(body.mimeType, 'image/png'); assert.equal(body.done, false); assert.ok(body.data.length <= Math.ceil(IMAGE_CHUNK_BYTES / 3) * 4);
  assert.equal((await fetch(`${origin}/api/pi/sessions/${id}/image?message=zzz&index=0`)).status, 404);
  assert.equal((await fetch(`${origin}/api/pi/sessions/${id}/image?message=m1&index=9`)).status, 400);
  assert.equal((await fetch(`${origin}/api/pi/sessions/${id}/image?message=m1&index=0`, { headers: { origin: 'http://evil.test' } })).status, 403);
 } finally { await service.stop(); }
});

test('chunks of an in-flight load stay bound to the session it started in', async () => {
 const seen = [];
 const loader = createImageLoader({ fetchChunk: async ({ messageId, index, offset }, scope) => { seen.push(scope.streamId); return imageChunk([entry], messageId, index, offset); }, createUrl: () => 'blob:x' });
 await loader.load({ agentId: 'a', streamId: 'first' }, 'm1', 0);
 assert.ok(seen.length >= 3 && seen.every(id => id === 'first'));
});

test('imageChunk enforces the 5 MiB limit server-side', () => {
 const huge = { id: 'h', type: 'message', message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: Buffer.alloc(5 * 1024 * 1024 + 3000, 1).toString('base64') }] } };
 assert.throws(() => imageChunk([huge], 'h', 0), { status: 413 });
});
test('exactly 5 MiB passes, one byte more is refused', () => {
 const at = (n) => [{ id: 'b', type: 'message', message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: Buffer.alloc(n, 1).toString('base64') }] } }];
 assert.equal(imageChunk(at(5 * 1024 * 1024), 'b', 0).size, 5 * 1024 * 1024);
 assert.throws(() => imageChunk(at(5 * 1024 * 1024 + 1), 'b', 0), { status: 413 });
});
test('a live worker is never snapshotted for an image read', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'img-live-'));
 await mkdir(path.join(root, 'p'));
 const header = { type: 'session', version: 3, id: 'live-sess', cwd: root, timestamp: new Date().toISOString() };
 await writeFile(path.join(root, 'p', '2026-live-sess.jsonl'), [header, { ...entry, parentId: null }].map(line => JSON.stringify(line)).join('\n') + '\n');
 let snapshots = 0;
 class Fake extends (await import('node:events')).EventEmitter {
  id = 'live-sess'; cwd = root;
  async ready() { return { sessionId: this.id }; }
  async snapshot() { snapshots++; throw Error('whole-session snapshot must not be used for images'); }
  async command(type) { return type === 'get_state' ? { sessionFile: path.join(root, 'p', '2026-live-sess.jsonl'), isStreaming: false, pendingMessageCount: 0 } : {}; }
  async close() { this.emit('exit'); }
 }
 const service = await createPiService({ directory: root, roots: [root], sessionRoots: [root], makeRpc: () => new Fake() });
 const origin = `http://127.0.0.1:${service.server.address().port}`;
 try {
  const created = await fetch(origin + '/api/pi/sessions', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: JSON.stringify({ cwd: root }) });
  assert.equal(created.status, 201);
  const res = await fetch(`${origin}/api/pi/sessions/live-sess/image?message=m1&index=0&offset=0`);
  assert.equal(res.status, 200); assert.equal(snapshots, 0);
 } finally { await service.stop(); }
});
