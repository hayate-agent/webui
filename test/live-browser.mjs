import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { createDashboard } from '../server/server.mjs';
const reads = [], posts = [], clients = new Set(); let branchMoved = false, openedOnce = false;
const envelope = (seq, kind, data) => ({ v: 1, epoch: 'epoch-1', session: 'chat', seq, kind, data });
const push = frame => { for (const client of clients) client.send(JSON.stringify(frame)); };
const backend = createServer(async (req, res) => {
 const url = new URL(req.url, 'http://fixture');
 const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
 if (url.pathname === '/api/auth') return json({ required: false, authenticated: true });
 if (url.pathname === '/api/state') return json({ agent: 'Central', chats: [], backends: { workspaces: 1 } });
 if (url.pathname === '/api/workspace/capabilities') return json({ workspaces: 1, 'agent-hub': 1, 'local-agent': false, 'browser-live-v1': 1, 'browser-stream-v1': 1 });
 if (url.pathname === '/api/workspace/state') return json({ agent: 'Central', streams: [], projects: [], settings: {} });
 if (url.pathname === '/api/workspace/agents') return json({ agents: [{ id: 'peer', name: 'Remote PI' }] });
 if (url.pathname === '/api/workspace/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
 if (url.pathname === '/api/workspace/agents/peer/read') {
  assert.equal(req.method, 'GET'); const input = JSON.parse(url.searchParams.get('input')); reads.push(input);
  if (url.searchParams.get('capability') === 'projects') return json({ projects: [] });
  if (input.action === 'list') return json({ streams: [{ id: 'chat', title: 'Live chat', projectId: null }], features: ['pi-live-v1'] });
  if (input.action === 'changes') {
   assert.equal(input.epoch, 'epoch-1');
   if (input.since === 2) return json({ epoch: 'epoch-1', events: [envelope(3, 'entry.appended', { message: { id: 'answer', role: 'assistant', text: 'Repaired answer' } })] });
   assert.equal(input.since, 4); return json({ epoch: 'epoch-1', events: [envelope(5, 'entry.appended', { message: { id: 'final', role: 'assistant', text: 'Final answer after dropped event' } })] });
  }
  if (!openedOnce) { openedOnce = true; await new Promise(resolve => setTimeout(resolve, 150)); push({ type: 'event', agentId: 'peer', envelope: envelope(1, 'turn.status', { busy: true }) }); await new Promise(resolve => setTimeout(resolve, 150)); }
  if (branchMoved) return json({ id: 'chat', title: 'Live chat', messages: [{ id: 'other', role: 'assistant', text: 'New branch only' }], stream: { epoch: 'epoch-1', session: 'chat', seq: 7 } });
  return json({ id: 'chat', title: 'Live chat', messages: [{ id: 'hello', role: 'assistant', text: 'Live history' }], stream: { epoch: 'epoch-1', session: 'chat', seq: 0 } });
 }
 if (req.method === 'POST') { posts.push(url.pathname); return json({}); }
 if (req.method === 'HEAD') { reads.push({ unexpected: 'HEAD while WS healthy' }); res.end(); return; }
 res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ noServer: true, handleProtocols: () => 'hayate.workspace.v1' });
backend.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => { clients.add(ws); ws.once('close', () => clients.delete(ws)); }));
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`, dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage(); await page.goto(origin);
 await page.getByRole('button', { name: 'Live chat', exact: true }).click(); await page.getByText('Live history', { exact: true }).waitFor();
 assert.equal(clients.size, 1);
 const count = reads.length; await page.waitForTimeout(5500);
 assert.equal(reads.length, count, 'healthy browser websocket causes no five-second polling');
 assert.equal(posts.length, 0, 'discovery and history do not use POST');
 // seq 1 was delivered while the page was in flight; only seq 2 follows now.
 push({ type: 'event', agentId: 'peer', envelope: envelope(2, 'text.delta', { delta: 'Streaming tokens' }) });
 push({ type: 'event', agentId: 'other', envelope: envelope(3, 'text.delta', { delta: 'Foreign agent' }) });
 await page.getByText('Streaming tokens').waitFor();
 await page.waitForTimeout(300);
 assert.equal(reads.length, count, 'healthy stream: deltas and invalidations cause no GET');
 assert.equal(await page.getByText('Foreign agent').count(), 0, 'events are scoped to the selected agent');
 push({ type: 'event', agentId: 'peer', envelope: envelope(4, 'turn.status', { busy: false }) });
 await page.getByText('Repaired answer', { exact: true }).waitFor();
 assert.deepEqual(reads.slice(count).map(input => input.action), ['changes'], 'a seq gap is repaired by exactly one changes read, not a transcript reload');
 assert.equal(await page.getByText('Streaming tokens').count(), 0, 'settled turn clears the live preview');
 assert.equal(await page.locator('#messages [data-message-id], #messages article').count() <= 32, true);
 // The final event is dropped upstream; only the invalidation arrives.
 const beforeDrop = reads.length;
 push({ type: 'changed', revision: 'third' });
 await page.getByText('Final answer after dropped event', { exact: true }).waitFor();
 assert.deepEqual(reads.slice(beforeDrop).map(input => input.action), ['changes'], 'dropped final event is repaired by one changes read');
 push({ type: 'event', agentId: 'peer', envelope: envelope(6, 'dialog.open', { dialog: { id: 'q1', method: 'confirm', title: 'Deploy now?' } }) });
 await page.getByText('Deploy now?').waitFor();
 await page.getByRole('button', { name: 'Confirm' }).waitFor();
 const beforeReset = reads.length; branchMoved = true;
 push({ type: 'event', agentId: 'peer', envelope: envelope(7, 'history.reset', { reason: 'gap' }) });
 await page.getByText('New branch only', { exact: true }).waitFor();
 assert.equal(await page.getByText('Live history', { exact: true }).count(), 0, 'reset drops messages of the obsolete branch');
 assert.deepEqual(reads.slice(beforeReset).map(input => input.action), ['read'], 'reset loads exactly one bounded page');
 console.log('Browser live: healthy websocket zero interval reads/POST; streamed deltas render without GET; seq gap and dropped final event repaired by one changes read each; streamed questions visible; reset drops obsolete branch.');
} finally { await browser.close(); await dashboard.stop(); for (const c of wss.clients) c.terminate(); wss.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
