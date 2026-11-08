import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createDashboard } from '../server/server.mjs';
import assert from 'node:assert/strict';
const project = { id: 'project', title: 'Work', cwd: '/work', updatedAt: 1, directories: ['/work'] };
const state = { agent: 'Primary Agent', projects: [project], streams: [
  { id: 'old', projectId: 'project', title: 'Older grouped', updatedAt: 1, messages: [], cwd: '/work' },
  { id: 'recent', projectId: 'project', title: 'Newest grouped', updatedAt: 20, messages: [], cwd: '/work' },
  { id: 'solo-old', projectId: null, title: 'Older standalone', updatedAt: 2, messages: [], cwd: '/work' },
  { id: 'solo-new', projectId: null, title: 'Newest standalone', updatedAt: 30, messages: [], cwd: '/work' },
], roots: ['/work'], settings: {} };
const peer = { projects: [{ ...project, id: 'peer-project', title: 'Remote work' }], streams: [{ id: 'peer-chat', projectId: 'peer-project', title: 'Remote conversation', updatedAt: 1, cwd: '/remote', messages: [] }], features: ['read-markers', 'idempotent-stream-create'] };
const calls = []; const eventClients = new Set();
const backend = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
  calls.push({ url: req.url, method: req.method, input });
  const json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  if (req.url === '/api/auth') return json({ required: false, authenticated: true });
  if (req.url === '/api/state') return json({ agent: 'Primary Agent', chats: [], backends: { workspaces: 1 } });
  if (req.url === '/api/workspace/capabilities') return json({ workspaces: 1, 'agent-hub': 1 });
  if (req.url === '/api/workspace/agents') return json({ agents: [{ id: 'che', name: 'Che' }] });
  if (req.url === '/api/workspace/state') return json(state);
  if (req.url.startsWith('/api/workspace/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); eventClients.add(res); res.on('close', () => eventClients.delete(res)); return; }
  if (req.url === '/api/workspace/agents/che/request') {
    const { capability, input: action } = input;
    if (capability === 'projects') return json({ projects: peer.projects });
    if (capability === 'streams' && action.action === 'list') return json(peer);
    if (capability === 'streams' && action.action === 'create') { const chat = { id: 'remote-created', projectId: action.projectId, title: action.title, updatedAt: 100, messages: [], cwd: '/remote' }; peer.streams.push(chat); return json(chat); }
    if (capability === 'streams' && action.action === 'move') { peer.streams.find(s => s.id === action.streamId).projectId = action.projectId; return json({ moved: true }); }
    if (capability === 'messages' && action.action === 'read') return json(peer.streams.find(s => s.id === action.streamId));
    if (capability === 'messages' && action.action === 'send') { peer.streams.find(s => s.id === action.streamId).messages.push({ role: 'user', text: action.text }); return json({ accepted: true }); }
    return json({ read: true });
  }
  if (req.url === '/api/workspace/streams' && req.method === 'POST') { const chat = { ...input, id: 'created', cwd: '/work', messages: [], updatedAt: 100 }; state.streams.push(chat); return json(chat); }
  const match = /^\/api\/workspace\/streams\/([^/]+)(\/messages)?$/.exec(req.url);
  if (match) {
    const chat = state.streams.find(s => s.id === match[1]);
    if (req.method === 'GET') return json(chat);
    if (match[2]) { chat.messages.push({ role: 'user', text: input.text }); chat.updatedAt = 101; } else Object.assign(chat, input);
    return json({ ok: true });
  }
  res.statusCode = 404; json({ error: 'Unexpected fixture API' });
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`; const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
const rows = selector => page.locator(selector + ' > .workspace-stream-row > button:first-child').allTextContents();
try {
  await page.goto(origin); await page.getByLabel('Active agent', { exact: true }).waitFor();
  assert.equal(await page.locator('aside select').count(), 0);
  assert.equal(await page.locator('.workspace-screen select[aria-label="Active agent"]').count(), 1);
  assert.ok(await page.locator('[data-agent-id="local"]').isVisible());
  assert.ok(await page.locator('[data-agent-id="che"]').isVisible());
  assert.equal(await page.getByRole('button', { name: 'Chats', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Projects', exact: true }).count(), 0);
  assert.deepEqual(await rows('[data-project-id="project"]'), ['Newest grouped', 'Older grouped']);
  assert.deepEqual(await rows('[data-agent-id="local"] .standalone-chats'), ['Newest standalone', 'Older standalone']);
  await page.getByLabel('Settings for Newest standalone', { exact: true }).click();
  const anchor = await page.getByLabel('Settings for Newest standalone', { exact: true }).boundingBox();
  const menu = await page.getByRole('menu').boundingBox();
  assert.ok(Math.abs(menu.y - (anchor.y + anchor.height)) < 12, 'Menu is anchored to its trigger, not centered');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.getByRole('menuitem', { name: 'Move to project…', exact: true }).click(); await page.getByRole('menuitem', { name: 'Work', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-project-id="project"] [data-stream-id="solo-new"]'));
  assert.deepEqual(await rows('[data-project-id="project"]'), ['Newest standalone', 'Newest grouped', 'Older grouped']);
  await page.getByLabel('Settings for Newest standalone', { exact: true }).click(); await page.getByRole('menuitem', { name: 'Remove from project', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.standalone-chats [data-stream-id="solo-new"]'));
  await page.getByRole('button', { name: 'Newest standalone', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).waitFor(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Details');
  await page.keyboard.press('Escape'); assert.equal(await page.getByRole('menu').count(), 0);
  await page.getByRole('button', { name: '＋ New chat', exact: true }).click(); await page.getByLabel('Next project step').fill('Standalone created without choosing a project'); await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.standalone-chats [data-stream-id="created"]'));
  assert.equal(state.streams.find(s => s.id === 'created').projectId, null);
  await page.getByRole('button', { name: 'Che', exact: true }).click(); await page.getByRole('button', { name: 'Remote conversation', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Newest standalone', exact: true }).count(), 1);
  await page.getByLabel('Settings for Remote conversation', { exact: true }).click();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Open chat', 'Details', 'Export conversation…', 'Refresh chats']);
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export conversation…', exact: true }).click();
  assert.equal((await download).suggestedFilename(), 'conversation-peer-chat.md');
  await page.getByRole('button', { name: 'Remote conversation', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.workspace-screen h1')?.textContent === 'Remote conversation');
  assert.equal((await page.locator('.workspace-content').innerText()).includes('/remote'), false);
  await page.getByLabel('Settings for Remote conversation', { exact: true }).click(); await page.getByRole('menuitem', { name: 'Details', exact: true }).click();
  assert.ok((await page.getByRole('dialog').innerText()).includes('/remote'));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('Next project step').fill('Send only to Che'); await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-content article')].some(e => e.textContent === 'Send only to Che'));
  assert.equal(peer.streams[0].messages[0].text, 'Send only to Che');
  await page.getByRole('button', { name: '＋ New chat', exact: true }).click(); await page.getByLabel('Active agent', { exact: true }).selectOption('che'); await page.getByLabel('Next project step').fill('New remote conversation'); await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
  await page.getByRole('button', { name: 'New remote conversation', exact: true }).waitFor();
  assert.equal(peer.streams.at(-1).messages[0].text, 'New remote conversation');
  await page.getByRole('button', { name: 'Primary Agent', exact: true }).click(); await page.getByRole('button', { name: 'Newest standalone', exact: true }).waitFor();
  await page.getByLabel('Find a conversation').fill('Newest standalone'); assert.deepEqual(await rows('[data-agent-id="local"] .standalone-chats'), ['Newest standalone']);
  await page.getByLabel('Find a conversation').fill('');
  for (const client of eventClients) client.write(`data: ${JSON.stringify(state)}\n\n`);
  assert.equal(await page.locator('aside select').count(), 0);
  assert.ok(!calls.some(c => c.url === '/api/chats' && c.method === 'POST'), 'No hidden parallel legacy chat is created');
  assert.deepEqual(errors, []); await page.screenshot({ path: '/tmp/hayate-unified-conversations.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.getByRole('button', { name: 'Che', exact: true }).isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log('Unified conversations: all agents/projects visible, main-area recipient/project selectors, no mode split, recent ordering, move/unassign, standalone creation, remote selection/send/create, search, SSE and mobile passed.');
} finally { await browser.close(); await dashboard.stop(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
