import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDashboardToolMode, resetDashboardToolMode } from '../dashboard/public/dashboard-mode.js';

const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, json: async () => { if (body instanceof Error) throw body; return body; } });
const load = async fetcher => { resetDashboardToolMode(); return loadDashboardToolMode(fetcher); };

test('the switch is read from the server', async () => {
  assert.equal(await load(answer(200, { tools: 'off' })), 'off');
  assert.equal(await load(answer(200, { tools: 'open' })), 'open');
  assert.equal(await load(answer(200, { tools: 'strict' })), 'strict');
});

test('every failure resolves to strict, never to a looser mode', async () => {
  assert.equal(await load(answer(500, { tools: 'open' })), 'strict', 'error status with a body');
  assert.equal(await load(answer(404, {})), 'strict');
  assert.equal(await load(answer(200, new Error('bad json'))), 'strict');
  assert.equal(await load(answer(200, null)), 'strict');
  assert.equal(await load(answer(200, { tools: 'everything' })), 'strict');
  assert.equal(await load(async () => { throw new Error('offline'); }), 'strict');
});

test('the answer is read once and requested with the session', async () => {
  resetDashboardToolMode(); const calls = [];
  const fetcher = async (url, options) => { calls.push([url, options]); return { ok: true, json: async () => ({ tools: 'off' }) }; };
  assert.equal(await loadDashboardToolMode(fetcher), 'off'); assert.equal(await loadDashboardToolMode(fetcher), 'off');
  assert.deepEqual(calls, [['/dashboard-config.json', { credentials: 'same-origin' }]]);
});
