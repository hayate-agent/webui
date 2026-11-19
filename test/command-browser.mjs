import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { createDashboard } from '../server/server.mjs';
// Browser commands: healthy WS sends send/stop as acknowledged command frames
// (no POST). A lost acknowledgement falls back to POST with the same opId.
const posts = [], frames = [], clients = new Set(); let dropNextAck = false;
const agents = [{ id: 'peer', name: 'Remote PI', features: ['pi-live-v1'] }];
const backend = createServer(async (req, res) => {
 const url = new URL(req.url, 'http://fixture');
 const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
 if (url.pathname === '/api/auth') return json({ required: false, authenticated: true });
 if (url.pathname === '/api/state') return json({ agent: 'Central', chats: [], backends: { workspaces: 1 } });
 if (url.pathname === '/api/workspace/capabilities') return json({ workspaces: 1, 'agent-hub': 1, 'local-agent': false, 'browser-live-v1': 1, 'browser-commands-v1': 1 });
 if (url.pathname === '/api/workspace/state') return json({ agent: 'Central', streams: [], projects: [], settings: {} });
 if (url.pathname === '/api/workspace/agents') return json({ agents });
 if (url.pathname === '/api/workspace/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
 if (url.pathname === '/api/workspace/agents/peer/read') {
  const input = JSON.parse(url.searchParams.get('input'));
  if (url.searchParams.get('capability') === 'projects') return json({ projects: [] });
  if (input.action === 'list') return json({ streams: [{ id: 'chat', title: 'Live chat', projectId: null }], features: ['pi-live-v1'] });
  if (input.action === 'submission-status') return json({ status: 'unknown' });
  return json({ id: 'chat', title: 'Live chat', busy: true, messages: [{ id: 'hello', role: 'assistant', text: 'History' }] });
 }
 if (req.method === 'POST') { let body = ''; for await (const chunk of req) body += chunk; posts.push({ path: url.pathname, body: JSON.parse(body) }); return json({ accepted: true }); }
 res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ noServer: true, handleProtocols: () => 'hayate.workspace.v1' });
backend.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
 clients.add(ws); ws.once('close', () => clients.delete(ws));
 ws.send(JSON.stringify({ type: 'changed', revision: 'one' }));
 ws.on('message', data => {
  const frame = JSON.parse(data); frames.push(frame);
  if (dropNextAck) { dropNextAck = false; return; }
  ws.send(JSON.stringify({ type: 'ack', opId: frame.opId, ok: true, result: { accepted: true } }));
 });
}));
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`, dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage(); await page.goto(origin);
 await page.getByRole('button', { name: 'Live chat', exact: true }).click(); await page.getByText('History', { exact: true }).waitFor();
 await page.getByLabel('Next project step').fill('Over the socket');
 await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
 await page.waitForFunction(() => !document.querySelector('[aria-label="Next project step"]').value);
 const send = frames.find(frame => frame.input?.action === 'send');
 assert.ok(send, 'send travels as a WebSocket command'); assert.equal(send.input.text, 'Over the socket'); assert.match(send.opId, /^[0-9a-z]{1,11}-[0-9a-f-]{36}$/);
 assert.equal(posts.length, 0, 'healthy socket: no POST for send');
 await page.getByRole('button', { name: 'Stop PI', exact: true }).click();
 await new Promise(resolve => setTimeout(resolve, 300));
 assert.ok(frames.some(frame => frame.input?.route?.endsWith('/abort')), 'stop travels as a WebSocket command');
 assert.equal(posts.length, 0, 'healthy socket: no POST for stop');
 // Lost acknowledgement: the socket closes before the ack. The browser falls
 // back to POST with the SAME opId, which the server ledger deduplicates.
 dropNextAck = true; const before = frames.length;
 await page.getByLabel('Next project step').fill('Ack lost');
 await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
 while (frames.length === before) await new Promise(resolve => setTimeout(resolve, 20));
 for (const client of clients) client.terminate();
 await page.waitForFunction(() => !document.querySelector('[aria-label="Next project step"]').value);
 const lost = frames.at(-1), fallback = posts.find(post => post.body.input?.action === 'send');
 assert.equal(lost.input.text, 'Ack lost'); assert.ok(fallback, 'unacknowledged command falls back to POST');
 assert.equal(fallback.body.opId, lost.opId, 'POST reuses the opId (server dedup, never a second execution)');
 console.log('Browser commands: send/stop over WebSocket with ack, zero POST on healthy socket; lost ack falls back to POST with the same opId.');
} finally { await browser.close(); await dashboard.stop(); for (const c of wss.clients) c.terminate(); wss.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
