import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';
// The real built page with a signed-in session: account actions live in a profile menu at the
// right of the page header (not as buttons in the sidebar) and the chat list never scrolls sideways.
const titles = ['"Hi, ich habe ein (leider dringendes) Löschgesuch: SUPPORT REQUEST 60301', '#cpu-flags #keycloak #kubectl-access #java2shell Status?', 'MCP-Rollout-Prüfung 2026-11-10', 'Live provider verification 0.1.202'];
const state = { agent: 'peter-wert', projects: [], streams: titles.map((title, i) => ({ id: 's' + i, projectId: null, title, updatedAt: 100 - i, messages: [], cwd: '/w' })), roots: ['/w'], settings: {} };
const posts = []; let loginRequired = true, workspaces = 1;
const backend = createServer((req, res) => {
  if (req.method === 'POST') posts.push(req.url);
  const json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  if (req.url === '/api/auth') return json({ required: loginRequired, authenticated: true });
  if (req.url === '/api/auth/logout') return json({ ok: true });
  if (req.url === '/api/auth/account') return json({ username: 'operator', editable: true });
  if (req.url === '/api/state') return json({ agent: 'peter-wert', chats: [], backends: { workspaces } });
  if (req.url === '/api/workspace/capabilities') return json({ workspaces: 1 });
  if (req.url === '/api/workspace/state') return json(state);
  if (req.url.startsWith('/api/workspace/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
  res.writeHead(404); res.end('{}');
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 900]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(origin); await page.waitForSelector('#account-menu'); await page.waitForSelector('.workspace-stream-row');
    const result = await page.evaluate(() => {
      const tree = document.querySelector('aside nav.workspace-tree'), aside = document.querySelector('aside');
      const profile = document.querySelector('.workspace-screen > header #account-menu');
      const box = profile.getBoundingClientRect(), header = document.querySelector('.workspace-screen > header').getBoundingClientRect();
      return {
        treeScrollsSideways: tree.scrollWidth > tree.clientWidth,
        asideScrollsSideways: aside.scrollWidth > aside.clientWidth,
        treeOverflowX: getComputedStyle(tree).overflowX,
        sidebarHasNoAccountButtons: !aside.querySelector('#sign-out, #account-settings, #account-actions'),
        profileInHeaderRight: box.right <= header.right && box.right > header.right - 140 && box.height <= 40,
        profileLabel: profile.getAttribute('aria-label'),
        rowButtonsInsideTree: [...tree.querySelectorAll('.workspace-stream-row > button')].every(b => b.getBoundingClientRect().right <= tree.getBoundingClientRect().right + 0.5),
      };
    });
    assert.deepEqual(result, { treeScrollsSideways: false, asideScrollsSideways: false, treeOverflowX: 'hidden', sidebarHasNoAccountButtons: true, profileInHeaderRight: true, profileLabel: 'Account', rowButtonsInsideTree: true }, `${width}px: ${JSON.stringify(result)}`);
    await page.locator('#account-menu').click();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Account settings', 'Sign out']);
    await page.waitForTimeout(300); // Base UI positions the popup after its first frame
    const popup = await page.getByRole('menu').boundingBox(), trigger = await page.locator('#account-menu').boundingBox();
    assert.ok(popup.x >= 0 && popup.x + popup.width <= width, `${width}px: the account menu lies fully inside the window (${JSON.stringify(popup)})`);
    // Note: align='end' and Base UI's collision shift give the same place for a button at the window's right edge,
    // so the `align` argument itself is an equivalent mutant here; the assertion guards the resulting position.
    assert.ok(Math.abs((popup.x + popup.width) - (trigger.x + trigger.width)) < 12, `${width}px: the menu's right edge lines up with its profile button (${JSON.stringify({ popup, trigger })})`);
    assert.ok(popup.y >= trigger.y + trigger.height - 2, 'menu opens below its profile button');
    if (width === 1280) {
      await page.getByRole('menuitem', { name: 'Account settings' }).click();
      await page.locator('dialog.account-dialog').waitFor(); assert.equal(await page.locator('dialog.account-dialog input').first().inputValue(), 'operator');
      await page.keyboard.press('Escape'); await page.locator('dialog.account-dialog').waitFor({ state: 'detached' });
      await page.locator('#account-menu').click();
      await Promise.all([page.waitForEvent('load'), page.getByRole('menuitem', { name: 'Sign out' }).click()]);
      assert.ok(posts.includes('/api/auth/logout'), 'Sign out posts the logout');
    }
    await page.close();
  }
  // A deployment without sign-in has no account to manage: no profile button.
  loginRequired = false;
  const open = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await open.goto(origin); await open.waitForSelector('.workspace-screen > header'); await open.waitForSelector('.workspace-stream-row');
  assert.equal(await open.locator('#account-menu').count(), 0, 'no profile button without sign-in');
  await open.close();
  // Legacy (non-workspace) view: the same profile menu in its own header, and it signs out.
  loginRequired = true; workspaces = 0;
  const legacy = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await legacy.goto(origin); await legacy.waitForSelector('main > header .actions #account-menu');
  assert.equal(await legacy.locator('#account-menu').count(), 1, 'exactly one profile button in the legacy view');
  assert.equal(await legacy.locator('aside #sign-out, aside #account-settings').count(), 0);
  await legacy.locator('#account-menu').click();
  assert.deepEqual(await legacy.getByRole('menuitem').allTextContents(), ['Account settings', 'Sign out']);
  const before = posts.length;
  await Promise.all([legacy.waitForEvent('load'), legacy.getByRole('menuitem', { name: 'Sign out' }).click()]);
  assert.ok(posts.slice(before).includes('/api/auth/logout'), 'legacy Sign out posts the logout');
  await legacy.close();
  console.log('Account menu in the header, no account buttons in the sidebar, no horizontal scrollbar in the chat list.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await browser.close(); backend.closeAllConnections?.(); setTimeout(() => process.exit(process.exitCode ?? 0), 50); }
