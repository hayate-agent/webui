import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createDashboard } from '../server/server.mjs';
import assert from 'node:assert/strict';
const backend = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/auth') res.end('{"required":false,"authenticated":true}');
  else if (req.url === '/api/state') res.end(JSON.stringify({ agent: 'Fixture agent', backends: { workspaces: 1 }, chats: [] }));
  else if (req.url === '/api/workspace/capabilities') res.end('{"workspaces":1}');
  else if (req.url === '/api/workspace/state') res.end(JSON.stringify({ agent: 'Fixture agent', projects: [], streams: [], roots: ['/work'], settings: {} }));
  else if (req.url.startsWith('/api/') && req.url.includes('events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); }
  else { res.statusCode = 404; res.end('{}'); }
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`; const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(origin); await page.getByLabel('Active agent', { exact: true }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Projects and streams' }).isVisible(), true);
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click(); await page.getByRole('menuitem', { name: 'Global settings', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Independent dashboard: served bundle, fixed API proxy, default workspace, agent picker and menus passed.');
} finally { await browser.close(); await dashboard.stop(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
