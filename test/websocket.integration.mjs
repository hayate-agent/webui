import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createDashboard } from '../server/server.mjs';
if (!process.env.HAYATE_PLUGINS_ROOT) throw Error('Set HAYATE_PLUGINS_ROOT to the backend Plugins checkout');
const load = file => import(pathToFileURL(path.join(process.env.HAYATE_PLUGINS_ROOT, file)));
const { setup } = await load('agent-link/test/fixture.mjs');
const { AgentRelay } = await load('agent-link/websocket-relay.mjs');
const { OutboundAgentLink } = await load('agent-link/websocket-client.mjs');
const { WebUIChannel } = await load('dashboard-api/index.mjs');
const { Workspace } = await load('workspace/service.mjs');
const { Identity, passwordRecord } = await load('identity/service.mjs');
const { CAPABILITIES } = await load('agent-link/workspace-protocol.mjs');
const cleanups = []; let dashboard, api, client, relay, browser;
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
async function wait(fn) { const deadline = Date.now() + 5000; while (!fn()) { if (Date.now() > deadline) throw Error('WebSocket integration deadline exceeded'); await new Promise(resolve => setTimeout(resolve, 15)); } }
try {
  const f = await setup({ after: action => cleanups.push(action) }); await f.server.stop();
  const origin = `https://127.0.0.1:${await port()}`, backend = `https://127.0.0.1:${await port()}`;
  relay = new AgentRelay({ home: f.centralHome, origin }); await relay.open({ listen: false });
  f.central.registerAdapter('hayate-wss', relay.adapter);
  const local = new Workspace({ home: f.centralHome, cwd: f.centralHome }); await local.open(); cleanups.push(() => local.stop());
  const identity = new Identity({ username: 'admin', password: await passwordRecord('fixture-password-long') }); cleanups.push(() => identity.stop());
  const services = { workspaces: local, identity, 'agent-hub': f.central, 'agent-link-relay': relay };
  api = new WebUIChannel({ home: f.centralHome, port: Number(new URL(backend).port), network: { host: '127.0.0.1', origin, keyFile: f.config.keyFile, certFile: f.config.certFile }, services: { get: name => services[name] ? { version: 1, implementation: services[name] } : undefined } });
  await api.start(async () => {});
  const tls = { key: await readFile(f.config.keyFile), cert: await readFile(f.config.certFile) };
  dashboard = await createDashboard({ origin, upstream: backend, upstreamOrigin: origin, upstreamServername: 'localhost', ca: tls.cert, tls });
  client = new OutboundAgentLink({ home: f.targetHome, agent: 'NAT agent through dashboard', workspace: f.workspace, credentials: f.targetVault, config: { projects: { local: f.project.id }, capabilities: CAPABILITIES, relays: [{ origin, caFile: f.config.certFile }] } }); await client.open();
  browser = await chromium.launch({ headless: true });
  // Fixture browser only: its generated CA is not in Chromium's machine trust store.
  // The actual agent WSS connection and frontend/backend TLS both validate that CA.
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto(origin); await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('fixture-password-long'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'Invite outbound agent', exact: true }).click(); await page.getByLabel('Agent name', { exact: true }).fill('Outbound dashboard agent'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  const input = page.getByLabel('Outbound invitation code', { exact: true }); await input.waitFor();
  assert.equal(await input.getAttribute('type'), 'password'); const code = await input.inputValue();
  assert.equal(await page.evaluate(code => Object.values(sessionStorage).some(value => value.includes(code)), code), false);
  await client.enroll(origin, code);
  await wait(() => client.status().connected && relay.list('operator')[0]?.connected);
  assert.equal(f.central.list('operator').length, 0);
  await page.getByRole('button', { name: 'Back to incoming connections', exact: true }).click();
  const incoming = page.getByRole('article', { name: 'Incoming agent Outbound dashboard agent', exact: true }); await incoming.waitFor();
  assert.equal(f.central.list('operator').length, 0, 'Incoming connection still needs the human approval click');
  await incoming.getByRole('button', { name: 'Approve and register', exact: true }).click();
  await page.getByRole('article', { name: 'Registered agent Outbound dashboard agent', exact: true }).waitFor();
  const agent = f.central.list('operator')[0];
  const stream = await f.central.request('operator', agent.id, 'streams', { action: 'create', projectId: f.project.id, title: 'HTTPS frontend WSS', idempotencyKey: randomUUID() });
  await f.central.request('operator', agent.id, 'messages', { action: 'send', streamId: stream.id, id: randomUUID(), text: 'Through the public HTTPS/WSS connection' });
  const response = await f.central.request('operator', agent.id, 'messages', { action: 'read', streamId: stream.id });
  assert.equal(response.messages.at(-1).text, 'Remote answer'); assert.equal(f.received.length, 1);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('article', { name: 'Registered agent Outbound dashboard agent', exact: true }).getByRole('button', { name: 'Remove agent', exact: true }).click();
  await page.getByText('No remote agents registered yet.', { exact: true }).waitFor(); await wait(() => client.status().revoked);
  console.log('Independent HTTPS dashboard WSS proxy + actual API/identity/relay + outbound-only target: enrollment, manual approval, scoped work/reply and revocation passed with CA validation.');
} finally {
  await browser?.close(); await client?.stop(); await dashboard?.stop(); await api?.stop(); await relay?.stop(); for (const action of cleanups.reverse()) await action();
}
