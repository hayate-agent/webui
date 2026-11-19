import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';
let submitted, created, forkRequest, archived = false, aborted = false;
let added = false, renamed, rolled = false, releaseSend, delivered = false;
const chats = Array.from({ length: 45 }, (_, index) => ({ id: `session-${index}`, title: `PI session ${index}`, projectId: null }));
const backend = createServer(async (req, res) => {
 res.setHeader('content-type', 'application/json');
 const out = value => res.end(JSON.stringify(value));
 if (req.url === '/api/auth') return out({ required: false, authenticated: true });
 if (req.url === '/api/state') return out({ agent: 'Central', backends: { workspaces: 1 }, chats: [] });
 if (req.url === '/api/workspace/capabilities') return out({ workspaces: 1, 'agent-hub': 1, 'local-agent': false, 'project-creation': false });
 if (req.url === '/api/workspace/state') return out({ agent: 'Central', projects: [], streams: [], settings: {} });
 if (req.url === '/api/workspace/agents') return out({ agents: [{ id: 'pi-host', name: 'My PI host', capabilities: ['projects', 'streams', 'messages', 'activity'] }] });
 if (req.url === '/api/workspace/agents/pi-host/request') {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const { capability, input } = JSON.parse(raw);
  if (capability === 'projects') return out({ projects: [], features: ['pi-live-v1'] });
  if (capability === 'activity') return out({ streams: [] });
  if (capability === 'streams' && input.action === 'fork') { forkRequest = input; chats.push({ id: 'forked-session', title: 'Chosen PI session · Fork', projectId: null }); return out({ id: 'forked-session', title: 'Chosen PI session · Fork', projectId: null }); }
  if (capability === 'streams' && input.action === 'create') { created = input; return out({ id: 'session', projectId: null, title: input.title }); }
  if (input.action === 'pi' && input.route === '/api/pi/sessions') return out({ roots: ['/fixture/project'], sessions: [] });
  if (input.action === 'pi-chats' && input.operation === 'list') return out({ sessions: [{ id: 'chosen', name: 'Chosen PI session', cwd: '/fixture/project', owner: 'tui', chatStatus: 'unselected' }] });
  if (input.action === 'pi-chats' && input.operation === 'preview') return out({ messages: [{ role: 'user', text: 'Investigate build warnings' }, { role: 'assistant', text: 'Found the compiler issue' }] });
  if (input.action === 'pi-chats' && input.operation === 'rename') { renamed = input.name; return out({ renamed: true }); }
  if (input.action === 'pi-chats' && input.operation === 'set') { if (input.status === 'active') added = true; else archived = true; return out({ updated: true }); }
  if (capability === 'streams') return out({ streams: [...chats, ...(!archived ? [{ id: 'session', title: 'Existing PI conversation', projectId: null }] : []), ...(added ? [{ id: 'chosen', title: 'Chosen PI session', projectId: null }] : [])], features: ['pi-live-v1', 'standalone-chats', 'idempotent-stream-create', 'pi-chat-bindings', 'chat-fork-v1'] });
  if (input.action === 'read' && delivered) return out({ id: 'session', title: 'Existing PI conversation', messages: [{ id: 'delivered-followup', role: 'user', text: 'Continue in the same session' }] });
  if (input.action === 'read' && input.streamId !== 'session') return out({ id: input.streamId, title: 'Other chat', busy: false, before: null, messages: [{ id: 'other-1', role: 'assistant', text: 'Body of the other chat' }] });
  if (input.action === 'read' && !input.before && globalThis.slowReads) await new Promise(resolve => setTimeout(resolve, 2500));
  if (input.action === 'read') return out({ id: 'session', title: 'Existing PI conversation', busy: false, before: input.before ? null : 'call', messages: rolled ? [{ id: 'latest', role: 'assistant', text: 'New output after context window rolled' }] : input.before ? [{ id: 'old', role: 'user', text: 'Earlier question' }] : [{ id: 'call', role: 'assistant', text: 'Inspecting your project\n\n## Findings\n\n- First finding\n- Second finding\n\n```js\nconst answer = 42;\n```\n\n| Item | Status |\n| --- | --- |\n| Build | Ready |', thinking: 'Checking project dependencies first', toolCalls: [{ id: 'tool', name: 'read', arguments: { path: 'README.md' } }] }, { id: 'result', role: 'toolResult', toolName: 'read', toolCallId: 'tool', text: 'README contents' }] });
  if (input.action === 'submission-status') return out({ status: input.streamId === 'session-0' ? 'accepted' : 'unknown' });
 if (input.action === 'send') { submitted = input; if (input.text === 'Delayed followup acknowledgement') await new Promise(resolve => { releaseSend = resolve; }); if (!input.mode) { res.statusCode = 409; return out({ error: 'PI busy: choose steer or followUp explicitly' }); } return out({ disposition: 'started' }); }
  if (input.action === 'pi' && input.route.endsWith('/abort')) { aborted = true; return out({ stopped: true }); }
 }
 if (req.url.includes('events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write(': ready\n\n'); }
 res.writeHead(404); res.end('{}');
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
let legacy = false;
const upstream = backend.listeners('request')[0];
backend.removeAllListeners('request');
backend.on('request', (req, res) => {
 if (legacy && req.url === '/api/state') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ agent: 'Legacy', backends: {}, chats: [{ id: 'old-chat', title: 'Legacy conversation', updatedAt: 1 }] })); }
 if (legacy && req.url.startsWith('/api/chats')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ id: 'old-chat', title: 'Legacy conversation', messages: [] })); }
 return upstream(req, res);
});
const browser = await chromium.launch({ headless: true });
try {
 const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
 const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
 await page.goto(origin);
 await page.getByRole('button', { name: /Existing PI conversation/ }).first().click();
 await page.locator('.workspace-content article').first().waitFor();
 // 4. Hash navigation: the address names the selection.
 const hash = await page.evaluate(() => location.hash);
 assert.equal(hash, '#/chat/pi-host/session', 'selecting a chat writes a stable address');
 await page.getByRole('button', { name: /PI session 1$/ }).first().click();
 await page.waitForFunction(() => location.hash === '#/chat/pi-host/session-1');
 await page.goBack();
 await page.waitForFunction(() => location.hash === '#/chat/pi-host/session');
 await page.waitForFunction(() => document.querySelector('.workspace-screen h1')?.textContent === 'Existing PI conversation');
 await page.goForward();
 await page.waitForFunction(() => location.hash === '#/chat/pi-host/session-1');
 // Reload restores the conversation named by the address.
 await page.goto(origin + '/#/chat/pi-host/session'); await page.reload();
 await page.waitForFunction(() => document.querySelector('.workspace-screen h1')?.textContent === 'Existing PI conversation', null, { timeout: 15000 });
 await page.locator('.workspace-content article').first().waitFor();
 // 3. Cache: with slow authoritative reads a revisited chat still shows its messages at once.
 await page.getByRole('button', { name: /PI session 1$/ }).first().click();
 await page.waitForFunction(() => location.hash === '#/chat/pi-host/session-1');
 await page.waitForFunction(() => document.querySelector('.workspace-content')?.textContent.includes('Body of the other chat'));
 globalThis.slowReads = true;
 const started = Date.now();
 await page.getByRole('button', { name: /Existing PI conversation/ }).first().click();
 await page.waitForFunction(() => document.querySelector('.workspace-content')?.textContent.includes('Inspecting your project'), null, { timeout: 1800 });
 const paintMs = Date.now() - started;
 assert.ok(paintMs < 1800, `cached chat paints before the live read (took ${paintMs}ms, live read needs 2500ms)`);
 globalThis.slowReads = false;
 assert.deepEqual(errors, []);
 console.log(`Navigation + cache: stable #/chat addresses, back/forward/reload restore, cached chat painted in ${paintMs}ms.`);
} finally { await browser.close(); await dashboard.stop(); backend.close(); }
