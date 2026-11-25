import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';

// A message that could not be sent stays in the "New chat" draft. It must never show up in the
// composer of another chat, and it must still be there when the operator comes back.
let failCreate = true; const sends = [];
const backend = createServer(async (req, res) => {
 res.setHeader('content-type', 'application/json');
 const out = value => res.end(JSON.stringify(value));
 if (req.url === '/api/auth') return out({ required: false, authenticated: true });
 if (req.url === '/api/state') return out({ agent: 'Central', backends: { workspaces: 1 }, chats: [] });
 if (req.url === '/api/preferences') return out({ theme: 'green', mode: 'system', hidden: [], name: '' });
 if (req.url === '/api/workspace/capabilities') return out({ workspaces: 1, 'agent-hub': 1, 'local-agent': false, 'project-creation': false });
 if (req.url === '/api/workspace/state') return out({ agent: 'Central', projects: [], streams: [], settings: {} });
 if (req.url === '/api/workspace/agents') return out({ agents: [{ id: 'pi-host', name: 'My PI host', capabilities: ['projects', 'streams', 'messages', 'activity'] }] });
 if (req.url === '/api/workspace/agents/pi-host/request') {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const { capability, input } = JSON.parse(raw);
  if (capability === 'projects') return out({ projects: [], features: ['pi-live-v1'] });
  if (capability === 'activity') return out({ streams: [] });
  if (capability === 'streams' && input.action === 'create') { if (failCreate) { res.statusCode = 503; return out({ error: 'The agent is not connected right now; nothing was sent.' }); } return out({ id: 'created', projectId: null, title: input.title }); }
  if (capability === 'streams') return out({ streams: [{ id: 'old', title: 'Existing PI conversation', projectId: null }], features: ['pi-live-v1', 'standalone-chats', 'idempotent-stream-create'] });
  if (input.action === 'pi' && input.route?.startsWith('/api/pi/dirs')) return out(input.route === '/api/pi/dirs' ? { roots: ['/fixture'] } : { directory: '/fixture', parent: null, entries: [] });
  if (input.action === 'pi' && input.route === '/api/pi/sessions') return out({ roots: ['/fixture'], sessions: [] });
  if (input.action === 'send') { sends.push(input); return out({ accepted: true }); }
  if (input.action === 'read') return out({ id: 'old', title: 'Existing PI conversation', busy: false, messages: [{ id: 'm1', role: 'assistant', text: 'Hello from the old chat' }] });
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
 const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
 await page.goto(origin);
 const editor = page.getByLabel('Next project step');
 await page.getByRole('button', { name: '＋ New chat', exact: true }).click();
 const text = 'Bitte setze ein neues Agentdashboard auf';
 await editor.fill(text);
 // Text typed before the agent is picked must survive picking it (it used to vanish: the draft was keyed by agent).
 await page.getByLabel('Active agent', { exact: true }).selectOption('pi-host');
 assert.equal(await editor.inputValue(), text, 'picking the agent keeps the typed text');
 page.on('dialog', dialog => void dialog.dismiss());
 await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
 const folders = page.getByRole('dialog', { name: 'Choose working directory' });
 await folders.getByRole('button', { name: 'Use this folder', exact: true }).waitFor();
 await page.waitForFunction(() => !document.querySelector('.dir-picker-use')?.disabled);
 await folders.getByRole('button', { name: 'Use this folder', exact: true }).click();
 await page.locator('.workspace-error').filter({ hasText: 'not connected' }).waitFor();
 assert.equal(await editor.inputValue(), text, 'a failed send keeps the text in the new-chat draft');
 // Switch to another chat: its composer must be empty, not carry the unsent text.
 await page.getByRole('button', { name: 'Existing PI conversation', exact: true }).click();
 await page.getByText('Hello from the old chat').waitFor();
 assert.equal(await editor.inputValue(), '', 'the other chat does not show the unsent text');
 // Back to the new chat: the draft is still there.
 await page.getByRole('button', { name: '＋ New chat', exact: true }).click();
 await page.getByLabel('Active agent', { exact: true }).selectOption('pi-host');
 assert.equal(await editor.inputValue(), text, 'the unsent text is back in the new chat');
 assert.deepEqual(errors, []);
 console.log('Unsent text stays with its chat across a chat switch passed.');
} finally { await browser.close(); await dashboard.close?.(); backend.closeAllConnections?.(); backend.close(); }
setTimeout(() => process.exit(process.exitCode ?? 0), 50);
