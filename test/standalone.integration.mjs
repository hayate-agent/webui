import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createDashboard } from '../server/server.mjs';
if (!process.env.HAYATE_PLUGINS_ROOT) throw Error('Set HAYATE_PLUGINS_ROOT to the backend Plugins checkout');
const load = file => import(pathToFileURL(path.join(process.env.HAYATE_PLUGINS_ROOT, file)));
const { setup } = await load('agent-link/test/fixture.mjs');
const { OutboundAgentLink } = await load('agent-link/websocket-client.mjs');
const { createAdministration } = await load('dashboard-api/standalone.mjs');
const { passwordRecord } = await load('identity/service.mjs');
const { CAPABILITIES } = await load('agent-link/workspace-protocol.mjs');
const cleanup = []; let frontend, admin, client, browser;
async function port() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function wait(fn) { const deadline = Date.now() + 5000; while (!fn()) { if (Date.now() > deadline) throw Error('Standalone integration deadline exceeded'); await new Promise(r => setTimeout(r, 15)); } }
try {
  const f = await setup({ after: action => cleanup.push(action) }); await f.server.stop();
  const origin = `https://127.0.0.1:${await port()}`, backend = `https://127.0.0.1:${await port()}`;
  const home = path.join(f.home, 'standalone'); await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'identity.json'), JSON.stringify({ username: 'admin', password: await passwordRecord('fixture-password-long') }), { mode: 0o600 });
  admin = await createAdministration({ home, origin, host: '127.0.0.1', port: Number(new URL(backend).port), keyFile: f.config.keyFile, certFile: f.config.certFile });
  const tls = { key: await readFile(f.config.keyFile), cert: await readFile(f.config.certFile) };
  frontend = await createDashboard({ origin, upstream: backend, upstreamOrigin: origin, upstreamServername: 'localhost', ca: tls.cert, tls });
  client = new OutboundAgentLink({ home: f.targetHome, agent: 'Manually added target', workspace: f.workspace, credentials: f.targetVault, config: { projects: { local: f.project.id }, capabilities: CAPABILITIES, relays: [{ origin, caFile: f.config.certFile }] } }); await client.open();
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto(origin); await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('fixture-password-long'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.workspace-tree').waitFor();
  assert.equal(await page.locator('[data-agent-id="local"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '＋ New project', exact: true }).count(), 0);
  assert.ok(await page.getByRole('button', { name: 'Send ↑', exact: true }).isDisabled());
  await page.locator('.workspace-tree').getByRole('button', { name: 'Agents', exact: true }).click(); await page.getByRole('button', { name: 'Invite outbound agent', exact: true }).click();
  await page.getByLabel('Agent name', { exact: true }).fill('Manual WSS target'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  const codeInput = page.getByLabel('Outbound invitation code', { exact: true }); await codeInput.waitFor(); const code = await codeInput.inputValue();
  await client.enroll(origin, code); await wait(() => client.status().connected);
  assert.equal(admin.hub.list('operator').length, 0);
  await page.getByRole('button', { name: 'Back to incoming connections', exact: true }).click();
  await page.getByRole('article', { name: 'Incoming agent Manual WSS target', exact: true }).getByRole('button', { name: 'Approve and register', exact: true }).click();
  await page.getByRole('article', { name: 'Registered agent Manual WSS target', exact: true }).waitFor();
  const agent = admin.hub.list('operator')[0];
  const stream = await admin.hub.request('operator', agent.id, 'streams', { action: 'create', projectId: f.project.id, title: 'Standalone central', idempotencyKey: randomUUID() });
  await admin.hub.request('operator', agent.id, 'messages', { action: 'send', streamId: stream.id, id: randomUUID(), text: 'Central has no agent runtime' });
  const result = await admin.hub.request('operator', agent.id, 'messages', { action: 'read', streamId: stream.id }); assert.equal(result.messages.at(-1).text, 'Remote answer');
  page.on('dialog', d => d.accept()); await page.getByRole('article', { name: 'Registered agent Manual WSS target', exact: true }).getByRole('button', { name: 'Remove agent', exact: true }).click();
  await page.getByText('No remote agents registered yet.', { exact: true }).waitFor(); await wait(() => client.status().revoked);
  console.log('Standalone central administration without Core/model: authenticated browser invitation/manual approval, no fake local agent, outbound WSS scoped message/reply and manual revocation passed.');
} finally { await browser?.close(); await client?.stop(); await frontend?.stop(); await admin?.stop(); for (const action of cleanup.reverse()) await action(); }
