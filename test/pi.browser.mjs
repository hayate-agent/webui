import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';
import { createPiService } from '../pi-adapter/service.mjs';
const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-browser-'));
let worker, submitted;
class FixtureOwner extends EventEmitter {
 id = 'browser-rpc'; cwd = directory; dialogs = [];
 respondToDialog(id, answer) { submitted = { type: 'dialog', id, answer }; this.dialogs = this.dialogs.filter(dialog => dialog.id !== id); this.emit('event', { type: 'dialog_answered', id }); return { submitted: true }; }
 async ready() { return { sessionId: this.id }; }
 async snapshot() { return { entries: [{ id: 'hello', parentId: null, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Native PI history' }] } }], leafId: 'hello', busy: false, dialogs: this.dialogs }; }
 async command(type, data) { submitted = { type, data }; return { disposition: 'started' }; }
 async close() { this.emit('exit'); }
}
const pi = await createPiService({ directory, roots: [directory], makeRpc: () => (worker = new FixtureOwner()) });
const central = process.env.PI_WEBUI_CENTRAL_BROWSER_TEST === '1';
const backend = createServer(async (req, res) => {
 res.setHeader('content-type', 'application/json');
 if (req.url === '/api/auth') return res.end('{"required":false,"authenticated":true}');
 if (req.url === '/api/state') return res.end('{"agent":"Hayate fixture","backends":{"workspaces":1},"chats":[]}');
 if (central && req.url === '/api/workspace/agents') return res.end(JSON.stringify({ agents: [{ id: 'pi-host', name: 'Test Mac', capabilities: ['projects', 'messages'] }] }));
 if (central && req.url === '/api/workspace/agents/pi-host/request') {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const frame = JSON.parse(raw);
  if (frame.capability === 'projects') return res.end('{"projects":[],"features":["pi-live-v1"]}');
  const response = await fetch(`http://127.0.0.1:${pi.server.address().port}${frame.input.route}`, { method: frame.input.body === undefined ? 'GET' : 'POST', headers: { origin: `http://127.0.0.1:${pi.server.address().port}`, 'x-hayate-webui': '1', 'content-type': 'application/json' }, body: frame.input.body === undefined ? undefined : JSON.stringify(frame.input.body) });
  res.statusCode = response.status; return res.end(await response.text());
 }
 if (req.url === '/api/workspace/capabilities') return res.end('{"workspaces":1}');
 if (req.url === '/api/workspace/state') return res.end('{"agent":"Hayate fixture","projects":[],"streams":[],"settings":{}}');
 if (req.url.includes('events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
 res.writeHead(404); res.end('{}');
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}`, piUpstream: central ? undefined : `http://127.0.0.1:${pi.server.address().port}` });
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
 await page.goto(origin);
 await page.getByRole('heading', { name: central ? 'PI · Test Mac' : 'Local PI', exact: true }).waitFor();
 await page.getByLabel('Active agent', { exact: true }).waitFor();
 page.once('dialog', dialog => dialog.accept(directory));
 await page.getByRole('button', { name: '＋ New PI session', exact: true }).click();
 await page.getByText('Native PI history', { exact: true }).waitFor();
 const modal = page.locator('dialog[open]');
 await modal.locator('textarea').fill('From the browser');
 await modal.getByRole('button', { name: 'Send', exact: true }).click();
 assert.deepEqual(submitted, { type: 'prompt', data: { message: 'From the browser' } });
 worker.emit('event', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Live owner output' } });
 await page.getByText('Live owner output', { exact: true }).waitFor();
 const stopped = page.waitForResponse(response => response.request().method() === 'POST' && (central ? response.url().endsWith('/pi-host/request') && response.request().postData()?.includes('/abort') : response.url().endsWith('/abort')));
 await modal.getByRole('button', { name: 'Stop PI', exact: true }).click(); await stopped;
 assert.equal(submitted.type, 'abort');
 worker.dialogs = [{ id: 'question', method: 'input', title: 'Name this result' }];
 worker.emit('event', { type: 'extension_ui_request', ...worker.dialogs[0] });
 await modal.getByRole('group', { name: 'Name this result' }).waitFor();
 const question = modal.getByRole('group', { name: 'Name this result' });
 await question.locator('input').fill('Draft survives refresh');
 worker.dialogs.push({ id: 'confirm', method: 'confirm', title: 'Allow operation?' });
 worker.emit('event', { type: 'extension_ui_request', ...worker.dialogs[1] });
 await modal.getByRole('group', { name: 'Allow operation?' }).waitFor();
 assert.equal(await question.locator('input').inputValue(), 'Draft survives refresh');
 await question.getByRole('button', { name: 'Answer PI', exact: true }).click();
 assert.deepEqual(submitted, { type: 'dialog', id: 'question', answer: { value: 'Draft survives refresh' } });
 await modal.getByRole('group', { name: 'Allow operation?' }).getByRole('button', { name: 'Decline', exact: true }).click();
 assert.deepEqual(submitted, { type: 'dialog', id: 'confirm', answer: { confirmed: false } });
 await modal.getByRole('button', { name: 'Close', exact: true }).click();
 assert.equal(await page.getByLabel('Active agent', { exact: true }).isVisible(), true);
 assert.deepEqual(errors, []);
 console.log('PI browser integration: Hayate stays available, create/open/send/live/stop through fixed adapter passed (fixture runtime).');
} finally { await browser.close(); await dashboard.stop(); await pi.stop(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); await rm(directory, { recursive: true, force: true }); }
