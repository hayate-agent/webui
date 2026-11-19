import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, configEnvironment } from '../pi-adapter/config.mjs';
import { servicePlist } from '../scripts/webui-service.mjs';
test('service config is strict, absolute and maps to stable local ports', async () => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'webui-config-')); const file = path.join(dir, 'config.json');
 const valid = { version: 1, hayateUrl: 'http://127.0.0.1:9999', roots: [dir], piExecutable: '/opt/homebrew/bin/pi' };
 try {
  await writeFile(file, JSON.stringify(valid)); const config = await loadConfig(file);
  assert.equal(config.port, 3210); assert.equal(config.adapterPort, 3211);
  assert.equal(configEnvironment(config).PI_WEBUI_PORT, '3211');
  for (const patch of [{ roots: [] }, { roots: ['relative'] }, { port: 0 }, { unknown: true }, { piExecutable: 'pi' }, { hayateUrl: Object.assign(new URL('https://localhost'), { username: 'fixture-user' }).href }]) {
   await writeFile(file, JSON.stringify({ ...valid, ...patch })); await assert.rejects(loadConfig(file));
  }
 } finally { await rm(dir, { recursive: true, force: true }); }
});
test('launchd definition uses direct argv, escapes XML, keeps service alive and directs private logs', () => {
 const plist = servicePlist({ config: '/tmp/a & b/config.json', logs: '/tmp/logs', node: '/node with space/bin/node' });
 assert.ok(plist.includes('<string>/node with space/bin/node</string>'));
 assert.ok(plist.includes('/tmp/a &amp; b/config.json'));
 assert.ok(plist.includes('<key>KeepAlive</key><true/>'));
 assert.ok(!plist.includes('/bin/sh'));
 assert.ok(plist.includes('/tmp/logs/stderr.log'));
});
