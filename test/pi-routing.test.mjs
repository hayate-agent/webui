import { validPng } from './image-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../server/server.mjs';
import { createPiService } from '../pi-adapter/service.mjs';

test('one dashboard routes Hayate and live PI to distinct fixed owners without leaking cookies', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-route-'));
 const pi = await createPiService({ directory, roots: [directory] });
 const hayate = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ backend: 'hayate', cookie: req.headers.cookie })); });
 await new Promise(resolve => hayate.listen(0, '127.0.0.1', resolve));
 const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
 const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
 const origin = `http://127.0.0.1:${port}`;
 const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${hayate.address().port}`, piUpstream: `http://127.0.0.1:${pi.server.address().port}` });
 const peer = net.createConnection(pi.owners.socketPath); peer.setEncoding('utf8');
 let cookie;
 pi.server.on('request', req => { cookie = req.headers.cookie; });
 try {
  await once(peer, 'connect'); const registered = once(peer, 'data');
  peer.write(JSON.stringify({ type: 'register', sessionId: 'live', cwd: directory, name: 'Terminal', features: ['history-page-v1', 'image-prompt-v1'] }) + '\n'); await registered;
  const hayateState = await (await fetch(origin + '/api/state', { headers: { cookie: 'hayate=private' } })).json();
  assert.equal(hayateState.backend, 'hayate'); assert.equal(hayateState.cookie, 'hayate=private');
  const sessions = await (await fetch(origin + '/api/pi/sessions', { headers: { cookie: 'hayate=private' } })).json();
  assert.equal(sessions.sessions[0].id, 'live'); assert.equal(cookie, undefined);
  const rejected = await fetch(origin + '/api/pi/sessions/live/prompt', { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: '{"text":"no"}' });
  assert.equal(rejected.status, 403);
  const png = validPng;
  const staged = await (await fetch(origin + '/api/pi/sessions/live/media', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: JSON.stringify({ uploadId: '11111111-1111-4111-8111-111111111111', index: 0, data: png.toString('base64'), mimeType: 'image/png', final: true }) })).json();
  assert.ok(staged.id);
  const imageCommand = once(peer, 'data');
  const imagePrompt = fetch(origin + '/api/pi/sessions/live/prompt', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: JSON.stringify({ text: '', attachments: [{ id: staged.id }] }) });
  const imageRequest = JSON.parse((await imageCommand)[0]);
  assert.equal(imageRequest.data.images[0].data, png.toString('base64'), 'staged bytes reach original native owner');
  peer.write(JSON.stringify({ type: 'response', id: imageRequest.id, success: true, data: { accepted: true } }) + '\n');
  assert.equal((await imagePrompt).status, 200);
  const commandReceived = once(peer, 'data');
  const submitted = fetch(origin + '/api/pi/sessions/live/prompt', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: '{"text":"same owner"}' });
  const command = JSON.parse((await commandReceived)[0]); assert.equal(command.data.text, 'same owner');
  peer.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: { accepted: true } }) + '\n');
  assert.equal((await submitted).status, 200);
  const snapshotCommand = once(peer, 'data');
  const firstRead = fetch(origin + '/api/pi/sessions/live?view=remote');
  const snapshot = JSON.parse((await snapshotCommand)[0]);
  peer.write(JSON.stringify({ type: 'response', id: snapshot.id, success: true, data: { messages: [{ id: 'm', role: 'user', text: 'Retained history' }], before: null, busy: false } }) + '\n');
  assert.equal((await (await firstRead).json()).messages[0].text, 'Retained history');
  const disconnected = once(pi.owners.events, 'change'); peer.destroy(); await disconnected;
  const retainedResponse = await fetch(origin + '/api/pi/sessions/live?view=remote');
  assert.equal(retainedResponse.status, 200);
  const retained = await retainedResponse.json();
  assert.equal(retained.stale, true); assert.equal(retained.readOnly, true);
  assert.equal(retained.messages[0].text, 'Retained history');
  assert.equal(retained.busy, undefined, 'cached state must never claim the owner is idle');
  assert.deepEqual(retained.liveTools, []);
  assert.equal((await fetch(origin + '/api/pi/sessions/live?view=remote&before=unknown')).status, 409, 'cache never substitutes a different history cursor');
 } finally { peer.destroy(); await dashboard.stop(); await pi.stop(); hayate.closeAllConnections(); await new Promise(resolve => hayate.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test('PI routing cannot expose local control on network dashboard', async () => {
 await assert.rejects(createDashboard({ origin: 'https://dashboard.example', host: '0.0.0.0', tls: {}, upstream: 'https://hayate.example', piUpstream: 'http://127.0.0.1:3211' }), /loopback-only/);
});

test('a connector started before image history existed still shows images in the history (read from the saved session)', async () => {
 const { mkdir, writeFile, realpath } = await import('node:fs/promises');
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-oldconn-'));
 const sessions = await mkdtemp(path.join(os.tmpdir(), 'pi-oldconn-sessions-'));
 const cwd = await realpath(directory);
 const id = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb';
 await mkdir(path.join(sessions, 'dir'), { recursive: true });
 const image = Buffer.from('x'.repeat(300)).toString('base64');
 const fileFor = sessionId => [{ type: 'session', version: 3, id: sessionId, cwd, timestamp: '2026-01-01T00:00:00Z' },
  { type: 'message', id: 'with-image', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', mimeType: 'image/png', data: image }] } },
  { type: 'model_change', id: 'switch', parentId: 'with-image', timestamp: '2026-01-01T00:00:01Z' },
  { type: 'message', id: 'string-content', parentId: 'switch', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'plain string content' } },
  { type: 'message', id: 'plain', parentId: 'string-content', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  { type: 'message', id: 'many', parentId: 'plain', timestamp: '2026-01-01T00:00:03Z', message: { role: 'user', content: Array.from({ length: 5 }, () => ({ type: 'image', mimeType: 'image/png', data: image })) } }].map(line => JSON.stringify(line)).join('\n') + '\n';
 const current = 'cccccccc-1111-4222-8333-bbbbbbbbbbbb';
 await writeFile(path.join(sessions, 'dir', `2026_${id}.jsonl`), fileFor(id)); await writeFile(path.join(sessions, 'dir', `2026_${current}.jsonl`), fileFor(current));
 const pi = await createPiService({ directory, roots: [directory], sessionRoots: [sessions] });
 const origin = `http://127.0.0.1:${pi.server.address().port}`;
 const connect = async (sessionId, features) => {
  const peer = net.createConnection(pi.owners.socketPath); peer.setEncoding('utf8'); await once(peer, 'connect');
  const registered = once(peer, 'data'); peer.write(JSON.stringify({ type: 'register', sessionId, cwd, name: 'T', features }) + '\n'); await registered; return peer;
 };
 const read = async (peer, sessionId) => {
  const command = once(peer, 'data'); const page = fetch(`${origin}/api/pi/sessions/${sessionId}?view=remote`);
  const request = JSON.parse((await command)[0]);
  peer.write(JSON.stringify({ type: 'response', id: request.id, success: true, data: { messages: [{ id: 'with-image', role: 'user', text: 'see' }, { id: 'plain', role: 'assistant', text: 'ok' }, { id: 'many', role: 'user', text: '' }], before: null, busy: false } }) + '\n');
  return (await page).json();
 };
 try {
  const old = await connect(id, ['history-page-v1', 'image-prompt-v1']);
  const oldPage = await read(old, id);
  assert.deepEqual(oldPage.messages[0].images, [{ mimeType: 'image/png', bytes: 300 }], 'image listed although the old connector sent none');
  assert.equal(oldPage.messages[1].images, undefined, 'a message without images stays without');
  assert.equal(oldPage.messages[2].images.length, 4, 'at most four images are listed');
  const fresh = await connect(current, ['history-page-v1', 'image-prompt-v1', 'history-images-v1']);
  const freshPage = await read(fresh, current);
  assert.equal(freshPage.messages[0].images, undefined, 'a connector that reports history-images-v1 is trusted: nothing is read from disk');
  // Images the connector already lists are never replaced.
  const command = once(old, 'data'); const page = fetch(`${origin}/api/pi/sessions/${id}?view=remote`);
  const request = JSON.parse((await command)[0]);
  old.write(JSON.stringify({ type: 'response', id: request.id, success: true, data: { messages: [{ id: 'with-image', role: 'user', text: 'see', images: [{ mimeType: 'image/jpeg', bytes: 7 }] }], before: null, busy: false } }) + '\n');
  assert.deepEqual((await (await page).json()).messages[0].images, [{ mimeType: 'image/jpeg', bytes: 7 }]);
  old.destroy(); fresh.destroy();
 } finally { await pi.stop(); await rm(directory, { recursive: true, force: true }); await rm(sessions, { recursive: true, force: true }); }
});
