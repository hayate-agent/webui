import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startLocal } from '../scripts/start-local.mjs';
test('unified local launcher serves built UI and both fixed backends then closes', async () => {
 const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-launcher-'));
 const backend = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"backend":"hayate"}'); });
 await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
 const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
 let local;
 try {
  await assert.rejects(startLocal({}), /HAYATE_AGENT_URL/);
  await assert.rejects(startLocal({ HAYATE_AGENT_URL: 'http://127.0.0.1:1' }), /PI_WEBUI_ROOTS/);
  local = await startLocal({ HAYATE_AGENT_URL: `http://127.0.0.1:${backend.address().port}`, PI_WEBUI_ROOTS: temp, PI_WEBUI_BRIDGE_DIR: path.join(temp, 'bridge'), HAYATE_DASHBOARD_PORT: String(port) });
  assert.equal((await fetch(local.origin)).status, 200);
  assert.equal((await (await fetch(local.origin + '/api/state')).json()).backend, 'hayate');
  assert.deepEqual((await (await fetch(local.origin + '/api/pi/sessions')).json()).sessions, []);
 } finally { await local?.stop(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); await rm(temp, { recursive: true, force: true }); }
});
