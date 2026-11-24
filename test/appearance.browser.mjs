import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';
import { applyLocal, DEFAULTS } from '../dashboard/public/preferences.js';
// Real built page against a backend with the server-side /api/preferences: two browsers (separate profiles = "two machines")
// must see the same palette, titles and hidden sidebar items; the legacy localStorage values migrate once.
const stream = { id: 's1', projectId: null, title: 'Chat eins', updatedAt: 2, messages: [], cwd: '/w' };
const stream2 = { id: 's2', projectId: null, title: 'Chat zwei', updatedAt: 1, messages: [], cwd: '/w' };
const state = { agent: 'a', projects: [], streams: [stream, stream2], roots: ['/w'], settings: {} };
let prefs = { ...DEFAULTS }, posts = [], preferencesRoute = true;
const backend = createServer(async (req, res) => {
  const json = (body, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  let data = ''; for await (const part of req) data += part;
  if (req.url === '/api/auth') return json({ required: false, authenticated: true });
  if (req.url === '/api/state') return json({ agent: 'a', chats: [], backends: { workspaces: 1 }, ui: { theme: 'system', title: 'Hayate', placeholder: 'x', workArea: 'auto', workAreaRows: 3, panels: [], actions: [] } });
  if (req.url === '/api/workspace/capabilities') return json({ workspaces: 1 });
  if (req.url === '/api/workspace/state') return json(state);
  if (req.url.startsWith('/api/workspace/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
  if (req.url === '/api/preferences' && preferencesRoute) {
    if (req.method === 'GET') return json(prefs);
    const patch = JSON.parse(data); posts.push(patch); prefs = { ...applyLocal(prefs, patch), revision: prefs.revision + 1 }; return json(prefs);
  }
  res.writeHead(404); res.end('{}');
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true });
const look = page => page.evaluate(() => ({ palette: document.body.dataset.palette, mode: document.body.dataset.theme ?? null, title: document.title, brand: document.getElementById('brand-name')?.textContent, accent: getComputedStyle(document.body).getPropertyValue('--accent').trim() }));
try {
  // Machine A: old browser state in localStorage migrates once, then everything is changed through the Appearance dialog.
  const a = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  await a.addInitScript(() => { if (!localStorage.getItem('seeded')) { localStorage.setItem('seeded', '1'); localStorage.setItem('workspace.hidden-agents', JSON.stringify(['chat:local:s2'])); localStorage.setItem('hayate.webui.theme', 'dark'); } });
  await a.goto(origin); await a.waitForSelector('.workspace-stream-row');
  assert.deepEqual(prefs.hidden, ['chat:local:s2'], 'the old local hidden list went to the server');
  assert.equal(prefs.mode, 'dark', 'the old dark choice went to the server');
  assert.equal(await a.evaluate(() => localStorage.getItem('workspace.hidden-agents')), null, 'old key removed after migration');
  assert.equal(await a.getByText('Chat zwei').count(), 0, 'hidden chat is not listed');
  assert.deepEqual(await look(a), { palette: 'green', mode: 'dark', title: 'Hayate · WebUI', brand: 'hayate', accent: '#98ceaf' });
  const greenBg = await a.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await a.locator('#brand-name').waitFor();
  // The workspace header menu has "Appearance".
  await a.getByRole('button', { name: 'Workspace settings' }).click(); await a.getByRole('menuitem', { name: 'Appearance' }).click();
  await a.getByRole('button', { name: 'Blue', exact: true }).click();
  await a.waitForFunction(() => document.body.dataset.palette === 'blue');
  const blue = await look(a); assert.equal(blue.accent, '#8db4ea', 'blue dark accent');
  assert.notEqual(await a.evaluate(() => getComputedStyle(document.body).backgroundColor), greenBg, 'the background really changed');
  assert.equal(await a.getByRole('button', { name: 'Blue', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await a.getByRole('button', { name: 'Green', exact: true }).getAttribute('aria-pressed'), 'false');
  await a.getByLabel('Page title (browser tab)').fill('Arbeit'); await a.getByLabel('Name in the page header').fill('karsten'); await a.getByRole('button', { name: 'Save names' }).click();
  await a.waitForFunction(() => document.title === 'Arbeit' && document.getElementById('brand-name').textContent === 'karsten');
  assert.deepEqual({ theme: prefs.theme, pageTitle: prefs.pageTitle, headerTitle: prefs.headerTitle }, { theme: 'blue', pageTitle: 'Arbeit', headerTitle: 'karsten' });
  await a.keyboard.press('Escape');
  // Machine B: a fresh profile (empty localStorage) sees the same without doing anything.
  const b = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  await b.goto(origin); await b.waitForSelector('.workspace-stream-row');
  assert.deepEqual(await look(b), { palette: 'blue', mode: 'dark', title: 'Arbeit', brand: 'karsten', accent: '#8db4ea' });
  assert.equal(await b.getByText('Chat zwei').count(), 0, 'B shows the same sidebar: the chat hidden on A stays hidden');
  // Hiding on B reaches A after a reload; showing again via the dialog works too.
  await b.getByLabel('Settings for Chat eins').click();
  await b.getByRole('menuitem', { name: 'Hide chat from sidebar' }).click();
  await b.waitForFunction(() => !document.body.textContent.includes('Chat eins'));
  assert.deepEqual(prefs.hidden, ['chat:local:s1', 'chat:local:s2'], 'hiding on B is stored per item on the server');
  await a.reload(); await a.waitForSelector('#brand-name'); await a.waitForFunction(() => !document.body.textContent.includes('Chat eins'));
  // Clearing a title returns to the default.
  await a.getByRole('button', { name: 'Workspace settings' }).click(); await a.getByRole('menuitem', { name: 'Appearance' }).click();
  await a.getByLabel('Page title (browser tab)').fill(''); await a.getByLabel('Name in the page header').fill(''); await a.getByRole('button', { name: 'Save names' }).click();
  await a.waitForFunction(() => document.title === 'Hayate · WebUI' && document.getElementById('brand-name').textContent === 'hayate');
  // A palette change made after the titles is stored as well.
  await a.getByRole('button', { name: 'Red', exact: true }).click(); await a.waitForFunction(() => document.body.dataset.palette === 'red'); assert.equal(prefs.theme, 'red');
  // Backend without the route: the page keeps working with its own cache.
  preferencesRoute = false;
  const c = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  await c.goto(origin); await c.waitForSelector('.workspace-stream-row');
  assert.deepEqual(await look(c), { palette: 'green', mode: null, title: 'Hayate · WebUI', brand: 'hayate', accent: '#266453' }, 'page still loads with the defaults');
  assert.ok(await c.getByText('Chat eins').count() > 0, 'nothing is hidden without server preferences');
  console.log('appearance ok');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await browser.close(); backend.closeAllConnections?.(); setTimeout(() => process.exit(process.exitCode ?? 0), 50); }
