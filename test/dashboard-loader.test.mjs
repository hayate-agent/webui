import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadDashboard, resetDashboardLoader } from '../dashboard/public/dashboard-loader.js';

test('the bundle is imported once, and only when asked for', async () => {
  resetDashboardLoader(); let imports = 0;
  const importer = async () => { imports++; return { mountDashboard() {} }; };
  assert.equal(imports, 0);
  const [a, b] = await Promise.all([loadDashboard(importer), loadDashboard(importer)]);
  assert.equal(a, b); assert.equal(imports, 1);
});

test('a failed load can be retried', async () => {
  resetDashboardLoader(); let tries = 0;
  const importer = async () => { if (++tries === 1) throw new Error('offline'); return { ok: true }; };
  await assert.rejects(loadDashboard(importer), /offline/);
  assert.deepEqual(await loadDashboard(importer), { ok: true }); assert.equal(tries, 2);
});

test('app.js stays free of the dashboard code', async () => {
  const app = await readFile(new URL('../dist/public/app.js', import.meta.url), 'utf8').catch(() => undefined);
  if (app === undefined) return; // dist is built by `npm run build`; browser suites cover the served files
  assert.ok(app.length < 1000 * 1024, `app.js is ${Math.round(app.length / 1024)} KiB`);
  assert.ok(!app.includes('openui-spin') && !app.includes('@openuidev'), 'no OpenUI code in app.js');
});
