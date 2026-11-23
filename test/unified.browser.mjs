import { validPng } from './image-fixture.mjs';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createDashboard } from '../server/server.mjs';
import assert from 'node:assert/strict';
const project = { id: 'project', title: 'Work', cwd: '/work', updatedAt: 1, directories: ['/work'] };
const state = { agent: 'Primary Agent', projects: [project], streams: [
  { id: 'old', projectId: 'project', title: 'Older grouped', updatedAt: 1, messages: Array.from({ length: 10000 }, (_, i) => ({ id: `large-${i}`, role: 'user', text: `History ${i}` })), cwd: '/work' },
  { id: 'recent', projectId: 'project', title: 'Newest grouped', updatedAt: 20, messages: [], cwd: '/work' },
  { id: 'solo-old', projectId: null, title: 'Older standalone', updatedAt: 2, messages: [], cwd: '/work' },
  { id: 'solo-new', projectId: null, title: 'Newest standalone', updatedAt: 30, messages: [], cwd: '/work' },
], roots: ['/work'], settings: {} };
const peer = { projects: [{ ...project, id: 'peer-project', title: 'Remote work' }], streams: [{ id: 'peer-chat', projectId: 'peer-project', title: 'Remote conversation', updatedAt: 1, cwd: '/remote', features: ['image-prompt-v1'], messages: [] }], features: ['read-markers', 'idempotent-stream-create'] };
const calls = []; const eventClients = new Set();
let loseNextSendAck = false;
const acceptedSubmissions = new Set();
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
    if (capability === 'streams' && action.action === 'rename') { const chat = peer.streams.find(s => s.id === action.streamId); chat.title = action.title; return json(chat); }
    if (capability === 'streams' && action.action === 'fork') { const source = peer.streams.find(s => s.id === action.streamId); const fork = { ...structuredClone(source), id: 'peer-fork', title: `${source.title} (fork)` }; peer.streams.push(fork); return json(fork); }
    if (capability === 'streams' && action.action === 'move') { peer.streams.find(s => s.id === action.streamId).projectId = action.projectId; return json({ moved: true }); }
    if (capability === 'messages' && action.action === 'media-chunk') return json({ id: 'fixture-image', sha256: 'a'.repeat(64), size: 100 });
    if (capability === 'messages' && action.action === 'read') return json(peer.streams.find(s => s.id === action.streamId));
    if (capability === 'messages' && action.action === 'submission-status') return json({ status: acceptedSubmissions.has(action.id) ? 'accepted' : 'unknown' });
    if (capability === 'messages' && action.action === 'send') {
      acceptedSubmissions.add(action.id);
      peer.streams.find(s => s.id === action.streamId).messages.push({ role: 'user', text: action.text });
      if (loseNextSendAck) { loseNextSendAck = false; res.statusCode = 503; return json({ error: 'fixture lost acknowledgement' }); }
      return json({ accepted: true });
    }
    return json({ read: true });
  }
  if (req.url === '/api/workspace/streams' && req.method === 'POST') { const chat = { ...input, id: 'created', cwd: '/work', messages: [], updatedAt: 100 }; state.streams.push(chat); return json(chat); }
  const forkMatch = /^\/api\/workspace\/streams\/([^/]+)\/fork$/.exec(req.url);
  if (forkMatch && req.method === 'POST') { const source = state.streams.find(s => s.id === forkMatch[1]); const fork = { ...structuredClone(source), id: 'local-fork', title: `${source.title} (fork)` }; state.streams.push(fork); return json(fork); }
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
  // Sidebar action rows, project rows and their disclosure chevrons are shadcn Buttons.
  for (const name of ['＋ New project', 'Agents']) assert.match(await page.getByRole('button', { name, exact: true }).first().getAttribute('class'), /inline-flex.*rounded-md/, `${name} is a shadcn Button`);
  const chevrons = page.locator('.workspace-disclosure');
  assert.ok(await chevrons.count() > 0, 'fixture has project rows with a disclosure chevron');
  assert.match(await chevrons.first().getAttribute('class'), /inline-flex.*rounded-md/, 'disclosure chevron is a shadcn Button');
  for (const row of await page.locator('.workspace-tree summary > button:first-child').all()) { const classes = (await row.getAttribute('class')).split(' '); assert.ok(classes.includes('rounded-md') && classes.includes('justify-start') && classes.includes('min-h-[36px]') && classes.includes('hover:bg-accent'), `every project row is a shadcn ghost Button (${classes.slice(0, 6)})`); }
  await page.locator('[data-agent-id="che"]').waitFor({ state: 'visible' });
  assert.ok(await page.locator('[data-agent-id="che"]').isVisible());
  assert.equal(await page.getByRole('button', { name: 'Chats', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Projects', exact: true }).count(), 0);
  assert.deepEqual(await rows('[data-project-id="project"]'), ['Newest grouped', 'Older grouped']);
  assert.deepEqual(await rows('[data-agent-id="local"] .standalone-chats'), ['Newest standalone', 'Older standalone']);
  await page.getByRole('button', { name: 'Older grouped', exact: true }).click();
  await page.waitForSelector('.history-viewport [data-history-id]');
  assert.ok(await page.locator('.history-viewport [data-history-id]').count() <= 32, 'actual local Hayate chat renders at most32of10000messages');
  await page.locator('.history-viewport').evaluate(element => { const body = element.parentElement; body.scrollTop = 30000; body.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const readingTop = await page.locator('.history-viewport').evaluate(element => element.parentElement.scrollTop);
  for (const client of eventClients) client.write(`data: ${JSON.stringify({ ...state, conversation: state.streams.find(s => s.id === 'old') })}\n\n`);
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.history-viewport').evaluate(element => element.parentElement.scrollTop), readingTop, 'local live refresh preserves older reader scroll position');
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
  await page.getByLabel('Settings for Newest standalone', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename chat', exact: true }).click();
  await page.getByLabel('Chat name', { exact: true }).fill('Renamed standalone');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Renamed standalone', exact: true }).waitFor();
  assert.equal(state.streams.find(s => s.id === 'solo-new').title, 'Renamed standalone');
  await page.getByLabel('Settings for Renamed standalone', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename chat', exact: true }).click();
  await page.getByLabel('Chat name', { exact: true }).fill('Newest standalone');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // Exercise the delivered client against the fork contract. Service-level tests
  // separately verify persistence, runtime context and idempotency.
  state.streams.find(s => s.id === 'solo-new').messages.push({ role: 'user', text: 'Remember the local context' });
  await page.getByLabel('Settings for Newest standalone', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fork chat', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.workspace-screen h1')?.textContent === 'Newest standalone (fork)');
  assert.ok((await page.locator('.workspace-content').innerText()).includes('Remember the local context'));
  await page.getByLabel('Next project step').fill('Local fork only');
  await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-content article')].some(e => e.textContent.includes('Local fork only')));
  assert.equal(state.streams.find(s => s.id === 'solo-new').messages.length, 1);
  assert.equal(state.streams.find(s => s.id === 'local-fork').messages.length, 2);
  const localForkCall = calls.find(c => c.url === '/api/workspace/streams/solo-new/fork');
  assert.ok(localForkCall.input.idempotencyKey);
  await page.getByLabel('Settings for agent Che', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Hide agent from sidebar', exact: true }).click();
  assert.equal(await page.locator('.workspace-agent-group[data-agent-id="che"]').count(), 0);
  await page.reload();
  await page.getByRole('button', { name: 'Hidden items…', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-agent-group[data-agent-id="che"]').count(), 0);
  await page.getByRole('button', { name: 'Hidden items…', exact: true }).click();
  await page.getByRole('button', { name: 'Show agent Che', exact: true }).click();
  // Hash navigation across agents: back from a remote chat to a local project restores the LOCAL context.
  await page.getByRole('button', { name: 'Work', exact: true }).first().click();
  await page.waitForFunction(() => location.hash === '#/project/local/project');
  await page.getByRole('button', { name: 'Che', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/agent/che');
  await page.getByRole('button', { name: 'Remote conversation', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/chat/che/peer-chat');
  await page.goBack(); await page.goBack();
  await page.waitForFunction(() => location.hash === '#/project/local/project');
  assert.equal(await page.getByLabel('Active agent', { exact: true }).inputValue(), 'local', 'local project route restores the local agent, not the previous remote one');
  await page.getByRole('button', { name: '＋ New chat', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/', null, { timeout: 5000 });
  await page.getByRole('button', { name: 'Che', exact: true }).click(); await page.waitForFunction(() => location.hash === '#/agent/che');
  // Hiding a single chat and a whole project, persisted across reload, restorable.
  await page.getByRole('button', { name: 'Che', exact: true }).first().waitFor();
  await page.getByLabel('Settings for Remote conversation', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Hide chat from sidebar', exact: true }).click();
  assert.equal(await page.locator('.workspace-agent-group[data-agent-id="che"] [data-stream-id="peer-chat"]').count(), 0, 'hidden chat leaves the sidebar');
  await page.getByLabel('Settings for Remote work', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Hide project from sidebar', exact: true }).click();
  assert.equal(await page.locator('.workspace-agent-group[data-agent-id="che"] [data-project-id="peer-project"]').count(), 0, 'hidden project leaves the sidebar');
  await page.reload();
  await page.getByRole('button', { name: 'Hidden items…', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-agent-group[data-agent-id="che"] [data-project-id="peer-project"]').count(), 0, 'hidden project stays hidden after reload');
  await page.getByRole('button', { name: 'Hidden items…', exact: true }).click();
  await page.getByRole('button', { name: 'Show project Remote work', exact: true }).click();
  await page.getByRole('button', { name: 'Hidden items…', exact: true }).click();
  await page.getByRole('button', { name: /^Show chat / }).first().click();
  assert.ok(await page.locator('.workspace-agent-group[data-agent-id="che"] [data-project-id="peer-project"]').count() > 0, 'restored project returns');
  await page.getByLabel('New chat with Che', { exact: true }).click();
  assert.equal(await page.getByLabel('Active agent', { exact: true }).inputValue(), 'che');
  assert.equal(await page.getByLabel('Chat project', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: '＋ New chat', exact: true }).click(); await page.getByLabel('Next project step').fill('Standalone created without choosing a project'); await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.standalone-chats [data-stream-id="created"]'));
  assert.equal(state.streams.find(s => s.id === 'created').projectId, null);
  await page.getByRole('button', { name: 'Che', exact: true }).click(); await page.getByRole('button', { name: 'Remote conversation', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Newest standalone', exact: true }).count(), 1);
  await page.getByLabel('Settings for Remote conversation', { exact: true }).click();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Open chat', 'Details', 'Export conversation…', 'Refresh chats', 'Hide chat from sidebar']);
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
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-content article')].some(e => e.querySelector('p')?.textContent === 'Send only to Che'));
  assert.equal(peer.streams[0].messages[0].text, 'Send only to Che');
  await page.getByRole('button', { name: '＋ New chat', exact: true }).click(); await page.getByLabel('Active agent', { exact: true }).selectOption('che'); await page.getByLabel('Next project step').fill('New remote conversation'); await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
  await page.getByRole('button', { name: 'New remote conversation', exact: true }).waitFor();
  assert.equal(peer.streams.at(-1).messages[0].text, 'New remote conversation');
  peer.features.push('rename-streams', 'fork-streams');
  await page.getByRole('button', { name: 'Che', exact: true }).click();
  await page.getByLabel('Settings for Remote conversation', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename chat', exact: true }).click();
  await page.getByLabel('Chat name', { exact: true }).fill('Remote renamed');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Remote renamed', exact: true }).waitFor();
  assert.equal(peer.streams[0].title, 'Remote renamed');
  await page.getByLabel('Settings for Remote renamed', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fork chat', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.workspace-screen h1')?.textContent === 'Remote renamed (fork)');
  assert.ok((await page.locator('.workspace-content').innerText()).includes('Send only to Che'));
  await page.getByLabel('Next project step').fill('Remote fork only');
  await page.locator('input[type=file]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: validPng });
  await page.getByRole('img', { name: 'pixel.png' }).waitFor();
  await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-content article')].some(e => e.textContent.includes('Remote fork only')));
  assert.equal(peer.streams[0].messages.length, 1);
  await page.waitForFunction(() => !document.querySelector('.workspace-composer button[type=submit]')?.disabled);
  assert.equal(peer.streams.find(s => s.id === 'peer-fork').messages.length, 2, JSON.stringify(calls.filter(call => call.input?.input?.action === 'media-chunk' || call.input?.input?.action === 'send').map(call => ({ action: call.input.input.action, hasAttachment: !!call.input.input.attachments?.length }))));
  const mediaSend = calls.find(call => call.input?.input?.action === 'send' && call.input.input.attachments?.length);
  assert.equal(mediaSend.input.input.attachments[0].id, 'fixture-image', 'mounted composer sends staged attachment reference');
  assert.ok(calls.some(call => call.input?.input?.action === 'media-chunk'), 'mounted composer uploads image bytes before send');
  assert.equal(await page.getByRole('img', { name: 'pixel.png' }).count(), 0, 'accepted send clears only its image draft');
  assert.ok(calls.find(c => c.input?.input?.action === 'fork').input.input.idempotencyKey);
  // Accepted input with a lost acknowledgement must reconcile before comparing
  // changed image drafts, and must never resend or clear the new image.
  await page.getByLabel('Next project step').fill('Lost media acknowledgement');
  await page.locator('input[type=file]').setInputFiles({ name: 'accepted.png', mimeType: 'image/png', buffer: validPng });
  loseNextSendAck = true;
  await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.workspace-composer button[type=submit]')?.disabled);
  await page.locator('input[type=file]').setInputFiles({ name: 'new-draft.png', mimeType: 'image/png', buffer: validPng });
  const sendsBeforeReconcile = calls.filter(c => c.input?.input?.action === 'send').length;
  await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.workspace-composer button[type=submit]')?.disabled);
  assert.equal(calls.filter(c => c.input?.input?.action === 'send').length, sendsBeforeReconcile, 'accepted unknown send is not replayed');
  assert.equal(await page.getByRole('img', { name: 'accepted.png', exact: true }).count(), 0);
  assert.equal(await page.getByRole('img', { name: 'new-draft.png', exact: true }).count(), 1, 'new image survives receipt reconciliation');
  await page.getByRole('button', { name: 'Remove new-draft.png', exact: true }).click();
  // Exercise the actual mounted chat under failed background reads. No send
  // request may be replayed; the editor and rendered history remain usable.
  await page.getByLabel('Next project step').fill('Keep this unsent draft');
  const mutationCount = () => calls.filter(c => ['send', 'fork', 'create'].includes(c.input?.input?.action)).length;
  const beforeOutage = mutationCount();
  let failReads = true;
  await page.route('**/api/workspace/agents/che/request', async route => {
    const data = route.request().postDataJSON();
    if (failReads && data?.capability === 'messages' && data.input?.action === 'read') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Temporary fixture outage"}' });
    } else await route.continue();
  });
  const connection = page.getByRole('status').filter({ hasText: 'Connection interrupted' });
  await connection.waitFor({ timeout: 12000 });
  assert.equal(await page.getByLabel('Next project step').inputValue(), 'Keep this unsent draft');
  assert.ok((await page.locator('.workspace-content').innerText()).includes('Remote fork only'), 'outage retains rendered history');
  assert.equal(mutationCount(), beforeOutage, 'failed reads never replay a mutation');
  failReads = false;
  await connection.waitFor({ state: 'hidden', timeout: 15000 });
  assert.equal(await page.getByLabel('Next project step').inputValue(), 'Keep this unsent draft');
  assert.equal(mutationCount(), beforeOutage, 'recovery never replays a mutation');
  await page.unroute('**/api/workspace/agents/che/request');
  await page.getByRole('button', { name: 'Primary Agent', exact: true }).click(); await page.getByRole('button', { name: 'Newest standalone', exact: true }).waitFor();
  await page.getByLabel('Find a conversation').fill('Newest standalone'); assert.deepEqual(await rows('[data-agent-id="local"] .standalone-chats'), ['Newest standalone (fork)', 'Newest standalone']);
  await page.getByLabel('Find a conversation').fill('');
  for (const client of eventClients) client.write(`data: ${JSON.stringify(state)}\n\n`);
  assert.equal(await page.locator('aside select').count(), 0);
  assert.ok(!calls.some(c => c.url === '/api/chats' && c.method === 'POST'), 'No hidden parallel legacy chat is created');
  assert.deepEqual(errors, []); await page.screenshot({ path: '/tmp/hayate-unified-conversations.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.getByRole('button', { name: 'Che', exact: true }).isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log('Unified conversations: all agents/projects visible, main-area recipient/project selectors, no mode split, recent ordering, move/unassign, standalone creation, remote selection/send/create, local/remote rename and context-preserving fork isolation, search, SSE and mobile passed.');
} finally { await browser.close(); await dashboard.stop(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
