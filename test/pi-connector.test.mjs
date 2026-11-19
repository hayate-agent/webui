import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import connector, { connectorDirectory } from '../pi-adapter/extension.mjs';
import { createOwnerServer } from '../pi-adapter/owner-server.mjs';

test('connector reads .pi service configuration without an environment requirement', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-config-'));
 const file = path.join(directory, 'webui.json');
 try {
  assert.equal(connectorDirectory({}, file), undefined);
  await writeFile(file, JSON.stringify({ version: 1, bridgeDir: directory }));
  assert.equal(connectorDirectory({}, file), directory);
  assert.equal(connectorDirectory({ PI_WEBUI_BRIDGE_DIR: '/test-override' }, file), '/test-override');
  await writeFile(file, '{invalid'); assert.equal(connectorDirectory({}, file), undefined);
 } finally { await rm(directory, { recursive: true, force: true }); }
});

test('connector controls existing owner and relays live output without creating runtime', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-connector-'));
 const prior = process.env.PI_WEBUI_BRIDGE_DIR;
 process.env.PI_WEBUI_BRIDGE_DIR = directory;
 const server = await createOwnerServer(directory), handlers = new Map(), prompts = [];
 let busy = false, aborted = false;
 const ctx = { mode: 'tui', cwd: directory, isIdle: () => !busy, abort: async () => { aborted = true; }, sessionManager: {
  getSessionId: () => 'existing-session', getSessionName: () => 'Existing', getBranch: () => [{ id: 'entry', type: 'message', message: { role: 'user', content: 'hello' } }], getLeafId: () => 'entry',
 } };
 connector({ registerCommand: () => {}, on: (name, callback) => handlers.set(name, callback), sendUserMessage: (...args) => prompts.push(args), setSessionName: () => {} });
 try {
  const registered = once(server.events, 'change'); handlers.get('session_start')({}, ctx); await registered;
  assert.equal(server.list()[0].id, 'existing-session');
  const state = await server.command('existing-session', 'snapshot');
  assert.equal(state.leafId, 'entry');
  await server.command('existing-session', 'prompt', { text: 'From browser' });
  assert.equal(prompts[0][0], 'From browser');
  busy = true;
  await assert.rejects(server.command('existing-session', 'prompt', { text: 'Ambiguous mode' }), /rejected/);
  await server.command('existing-session', 'prompt', { text: 'Steer', mode: 'steer' });
  assert.equal(prompts[1][1].deliverAs, 'steer');
  await assert.rejects(server.command('existing-session', 'prompt', { text: '/new' }), /rejected/);
  await server.command('existing-session', 'abort'); assert.equal(aborted, true);
  await assert.rejects(server.command('existing-session', 'reload'), /rejected/);
  busy = false; handlers.get('agent_settled')({ type: 'agent_settled' });
  const image = { type: 'image', mimeType: 'image/png', data: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64') };
  await server.command('existing-session', 'prompt', { text: 'Describe the image', images: [image] });
  assert.deepEqual(prompts.at(-1)[0], [{ type: 'text', text: 'Describe the image' }, image], 'native PI receives actual image content');
  handlers.get('agent_settled')({ type: 'agent_settled' });
  await assert.rejects(server.command('existing-session', 'prompt', { text: 'Invalid image', images: [{ ...image, mimeType: 'image/jpeg' }] }), /rejected/);
  const reloaded = await server.command('existing-session', 'reload');
  assert.equal(reloaded.operation, 'reload');
  assert.equal(reloaded.completion, 'reconnect-required');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(prompts.at(-1)[0], '/webui-reload-runtime');
  assert.equal(prompts.at(-1)[1].expandPromptTemplates, true);
  const output = once(server.events, 'event');
  handlers.get('message_update')({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'live' } });
  assert.equal((await output)[0].event.assistantMessageEvent.delta, 'live');
 } finally {
  handlers.get('session_shutdown')(); await server.close(); await rm(directory, { recursive: true, force: true });
  if (prior === undefined) delete process.env.PI_WEBUI_BRIDGE_DIR; else process.env.PI_WEBUI_BRIDGE_DIR = prior;
 }
});
