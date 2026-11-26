import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';

// "My messages": a list of the messages the operator sent in the open chat; click jumps there,
// copy puts the text on the clipboard, older pages load on demand (the DOM stays bounded).
const total = 300, reads = [], forks = [], hayate = []; let eligible = true, failForks = 1;
const mk = i => ({ id: `m${i}`, role: i % 10 === 0 ? 'user' : i % 10 === 5 ? 'toolResult' : 'assistant', toolName: 'bash', text: i % 10 === 0 ? `Question number ${i}` : `Answer ${i} `.repeat(6), timestamp: new Date(Date.UTC(2026, 10, 1, 8, 0, i)).toISOString() });
const pageOf = before => { const end = before ? Number(before.slice(1)) : total; const start = Math.max(0, end - 100); return { id: 'old', title: 'Existing PI conversation', busy: false, messages: Array.from({ length: end - start }, (_, k) => mk(start + k)), before: start > 0 ? `m${start}` : null }; };
const backend = createServer(async (req, res) => {
 res.setHeader('content-type', 'application/json');
 const out = value => res.end(JSON.stringify(value));
 if (req.url === '/api/auth') return out({ required: false, authenticated: true });
 if (req.url === '/api/state') return out({ agent: 'Central', backends: { workspaces: 1 }, chats: [] });
 if (req.url === '/api/preferences') return out({ theme: 'green', mode: 'system', hidden: [], name: '' });
 if (req.url === '/api/workspace/capabilities') return out({ workspaces: 1, 'agent-hub': 1, 'local-agent': false, 'project-creation': false });
 if (req.url === '/api/workspace/state') return out({ agent: 'Central', projects: [], streams: [], settings: {} });
 if (req.url === '/api/workspace/agents') return out({ agents: [{ id: 'pi-host', name: 'My PI host', capabilities: ['projects', 'streams', 'messages', 'activity'] }, { id: 'hayate', name: 'Hayate agent', capabilities: ['projects', 'streams', 'messages', 'activity'] }] });
 if (req.url === '/api/workspace/agents/hayate/request') {
  // A Hayate agent: forks from its own store, has no eligibility check (feature fork-from-message-v1 only).
  let raw = ''; for await (const chunk of req) raw += chunk;
  const { capability, input } = JSON.parse(raw); hayate.push({ capability, ...input });
  const features = ['fork-streams', 'fork-from-message-v1'];
  if (capability === 'projects') return out({ projects: [], features });
  if (capability === 'activity') return out({ streams: [] });
  if (capability === 'streams' && input.action === 'fork') return out({ id: 'h-fork', title: 'Hayate chat (fork)', projectId: null, messages: [], text: 'Question number 30 (from the Hayate agent)' });
  if (capability === 'streams') return out({ streams: [{ id: 'h', title: 'Hayate chat', projectId: null }, ...(hayate.some(call => call.action === 'fork') ? [{ id: 'h-fork', title: 'Hayate chat (fork)', projectId: null }] : [])], features });
  if (input.action === 'read') return out(input.streamId === 'h' ? { id: 'h', title: 'Hayate chat', busy: false, messages: Array.from({ length: 40 }, (_, i) => mk(i)), before: null } : { id: 'h-fork', title: 'Hayate chat (fork)', busy: false, messages: Array.from({ length: 30 }, (_, i) => mk(i)), before: null });
  return out({});
 }
 if (req.url === '/api/workspace/agents/pi-host/request') {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const { capability, input } = JSON.parse(raw);
  if (capability === 'projects') return out({ projects: [], features: ['pi-live-v1'] });
  if (capability === 'activity') return out({ streams: [] });
  if (capability === 'streams' && input.action === 'fork-eligibility') return out(eligible ? { eligible: true } : { eligible: false, reason: 'Wait for the original session to become idle before forking' });
  if (capability === 'streams' && input.action === 'fork') { forks.push(input); if (failForks-- > 0) { res.statusCode = 503; return out({ error: 'The agent is not connected right now; nothing was sent.' }); } return out({ id: 'forked', title: 'Existing PI conversation · Fork', projectId: null, text: 'Question number 230 (from PI)' }); }
  if (capability === 'streams') return out({ streams: [{ id: 'old', title: 'Existing PI conversation', projectId: null }, ...(forks.length ? [{ id: 'forked', title: 'Existing PI conversation · Fork', projectId: null }] : [])], features: ['pi-live-v1', 'standalone-chats', 'idempotent-stream-create', 'chat-fork-v1', 'fork-eligibility-v1', 'fork-from-message-v1'] });
  if (input.action === 'pi' && input.route?.startsWith('/api/pi/dirs')) return out(input.route === '/api/pi/dirs' ? { roots: ['/fixture'] } : { directory: '/fixture', parent: null, entries: [] });
  if (input.action === 'pi' && input.route === '/api/pi/sessions') return out({ roots: ['/fixture'], sessions: [] });
  if (input.action === 'read' && input.streamId === 'forked') return out({ id: 'forked', title: 'Existing PI conversation · Fork', busy: false, messages: Array.from({ length: 23 }, (_, i) => mk(i)).slice(0, 23), before: null });
  if (input.action === 'read') { reads.push(input.before ?? null); return out(pageOf(input.before)); }
  if (input.action === 'submission-status') return out({ status: 'unknown' });
  return out({});
 }
 if (req.url.includes('events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write(': ready\n\n'); }
 res.writeHead(404); res.end('{}');
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true });
try {
 const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
 await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
 const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
 await page.goto(origin);
 const button = page.getByRole('button', { name: 'My messages: jump to a message I sent' });
 assert.equal(await button.isVisible(), false, 'no shortcut without an open chat');
 await page.getByRole('button', { name: 'Existing PI conversation', exact: true }).click();
 await page.getByText('Answer 299').waitFor();
 await button.waitFor();
 await button.click();
 const dialog = page.getByRole('dialog', { name: 'My messages' });
 await dialog.waitFor();
 const open = dialog.locator('.my-messages-open');
 assert.equal(await open.count(), 10, 'only the loaded page (messages 200-299) is listed: 10 sent messages');
 assert.ok((await open.first().textContent()).includes('Question number 200'));
 // Click: the dialog closes and the message is visible, with a bounded DOM.
 await open.nth(3).click();
 await page.waitForFunction(() => !document.querySelector('.my-messages-list'));
 const target = page.locator('[data-history-id="m230"]');
 await target.waitFor();
 const place = await page.locator('.workspace-content').evaluate(node => { const row = node.querySelector('[data-history-id="m230"]'); return row.getBoundingClientRect().top - node.getBoundingClientRect().top; });
 assert.ok(place >= -2 && place < 300, `clicked message is at the top of the view (offset ${place})`);
 assert.ok(await page.locator('[data-history-id]').count() <= 40, 'DOM stays bounded after the jump');
 // Copy puts exactly the message text on the clipboard.
 await button.click(); await dialog.waitFor();
 await dialog.locator('.my-messages-copy').nth(1).click();
 assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Question number 210');
 // Older messages load on demand and their sent messages are added to the list.
 await dialog.getByRole('button', { name: 'Load earlier messages' }).click();
 await page.waitForFunction(() => document.querySelectorAll('.my-messages-open').length === 20);
 assert.deepEqual(reads, [null, 'm200'], 'one extra page was requested, not the whole history');
 assert.equal(await dialog.getByRole('button', { name: 'Load earlier messages' }).isVisible(), true, 'more pages exist: the button is offered');
 await dialog.getByRole('button', { name: 'Load earlier messages' }).click();
 await page.waitForFunction(() => document.querySelectorAll('.my-messages-open').length === 30);
 assert.equal(await dialog.getByRole('button', { name: 'Load earlier messages' }).isVisible(), false, 'everything is loaded: no button');
 assert.deepEqual(reads, [null, 'm200', 'm100']);
 await dialog.locator('.my-messages-open').first().click();
 await page.locator('[data-history-id="m0"]').waitFor();
 // Fork from a message: refused while the chat is busy (the reason is shown, nothing is created).
 eligible = false;
 await button.click(); await dialog.waitFor();
 await dialog.locator('.my-messages-item', { has: page.locator('[data-message-id="m230"]') }).locator('.my-messages-fork').click();
 await dialog.getByText('Wait for the original session to become idle before forking').waitFor();
 assert.equal(forks.length, 0, 'no fork was requested while busy');
 eligible = true;
 // The first attempt hits a lost connection: the dialog stays open with the reason, and the retry reuses the same identity (no second fork).
 await dialog.locator('.my-messages-item', { has: page.locator('[data-message-id="m230"]') }).locator('.my-messages-fork').click();
 await dialog.getByText('not connected').waitFor();
 assert.equal(forks.length, 1);
 // Allowed: the chosen message id travels to the agent, the new chat opens with the text ready to change.
 await dialog.locator('.my-messages-item', { has: page.locator('[data-message-id="m230"]') }).locator('.my-messages-fork').click();
 await page.getByRole('heading', { name: 'Existing PI conversation · Fork' }).waitFor();
 assert.equal(forks.length, 2); assert.equal(forks[1].entryId, 'm230'); assert.equal(forks[1].idempotencyKey, forks[0].idempotencyKey, 'a retry reuses the same identity'); assert.equal(forks[1].streamId, 'old'); assert.match(forks[1].idempotencyKey, /^[0-9a-f-]{36}$/);
 assert.equal(await page.getByLabel('Next project step').inputValue(), 'Question number 230 (from PI)', 'the message text is ready in the composer of the fork');
 await page.getByRole('button', { name: 'Existing PI conversation', exact: true }).click();
 await page.getByRole('heading', { name: 'Existing PI conversation', exact: true }).waitFor();
 assert.equal(await page.getByLabel('Next project step').inputValue(), '', 'the original chat composer is untouched');
 // A Hayate agent has no eligibility check: the fork works without one and still carries the message id.
 await page.getByRole('button', { name: 'Hayate chat', exact: true }).click();
 await page.getByRole('heading', { name: 'Hayate chat', exact: true }).waitFor();
 await page.getByText('Question number 0', { exact: true }).waitFor();
 await button.click(); await dialog.waitFor();
 await dialog.locator('.my-messages-item', { has: page.locator('[data-message-id="m30"]') }).locator('.my-messages-fork').click();
 await page.getByRole('heading', { name: 'Hayate chat (fork)' }).waitFor();
 const hayateFork = hayate.filter(call => call.action === 'fork');
 assert.equal(hayateFork.length, 1); assert.equal(hayateFork[0].entryId, 'm30'); assert.equal(hayateFork[0].streamId, 'h');
 assert.equal(hayate.some(call => call.action === 'fork-eligibility'), false, 'no eligibility request to an agent that does not have one');
 assert.equal(await page.getByLabel('Next project step').inputValue(), 'Question number 30 (from the Hayate agent)');
 // Not shown in the new-chat view.
 await page.getByRole('button', { name: '＋ New chat', exact: true }).click();
 assert.equal(await button.isVisible(), false, 'no shortcut in a new chat');
 assert.deepEqual(errors, []);
 console.log('My messages: list, jump, copy and on-demand older pages passed.');
} finally { await browser.close(); await dashboard.close?.(); backend.closeAllConnections?.(); backend.close(); }
setTimeout(() => process.exit(process.exitCode ?? 0), 50);
