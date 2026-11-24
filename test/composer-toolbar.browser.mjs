import { chromium } from 'playwright';
import assert from 'node:assert/strict';
// Composer toolbar on tablets and desktops: one line, the buttons are icons (named by aria-label/title), and the keyboard hint
// is either one line or hidden - it must never squeeze into a one-word column that makes the toolbar six lines high.
import { createServer } from 'node:http';
import { createDashboard } from '../server/server.mjs';
const stream = { id: 's1', projectId: null, title: 'Chat', updatedAt: 1, messages: [], cwd: '/w', pi: true };
const state = { agent: 'a', projects: [], streams: [stream], roots: ['/w'], settings: {} };
const backend = createServer(async (req, res) => {
  const json = b => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); };
  for await (const _ of req);
  if (req.url === '/api/auth') return json({ required: false, authenticated: true });
  if (req.url === '/api/state') return json({ agent: 'a', chats: [], backends: { workspaces: 1 } });
  if (req.url === '/api/workspace/capabilities') return json({ workspaces: 1 });
  if (req.url === '/api/workspace/state') return json(state);
  if (req.url === '/api/preferences') return json({ theme: 'green', mode: 'system', pageTitle: '', headerTitle: '', hidden: [], revision: 0 });
  if (req.url.startsWith('/api/workspace/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
  res.writeHead(404); res.end('{}');
});
await new Promise(r => backend.listen(0, '127.0.0.1', r));
const rs = createServer(); await new Promise(r => rs.listen(0, '127.0.0.1', r)); const port = rs.address().port; await new Promise(r => rs.close(r));
const origin = `http://127.0.0.1:${port}`;
await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch();
const results = [];
try {
  for (const [w, h, touch] of [[768, 1024, true], [820, 1180, true], [1024, 768, true], [1024, 768, false], [1101, 800, false], [1180, 820, false], [1366, 1024, false], [390, 844, true]]) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch })).newPage();
    await page.goto(origin); await page.waitForSelector('.workspace-stream-row', { state: 'attached' }); await page.locator('.workspace-stream-row button').first().evaluate(b => b.click()); await page.waitForSelector('.bui-composer');
    await page.evaluate(() => { for (const e of document.querySelectorAll('.ui-composer-toolbar [hidden]')) e.hidden = false; });
    const m = await page.evaluate(() => {
      const box = e => e.getBoundingClientRect(), bar = document.querySelector('.ui-composer-toolbar'), hint = document.querySelector('.ui-composer-hint');
      const buttons = [...bar.querySelectorAll('button')].map(b => ({ label: b.getAttribute('aria-label'), text: b.textContent.trim(), title: b.title, w: box(b).width, h: box(b).height, icon: !!b.querySelector('svg') }));
      return { barH: box(bar).height, barW: box(bar).width, scrollW: bar.scrollWidth, hintShown: getComputedStyle(hint).display !== 'none', hintH: box(hint).height, buttons };
    });
    const where = `${w}px${touch ? ' touch' : ''}`;
    assert.ok(m.barH <= 56, `${where}: toolbar is one line (${m.barH}px)`);
    assert.ok(m.scrollW <= m.barW + 1, `${where}: toolbar does not overflow`);
    if (m.hintShown) assert.ok(m.hintH <= 20, `${where}: the hint is one line (${m.hintH}px)`);
    const byLabel = Object.fromEntries(m.buttons.map(b => [b.label, b]));
    for (const label of ['Attach images', 'Stop PI']) {
      const b = byLabel[label]; assert.ok(b, `${where}: ${label} exists`);
      assert.equal(b.text, '', `${where}: ${label} is an icon, not a text button`); assert.ok(b.icon && b.title, `${where}: ${label} has a symbol and a tooltip`); assert.ok(b.w <= 40 && b.h <= 40);
    }
    assert.ok(byLabel['Send ↑'].icon && byLabel['Send ↑'].w <= 60 && byLabel['Send ↑'].w >= 40, `${where}: send is the arrow symbol`);
    results.push(where + (m.hintShown ? ' +hint' : ''));
    if (w === 1366) assert.equal(m.hintShown, true, 'wide keyboard windows keep the hint');
    if (touch) assert.equal(m.hintShown, false, `${where}: touch devices get no keyboard hint`);
  }
  console.log('composer toolbar ok:', results.join(', '));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await browser.close(); backend.closeAllConnections?.(); setTimeout(() => process.exit(process.exitCode ?? 0), 50); }
