import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDashboard } from '../server/server.mjs';
// A running live tool shows `Elapsed` and the number keeps moving without re-rendering the conversation.
const events = [];
const backend = createServer(async (req, res) => {
 res.setHeader('content-type', 'application/json'); const out = value => res.end(JSON.stringify(value));
 if (req.url === '/api/auth') return out({ required: false, authenticated: true });
 if (req.url === '/api/state') return out({ agent: 'Central', backends: { workspaces: 1 }, chats: [] });
 if (req.url === '/api/workspace/capabilities') return out({ workspaces: 1, 'agent-hub': 1 });
 if (req.url === '/api/workspace/state') return out({ agent: 'Central', projects: [], streams: [], settings: {} });
 if (req.url === '/api/workspace/agents') return out({ agents: [{ id: 'pi-host', name: 'My PI host', capabilities: ['projects', 'streams', 'messages', 'activity'] }] });
 if (req.url === '/api/workspace/agents/pi-host/request') {
  let raw = ''; for await (const chunk of req) raw += chunk; const { capability, input } = JSON.parse(raw);
  if (capability === 'projects') return out({ projects: [], features: ['pi-live-v1'] });
  if (capability === 'activity') return out({ streams: [] });
  if (capability === 'streams') return out({ streams: [{ id: 'session', title: 'Working chat', projectId: null }] });
  if (input.action === 'read') return out({ id: 'session', title: 'Working chat', busy: true, messages: [], activity: { text: '', thinking: '', tools: {}, executions: [{ id: 't1', name: 'bash', status: 'running', arguments: 'sleep 30' }] } });
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
 const page = await browser.newPage();
 await page.goto(origin);
 await page.getByRole('button', { name: /Working chat/ }).first().click();
 const time = page.locator('.tui-tool.running .tui-tool-time'); await time.waitFor();
 assert.match(await time.innerText(), /^Elapsed \d/, 'running tool shows Elapsed');
 const first = await time.innerText();
 await page.waitForFunction(text => document.querySelector('.tui-tool.running .tui-tool-time')?.textContent !== text, first, { timeout: 4000 });
 assert.notEqual(await time.innerText(), first, 'Elapsed keeps counting');
 console.log('elapsed browser test passed');
} catch (error) { console.error(error); process.exitCode = 1; } finally { await browser.close(); await dashboard.close?.(); backend.close(); setTimeout(() => process.exit(process.exitCode ?? 0), 50); }
