import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDashboard } from '../server/server.mjs';
import { dashboardToolMode, dashboardToolsFromEnvironment, DEFAULT_DASHBOARD_TOOL_MODE } from '../server/dashboard-config.mjs';
import { normalizeMode } from '../dashboard/public/dashboard-tools.js';

test('server default is strict; unknown values never loosen it and are reported', () => {
  assert.equal(DEFAULT_DASHBOARD_TOOL_MODE, 'strict');
  assert.deepEqual(dashboardToolsFromEnvironment({}), { mode: 'strict', warning: undefined });
  assert.deepEqual(dashboardToolsFromEnvironment({ HAYATE_DASHBOARD_TOOLS: '' }), { mode: 'strict', warning: undefined });
  assert.deepEqual(dashboardToolsFromEnvironment({ HAYATE_DASHBOARD_TOOLS: ' OFF ' }), { mode: 'off', warning: undefined });
  assert.equal(dashboardToolsFromEnvironment({ HAYATE_DASHBOARD_TOOLS: 'open' }).mode, 'open');
  for (const value of ['yes', 'true', '1', 'opne', 'strict!']) {
    const result = dashboardToolsFromEnvironment({ HAYATE_DASHBOARD_TOOLS: value });
    assert.equal(result.mode, 'strict', value); assert.match(result.warning, /unknown value/, value);
  }
  for (const value of [undefined, null, 5, {}, []]) assert.equal(dashboardToolMode(value), 'strict');
});

test('server and browser normalise every value the same way', () => {
  for (const value of [undefined, null, '', 'strict', 'STRICT', ' off', 'open ', 'Open', 'x', 'true', 5, {}]) assert.equal(normalizeMode(value), dashboardToolMode(value), String(value));
});

test('the dashboard serves the switch as read-only JSON; the default is strict', async () => {
  const backend = createServer((req, res) => { res.end('{}'); }); await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const read = async mode => {
    // A fresh port per case: fetch keeps connections alive, and a restarted server on the same port would reset them.
    const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}`, dashboardTools: mode });
    try {
      const response = await fetch(`${origin}/dashboard-config.json`);
      const post = await fetch(`${origin}/dashboard-config.json`, { method: 'POST' });
      return { status: response.status, body: await response.json(), type: response.headers.get('content-type'), postStatus: post.status };
    } finally { await dashboard.stop(); }
  };
  assert.deepEqual(await read(undefined), { status: 200, body: { tools: 'strict' }, type: 'application/json', postStatus: 405 });
  assert.equal((await read('off')).body.tools, 'off');
  assert.equal((await read('open')).body.tools, 'open');
  assert.equal((await read('anything')).body.tools, 'strict');
  backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve));
});
