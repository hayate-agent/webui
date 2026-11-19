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
