// Spike: OpenUI Lang renders from OUR shadcn components under the dashboard's real CSP, refreshes
// a Query on a timer without any model, and obeys the tool policy.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';

const serverSource = await readFile(new URL('../server/server.mjs', import.meta.url), 'utf8');
const csp = serverSource.match(/'Content-Security-Policy', "([^"]+)"/)?.[1];
assert.ok(csp && csp.includes("style-src 'self'") && !csp.includes('unsafe-inline'), 'the dashboard CSP forbids inline styles');

await mkdir('dist/spike', { recursive: true });
await writeFile('dist/spike/entry.jsx', `import { mountDashboard } from '../../dashboard/public/ui/dashboard/view.jsx'; window.mountDashboard = mountDashboard;`);
const bundle = await build({ entryPoints: ['dist/spike/entry.jsx'], bundle: true, jsx: 'automatic', format: 'esm', minify: true, write: false, outfile: 'dist/spike/entry.js' });
const code = bundle.outputFiles[0].text;
const appSize = (await readFile('dist/public/app.js')).length;
console.log(`SIZE app.js ${(appSize / 1024).toFixed(0)} KiB | dashboard bundle ${(code.length / 1024).toFixed(0)} KiB (${(gzipSync(code).length / 1024).toFixed(0)} KiB gzip)`);

let health = 0, tickets = [{ id: 1, title: 'Printer down' }], calls = [], writes = [];
const program = `root = Stack([panel, tags, bad])
panel = Panel("Server", [cpu, refresh, table])
cpu = Metric("CPU", health.cpu)
refresh = Btn("Refresh", @Run(health))
table = Table(["ID", "Title"], [[tickets.rows.id, tickets.rows.title]])
tags = Stack([Tag("ok", "secondary"), Tag("late", "destructive")], "row")
bad = Gauge(1)
health = Query("get_server_health", {}, {cpu: 0}, 1)
tickets = Query("list_tickets", {}, {rows: []})`;
const page = server => `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/components.css"><div id="app"></div><script type="module" src="/entry.js"></script>`;
const http = createServer(async (req, res) => {
  const headers = { 'Content-Security-Policy': csp };
  if (req.url === '/') { res.writeHead(200, { ...headers, 'content-type': 'text/html' }); return res.end(page()); }
  if (req.url === '/entry.js') { res.writeHead(200, { ...headers, 'content-type': 'text/javascript' }); return res.end(code); }
  if (req.url === '/components.css') { res.writeHead(200, { ...headers, 'content-type': 'text/css' }); return res.end(await readFile('dist/public/components.css')); }
  res.writeHead(404); res.end();
});
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${http.address().port}`;
const browser = await chromium.launch({ headless: true });
let failed = false;
try {
  const page = await browser.newPage();
  const violations = [], errors = [];
  page.on('console', message => { if (/Content Security Policy|violat/i.test(message.text())) violations.push(message.text().slice(0, 160)); });
  page.on('pageerror', error => errors.push(String(error).slice(0, 160)));
  await page.exposeFunction('callTool', async (name, args) => { calls.push(name); if (name === 'get_server_health') return { cpu: ++health }; if (name === 'list_tickets') return { rows: tickets }; if (name === 'close_ticket') { writes.push(args); return { ok: true }; } throw new Error('unknown tool'); });
  await page.exposeFunction('askOperator', async request => { calls.push('confirm:' + request.tool); return false; });
  await page.goto(origin);
  const mount = mode => page.evaluate(({ source, mode }) => {
    window.dash?.unmount(); window.dash = window.mountDashboard(document.getElementById('app'), { source, mode,
      tools: [{ name: 'get_server_health', kind: 'read' }, { name: 'list_tickets', kind: 'read' }, { name: 'close_ticket', kind: 'write' }],
      call: (name, args) => window.callTool(name, args), confirm: request => window.askOperator(request), onError: errors => { window.lastErrors = errors; } });
  }, { source: program, mode });
  await mount('strict');
  await page.locator('[data-metric="CPU"]').waitFor();
  await page.getByText('Printer down').waitFor();
  const metricClass = await page.locator('[data-metric="CPU"]').evaluate(e => e.parentElement.className);
  assert.match(metricClass, /rounded-lg.*border|border.*rounded-lg/, 'Metric is built from shadcn/Tailwind classes');
  assert.match(await page.locator('text=late').first().getAttribute('class'), /bg-destructive/, 'Tag uses the shadcn Badge');
  assert.equal(await page.locator('[data-metric="CPU"]').evaluate(e => getComputedStyle(e).fontSize), '24px', 'Tailwind utilities are applied (text-2xl)');
  const first = Number(await page.locator('[data-metric="CPU"]').innerText());
  await page.waitForFunction(start => Number(document.querySelector('[data-metric="CPU"]').textContent) > start + 1, first, { timeout: 8000 });
  assert.ok(calls.filter(name => name === 'get_server_health').length >= 3, 'the query refreshed itself on its 1 s timer without a model');
  assert.equal(await page.getByText('Gauge').count(), 0, 'an unknown component is dropped, the rest still renders');
  await page.locator('button', { hasText: 'Refresh' }).click();
  assert.equal(violations.length, 0, 'no CSP violation: ' + violations.join(' | '));
  assert.equal(errors.length, 0, 'no page error: ' + errors.join(' | '));
  // Policy through the real renderer: a generated Mutation in strict mode asks the operator, is declined, nothing is written.
  const writeProgram = `root = Stack([send])
send = Btn("Close ticket", Action([@Run(close)]))
close = Mutation("close_ticket", {id: 42})`;
  await page.evaluate(source => window.dash.update({ source, mode: 'strict',
    tools: [{ name: 'close_ticket', kind: 'write' }], call: (name, args) => window.callTool(name, args), confirm: request => window.askOperator(request) }), writeProgram);
  await page.locator('button', { hasText: 'Close ticket' }).click();
  await page.waitForFunction(() => true); await page.waitForTimeout(400);
  assert.ok(calls.includes('confirm:close_ticket'), 'the operator was asked before the write');
  assert.equal(writes.length, 0, 'the declined write never reached the agent');
  console.log('Dashboard spike passed (render, shadcn classes, CSP, auto-refresh, unknown component dropped)');
} catch (error) { console.error(error); failed = true; }
finally { await browser.close(); http.close(); process.exit(failed ? 1 : 0); }
