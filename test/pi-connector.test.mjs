import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import connector, { connectorDirectory, GUIDE_GRACE_MS } from '../pi-adapter/extension.mjs';
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

test('connected sessions are told that the WebUI renders openui blocks; unconnected ones are not', async () => {
 const { OPENUI_GUIDE } = await import('../pi-adapter/openui-guide.mjs');
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-guide-'));
 const prior = process.env.PI_WEBUI_BRIDGE_DIR;
 process.env.PI_WEBUI_BRIDGE_DIR = directory;
 const server = await createOwnerServer(directory), handlers = new Map();
 const ctx = { mode: 'tui', cwd: directory, isIdle: () => true, abort: async () => {}, sessionManager: {
  getSessionId: () => 'guide-session', getSessionName: () => 'Guide', getBranch: () => [], getLeafId: () => null } };
 connector({ registerCommand: () => {}, on: (name, callback) => handlers.set(name, callback), sendUserMessage: () => {}, setSessionName: () => {} });
 try {
  const hook = handlers.get('before_agent_start');
  assert.equal(hook({ systemPrompt: 'BASE' }), undefined, 'not connected yet: plain code would be shown, so say nothing');
  const registered = once(server.events, 'change'); handlers.get('session_start')({}, ctx); await registered;
  const result = hook({ systemPrompt: 'BASE' });
  assert.ok(result.systemPrompt.startsWith('BASE\n\n<webui_openui>\n'));
  assert.ok(result.systemPrompt.includes('language `openui`'), 'names the fence language');
  assert.ok(result.systemPrompt.includes('Metric(label: string'), 'lists the real components');
  assert.equal(hook({ systemPrompt: result.systemPrompt }), undefined, 'never appended twice');
  assert.equal(hook({}), undefined); assert.equal(hook({ systemPrompt: 7 }), undefined);
  assert.ok(OPENUI_GUIDE.length < 8000, 'guide stays small');
  assert.doesNotMatch(OPENUI_GUIDE, /Button\(|@Run|Btn\(/, 'chat blocks are data-only: no buttons, queries or actions are advertised');
  // Gateway gone: still told during the grace period (a restart must not flip the prompt), not after it.
  await server.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(hook({ systemPrompt: 'BASE' }), 'inside the grace period');
  // Failed reconnect attempts (every 5 s, they close without ever connecting) must not extend the grace period:
  // the real disconnect is ~5.3 s old, the last failed attempt only ~0.3 s. With this offset only the real
  // disconnect is outside the grace period.
  await new Promise(resolve => setTimeout(resolve, 5300));
  const realNow = Date.now; Date.now = () => realNow() + GUIDE_GRACE_MS - 2000;
  try { assert.equal(hook({ systemPrompt: 'BASE' }), undefined, 'failed reconnects do not keep the guide alive'); } finally { Date.now = realNow; }
  Date.now = () => realNow() + GUIDE_GRACE_MS + 1000;
  try { assert.equal(hook({ systemPrompt: 'BASE' }), undefined, 'disconnected for longer than the grace period: say nothing'); } finally { Date.now = realNow; }
 } finally {
  handlers.get('session_shutdown')?.({});
  if (prior === undefined) delete process.env.PI_WEBUI_BRIDGE_DIR; else process.env.PI_WEBUI_BRIDGE_DIR = prior;
  await rm(directory, { recursive: true, force: true });
 }
});

test('the committed openui guide matches the component library', async () => {
 const { renderGuide } = await import('../scripts/openui-guide.mjs');
 const { readFile } = await import('node:fs/promises');
 assert.equal(await readFile(new URL('../pi-adapter/openui-guide.mjs', import.meta.url), 'utf8'), await renderGuide());
});
