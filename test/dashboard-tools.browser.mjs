// End to end: an openui block in a chat message reads through ITS agent, a write asks the operator,
// and `off` never talks to the agent about tools at all.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';

const program = 'root = Stack([Metric("Tickets", t.count), Btn("Close 42", Action([@Run(close)])), Btn("Close all", Action([@Run(closeAll)]))])\nt = Query("list_tickets", {}, {count: 0})\nclose = Mutation("close_ticket", {id: 42})\ncloseAll = Mutation("close_ticket", {note: "' + 'z'.repeat(9000) + '"})';
const text = 'Board:\n\n```openui\n' + program + '\n```';
const seen = [];
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
    if (capability === 'streams') return out({ streams: [{ id: 'dash', title: 'Dash chat', projectId: null }] });
    if (capability === 'messages' && input.action === 'dashboard-tools') {
      assert.equal(input.streamId, 'dash', 'the tool request names its conversation');
      seen.push(input.op === 'list' ? 'list' : `${input.op}:${input.tool}`);
      if (input.op === 'list') return out({ tools: [{ name: 'list_tickets', kind: 'read' }, { name: 'close_ticket', kind: 'write' }] });
      if (input.tool === 'list_tickets') return out({ result: { count: 7 } });
      if (input.tool === 'close_ticket') return out({ result: { ok: true } });
    }
    if (input.action === 'read') return out({ id: 'dash', title: 'Dash chat', busy: false, messages: [{ id: 'm1', role: 'assistant', text }] });
    return out({});
  }
  if (req.url.includes('events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write(': ready\n\n'); }
  res.writeHead(404); res.end('{}');
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const freePort = async () => { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const start = async mode => { const port = await freePort(); const origin = `http://127.0.0.1:${port}`; return { origin, dashboard: await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}`, dashboardTools: mode }) }; };
const browser = await chromium.launch({ headless: true });
const open = async origin => { const page = await browser.newPage(); page.errors = []; page.on('pageerror', e => page.errors.push(e.message)); await page.goto(origin); await page.getByRole('button', { name: /Dash chat/ }).first().click(); return page; };
const servers = [];
try {
  // strict: read runs, write asks, declining sends nothing
  const strict = await start('strict'); servers.push(strict);
  let page = await open(strict.origin);
  await page.locator('.openui-block [data-metric="Tickets"]').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('[data-metric="Tickets"]')?.textContent === '7', undefined, { timeout: 10000 });
  assert.ok(seen.includes('list') && seen.includes('call:list_tickets'), 'the read went to the agent without a question');
  assert.equal(await page.getByRole('dialog').count(), 0, 'reads do not ask');
  await page.getByRole('button', { name: 'Close 42' }).click();
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  assert.match(await dialog.innerText(), /close_ticket/); assert.match(await dialog.innerText(), /"id": 42/);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(500);
  assert.ok(!seen.includes('call:close_ticket'), 'declining sent nothing to the agent');
  // confirming runs exactly once
  await page.getByRole('button', { name: 'Close 42' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Run once' }).click();
  await page.waitForFunction(() => true); await page.waitForTimeout(600);
  assert.equal(seen.filter(entry => entry === 'call:close_ticket').length, 1, 'confirmed write ran once');
  // Escape counts as a refusal
  await page.getByRole('button', { name: 'Close 42' }).click(); await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  assert.equal(seen.filter(entry => entry === 'call:close_ticket').length, 1, 'Escape refused the write');
  assert.deepEqual(page.errors, []);
  // Arguments too large to show completely are refused without a dialog; nothing is sent.
  seen.length = 0;
  await page.getByRole('button', { name: 'Close all' }).click();
  await page.waitForTimeout(800);
  assert.equal(await page.getByRole('dialog').count(), 0, 'no dialog for arguments that cannot be shown completely');
  assert.ok(!seen.includes('call:close_ticket'), 'the oversized write was never sent');
  // off: the agent is never asked about tools
  seen.length = 0;
  const off = await start('off'); servers.push(off);
  page = await open(off.origin);
  await page.locator('.openui-block[data-openui="live"]').waitFor({ timeout: 10000 }); await page.waitForTimeout(800);
  assert.deepEqual(seen, [], 'mode off: no tool traffic at all');
  // open: the write runs without a question
  seen.length = 0;
  const open_ = await start('open'); servers.push(open_);
  page = await open(open_.origin);
  await page.waitForFunction(() => document.querySelector('[data-metric="Tickets"]')?.textContent === '7', undefined, { timeout: 10000 });
  await page.getByRole('button', { name: 'Close 42' }).click(); await page.waitForTimeout(600);
  assert.equal(await page.getByRole('dialog').count(), 0, 'open mode does not ask');
  assert.ok(seen.includes('call:close_ticket'), 'open mode ran the write');
  console.log('dashboard tools browser test passed');
} catch (error) { console.error(error); process.exitCode = 1; } finally { await browser.close(); for (const s of servers) await s.dashboard.stop(); backend.closeAllConnections(); backend.close(); setTimeout(() => process.exit(process.exitCode ?? 0), 50); }
