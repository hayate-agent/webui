// The dashboard bundle is served by the real dashboard server, is NOT loaded at start, and loads
// and renders under the real CSP when first needed.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createDashboard } from '../server/server.mjs';
import assert from 'node:assert/strict';

const backend = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true });
let failed = false;
try {
  const page = await browser.newPage();
  const requested = [], problems = [];
  page.on('request', request => requested.push(new URL(request.url()).pathname));
  page.on('console', message => { if (/Content Security Policy/i.test(message.text())) problems.push(message.text().slice(0, 160)); });
  page.on('pageerror', error => problems.push(String(error).slice(0, 160)));
  await page.goto(origin); await page.waitForSelector('[data-shell]');
  assert.ok(requested.includes('/app.js'), 'app.js was loaded');
  assert.ok(!requested.includes('/dashboard.js'), 'the dashboard bundle is not loaded at start');
  const appBytes = (await (await page.request.get(`${origin}/app.js`)).body()).length;
  assert.ok(appBytes < 1000 * 1024, `app.js stays small (it is ${Math.round(appBytes / 1024)} KiB; OpenUI belongs in dashboard.js)`);
  const served = await page.request.get(`${origin}/dashboard.js`);
  assert.equal(served.status(), 200); assert.match(served.headers()['content-type'], /text\/javascript/);
  const rendered = await page.evaluate(async () => {
    const module = await import('/dashboard.js');
    const host = document.createElement('div'); document.body.append(host);
    module.mountDashboard(host, { source: 'root = Stack([Metric("Open", 3)])', mode: 'strict', tools: [], call: async () => ({}), confirm: async () => false });
    await new Promise(resolve => setTimeout(resolve, 300));
    return { text: host.textContent };
  });
  assert.match(rendered.text, /Open/); assert.match(rendered.text, /3/);
  assert.ok(requested.includes('/dashboard.js'), 'the bundle loaded on demand');
  assert.equal(problems.length, 0, 'no CSP violation or page error: ' + problems.join(' | '));
  console.log('Dashboard chunk test passed');
} catch (error) { console.error(error); failed = true; }
finally { await browser.close(); await dashboard.stop(); backend.closeAllConnections(); backend.close(); process.exit(failed ? 1 : 0); }
