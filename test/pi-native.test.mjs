import { validPng } from './image-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { RpcOwner } from '../pi-adapter/rpc-owner.mjs';
import { createPiService } from '../pi-adapter/service.mjs';

// Opt-in because PI must be installed; entirely isolated agent home and session
// root. Only a loopback fixture provider; no external inference or user sessions.
test('installed PI supports native RPC state and entry snapshots', { skip: !process.env.PI_WEBUI_NATIVE_TEST, timeout: 30000 }, async () => {
 const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-native-'));
 const home = path.join(temp, 'agent'); await mkdir(home);
 const providerRequests = [];
 const provider = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  providerRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.end(event({ role: 'assistant', content: 'Persisted handoff answer' }) + event({}, 'stop') + 'data: [DONE]\n\n');
 });
 await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
 await writeFile(path.join(home, 'models.json'), JSON.stringify({ providers: { 'handoff-fixture': { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', models: [{ id: 'fixture', input: ['text', 'image'], contextWindow: 32000, maxTokens: 1000 }] } } }));
 const launch = extra => new RpcOwner({ cwd: temp, sessionDir: path.join(temp, 'sessions'), spawnProcess: (executable, args, options) => spawn(executable, [...args, ...extra, '--provider', 'handoff-fixture', '--model', 'fixture', '--api-key', 'fixture', '--offline', '--no-extensions', '--no-skills', '--no-context-files', '--no-approve'], { ...options, env: { ...process.env, PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1' } }) });
 const worker = launch([]);
 let resumed, fork, reopenedFork, adapter;
 try {
  const state = await worker.ready(); assert.equal(typeof state.sessionId, 'string');
  const snapshot = await worker.snapshot(); assert.ok(Array.isArray(snapshot.entries)); assert.equal(snapshot.busy, false);
  const settled = new Promise(resolve => { const observe = event => { if (event.type === 'agent_settled') { worker.off('event', observe); resolve(); } }; worker.on('event', observe); });
  await worker.command('prompt', { message: 'Persist this isolated conversation' });
  await settled;
  const persisted = await worker.command('get_state');
  assert.ok((await readFile(persisted.sessionFile, 'utf8')).includes('Persisted handoff answer'));
  const originalBytes = await readFile(persisted.sessionFile, 'utf8');
  fork = launch(['--fork', persisted.sessionFile]);
  const forkState = await fork.ready(); assert.notEqual(forkState.sessionId, state.sessionId); assert.notEqual(forkState.sessionFile, persisted.sessionFile);
  const forkHistory = await fork.command('get_messages');
  assert.ok(forkHistory.messages.some(message => message.role === 'assistant' && message.content.some(block => block.text === 'Persisted handoff answer')));
  assert.equal(await readFile(persisted.sessionFile, 'utf8'), originalBytes, 'native fork preserves source bytes');
  const forkSettled = new Promise(resolve => { const observe = event => { if (event.type === 'agent_settled') { fork.off('event', observe); resolve(); } }; fork.on('event', observe); });
  await fork.command('prompt', { message: 'Continue only the fork' }); await forkSettled;
  const continuedFork = await fork.command('get_state');
  assert.equal(await readFile(persisted.sessionFile, 'utf8'), originalBytes, 'fork continuation cannot write the original');
  await fork.close();
  reopenedFork = launch(['--session', continuedFork.sessionFile]);
  assert.equal((await reopenedFork.ready()).sessionId, forkState.sessionId);
  const reopenedHistory = await reopenedFork.command('get_messages');
  assert.ok(reopenedHistory.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Continue only the fork')));
  assert.equal(await readFile(persisted.sessionFile, 'utf8'), originalBytes, 'reopening fork leaves original unchanged');
  await reopenedFork.close();
  await worker.close(); assert.equal(worker.exited, true);
  resumed = launch(['--session', persisted.sessionFile]);
  const restored = await resumed.ready(); assert.equal(restored.sessionId, state.sessionId);
  const history = await resumed.command('get_messages');
  assert.ok(history.messages.some(message => message.role === 'assistant' && message.content.some(block => block.text === 'Persisted handoff answer')));
  const managed = [];
  adapter = await createPiService({ directory: path.join(temp, 'runtime'), roots: [temp], makeRpc: options => {
    const owner = launch(options.forkFrom ? ['--fork', options.forkFrom] : []); managed.push(owner); return owner;
  } });
  const origin = `http://127.0.0.1:${adapter.server.address().port}`;
  const post = (route, data) => fetch(origin + route, { method: 'POST', headers: { origin, 'x-hayate-webui': '1', 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const createdResponse = await post('/api/pi/sessions', { cwd: temp }); assert.equal(createdResponse.status, 201);
  const source = await createdResponse.json();
  const sourceOwner = managed[0];
  const sourceSettled = new Promise(resolve => { const observe = event => { if (event.type === 'agent_settled') { sourceOwner.off('event', observe); resolve(); } }; sourceOwner.on('event', observe); });
  assert.equal((await post(`/api/pi/sessions/${source.id}/prompt`, { text: 'HTTP source history' })).status, 200);
  await sourceSettled;
  // Real PI consumes staged media and forwards it to a local fixture model.
  const imageBytes = validPng;
  const upload = await post(`/api/pi/sessions/${source.id}/media`, { uploadId: '11111111-1111-4111-8111-111111111111', index: 0, data: imageBytes.toString('base64'), mimeType: 'image/png', final: true });
  assert.equal(upload.status, 200); const imageRef = await upload.json();
  const imageSettled = new Promise(resolve => { const observe = event => { if (event.type === 'agent_settled') { sourceOwner.off('event', observe); resolve(); } }; sourceOwner.on('event', observe); });
  const imageResponse = await post(`/api/pi/sessions/${source.id}/prompt`, { text: 'Describe this isolated image', attachments: [{ id: imageRef.id }] });
  assert.equal(imageResponse.status, 200); await imageSettled;
  const nativeImages = await sourceOwner.command('get_messages');
  assert.ok(nativeImages.messages.some(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'image')), 'native session persists image content');
  const imageMessage = providerRequests.at(-1).messages.find(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'image_url'));
  assert.ok(imageMessage, 'actual native PI sends image content to the model provider: ' + JSON.stringify(providerRequests.at(-1).messages.map(message => ({ role: message.role, blocks: Array.isArray(message.content) ? message.content.map(block => block.type) : typeof message.content }))));
  assert.ok(imageMessage.content.find(block => block.type === 'image_url').image_url.url.startsWith('data:image/png;base64,'));
  const sourceFile = (await sourceOwner.command('get_state')).sessionFile;
  const sourceBefore = await readFile(sourceFile, 'utf8');
  const forkResponse = await post(`/api/pi/sessions/${source.id}/fork`, {}); assert.equal(forkResponse.status, 201);
  const httpFork = await forkResponse.json(); assert.notEqual(httpFork.id, source.id);
  const forkSnapshot = await (await fetch(`${origin}/api/pi/sessions/${httpFork.id}`)).json();
  assert.ok(forkSnapshot.messages.some(message => message.text === 'HTTP source history'));
  const managedFork = managed[1];
  const httpSettled = new Promise(resolve => { const observe = event => { if (event.type === 'agent_settled') { managedFork.off('event', observe); resolve(); } }; managedFork.on('event', observe); });
  assert.equal((await post(`/api/pi/sessions/${httpFork.id}/prompt`, { text: 'HTTP fork-only continuation' })).status, 200);
  await httpSettled;
  const continued = await (await fetch(`${origin}/api/pi/sessions/${httpFork.id}`)).json();
  assert.ok(continued.messages.some(message => message.text === 'HTTP fork-only continuation'));
  assert.equal(await readFile(sourceFile, 'utf8'), sourceBefore);
  const sourceSnapshot = await (await fetch(`${origin}/api/pi/sessions/${source.id}`)).json();
  assert.ok(!sourceSnapshot.messages.some(message => message.text === 'HTTP fork-only continuation'));
  // Fork from one earlier message: the copy stops just before it, the full copy PI makes first is removed, the original is untouched.
  const sourcePage = await (await fetch(`${origin}/api/pi/sessions/${source.id}?view=remote`)).json();
  const secondUser = sourcePage.messages.find(message => message.role === 'user' && message.text === 'Describe this isolated image');
  assert.ok(secondUser, 'the second user message is in the page');
  const filesBefore = (await readdir(path.dirname(sourceFile))).sort();
  const sourceBytesBefore = await readFile(sourceFile, 'utf8');
  const partial = await post(`/api/pi/sessions/${source.id}/fork`, { entryId: secondUser.id }); assert.equal(partial.status, 201);
  const partialFork = await partial.json();
  assert.equal(partialFork.text, 'Describe this isolated image', 'the chosen message text comes back for the composer');
  const partialPage = await (await fetch(`${origin}/api/pi/sessions/${partialFork.id}?view=remote`)).json();
  assert.deepEqual(partialPage.messages.map(message => message.text), ['HTTP source history', 'Persisted handoff answer'], 'the fork keeps everything before the chosen message and nothing after');
  assert.equal(await readFile(sourceFile, 'utf8'), sourceBytesBefore, 'original session file unchanged');
  const filesAfter = (await readdir(path.dirname(sourceFile))).sort();
  assert.equal(filesAfter.length, filesBefore.length + 1, 'exactly one new session file (the discarded full copy is gone)');
  assert.ok(filesAfter.some(file => file.includes(partialFork.id)), 'the new file belongs to the fork');
  assert.equal((await post(`/api/pi/sessions/${source.id}/fork`, { entryId: 'does-not-exist' })).status >= 400, true, 'unknown message refused');
  assert.equal((await readdir(path.dirname(sourceFile))).length, filesBefore.length + 1, 'a refused fork leaves no file behind');
 } finally {
  await adapter?.stop(); await reopenedFork?.close(); await fork?.close(); await resumed?.close(); await worker.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(temp, { recursive: true, force: true });
 }
});
