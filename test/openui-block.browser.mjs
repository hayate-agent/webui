// An assistant message with an ```openui fence shows live UI; the bundle loads only then; every
// other code fence stays code; a failing bundle leaves the program visible as code.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';

const text = 'Status:\n\n```openui\nroot = Stack([Metric("Open tickets", 7), Tag("late", "destructive")])\n```\n\nAnd code:\n\n```js\nconst a = 1;\n```';
const plain = 'Only code:\n\n```js\nconst b = 2;\n```';
let which = 'dash';
const backend = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json'); const out = value => res.end(JSON.stringify(value));
  if (req.url === '/api/auth') return out({ required: false, authenticated: true });
  if (req.url === '/api/state') return out({ agent: 'Central', backends: { workspaces: 1 }, chats: [] });
  if (req.url === '/api/workspace/capabilities') return out({ workspaces: 1, 'agent-hub': 1 });
  if (req.url === '/api/workspace/state') return out({ agent: 'Central', projects: [], streams: [], settings: {} });
  if (req.url === '/api/workspace/agents') return out({ agents: [{ id: 'pi-host', name: 'My PI host', capabilities: ['projects', 'streams', 'messages', 'activity'] }] });
  if (req.url === '/api/workspace/agents/pi-host/request') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const { capability, input } = JSON.parse(raw);
    if (capability === 'projects') return out({ projects: [], features: ['pi-live-v1'] });
    if (capability === 'activity') return out({ streams: [] });
    if (capability === 'streams') return out({ streams: [{ id: 'dash', title: 'Dash chat', projectId: null }, { id: 'plain', title: 'Plain chat', projectId: null }] });
    if (input.action === 'read') { const id = input.id ?? input.streamId ?? 'dash'; const body = id === 'plain' ? plain : text; return out({ id, title: id === 'plain' ? 'Plain chat' : 'Dash chat', busy: false, messages: [{ id: 'm-' + id, role: 'assistant', text: body }] }); }
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
  const page = await browser.newPage(); const problems = [], requested = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => { if (/Content Security Policy/i.test(message.text())) problems.push(message.text().slice(0, 160)); });
  page.on('request', request => requested.push(new URL(request.url()).pathname));
  await page.goto(origin);
  await page.getByRole('button', { name: /Plain chat/ }).first().click();
  await page.locator('.bui-code-block').first().waitFor();
  assert.ok(!requested.includes('/dashboard.js'), 'no dashboard bundle for a chat without an openui block');
  assert.equal(await page.locator('.openui-block').count(), 0);
  await page.getByRole('button', { name: /Dash chat/ }).first().click();
  await page.locator('.openui-block[data-openui="live"]').waitFor({ timeout: 10000 });
  assert.ok(requested.includes('/dashboard.js'), 'the bundle loaded on demand');
  const block = page.locator('.openui-block'); assert.match(await block.innerText(), /Open tickets/); assert.match(await block.innerText(), /7/);
  assert.match(await block.locator('[data-metric="Open tickets"]').evaluate(e => e.parentElement.className), /border/, 'built from shadcn classes');
  assert.equal(await page.locator('.bui-code-block', { hasText: 'const a = 1' }).count(), 1, 'a normal fence stays code');
  assert.equal(await page.locator('.bui-code-block', { hasText: 'root = Stack' }).count(), 0, 'the openui program is replaced by its rendering');
  assert.deepEqual(problems, [], 'no CSP violation or page error');
  // Failure: the bundle cannot be loaded -> the program stays visible as code.
  const failing = await browser.newPage(); const failProblems = [];
  failing.on('pageerror', error => failProblems.push(error.message));
  await failing.route('**/dashboard.js', route => route.abort());
  await failing.goto(origin);
  await failing.getByRole('button', { name: /Dash chat/ }).first().click();
  await failing.locator('.openui-block[data-openui="failed"]').waitFor({ timeout: 10000 });
  assert.equal(await failing.locator('.bui-code-block', { hasText: 'root = Stack' }).count(), 1, 'program stays visible as code when the bundle fails');
  assert.deepEqual(failProblems, []);
  // Navigating away releases the block at once (no second block needed to trigger cleanup).
  await page.getByRole('button', { name: /Plain chat/ }).first().click();
  await page.waitForFunction(() => !document.querySelector('.openui-block'));
  // The React root of a block that left the page is released at once (fake bundle counts unmount calls).
  const counting = await browser.newPage();
  await counting.route('**/dashboard.js', route => route.fulfill({ contentType: 'text/javascript', body: 'export function mountDashboard(host) { host.textContent = "fake"; window.__mounted = (window.__mounted ?? 0) + 1; return { update() {}, unmount() { window.__unmounted = (window.__unmounted ?? 0) + 1; } }; }' }));
  await counting.goto(origin);
  await counting.getByRole('button', { name: /Dash chat/ }).first().click();
  await counting.waitForFunction(() => window.__mounted === 1);
  assert.equal(await counting.evaluate(() => window.__unmounted ?? 0), 0);
  await counting.getByRole('button', { name: /Plain chat/ }).first().click();
  await counting.waitForFunction(() => window.__unmounted === 1, undefined, { timeout: 5000 });
  // A bundle whose mount throws leaves the program visible as code.
  const broken = await browser.newPage(); const brokenProblems = [];
  broken.on('pageerror', error => brokenProblems.push(error.message));
  await broken.route('**/dashboard.js', route => route.fulfill({ contentType: 'text/javascript', body: 'export function mountDashboard() { throw new Error("boom"); }' }));
  await broken.goto(origin);
  await broken.getByRole('button', { name: /Dash chat/ }).first().click();
  await broken.locator('.openui-block[data-openui="failed"]').waitFor({ timeout: 10000 });
  assert.equal(await broken.locator('.bui-code-block', { hasText: 'root = Stack' }).count(), 1, 'program stays visible as code when mounting throws');
  assert.deepEqual(brokenProblems, []);
  console.log('openui block browser test passed');
} catch (error) { console.error(error); process.exitCode = 1; } finally { await browser.close(); await dashboard.stop(); backend.closeAllConnections(); backend.close(); setTimeout(() => process.exit(process.exitCode ?? 0), 50); }
