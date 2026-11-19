import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installConnector } from '../scripts/install-connector.mjs';
import { serviceUnit } from '../scripts/webui-service.mjs';
test('connector installer uses local checkout and refuses overwrites', async () => {
 const home = await mkdtemp(path.join(tmpdir(), 'pi-install-'));
 try {
  const file = await installConnector({ home });
  const source = await readFile(file, 'utf8');
  assert.match(source, /history-page-v1/);
  assert.doesNotMatch(source, /from ["']file:/);
  assert.doesNotMatch(source, /^import .*from ["'][^"']+\.mjs/m);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(installConnector({ home }), { code: 'EEXIST' });
  await installConnector({ home, update: true });
  await writeFile(file, '// custom connector');
  await assert.rejects(installConnector({ home, update: true }), /generated bundle/);
 } finally { await rm(home, { recursive: true, force: true }); }
});
test('systemd service quotes paths, escapes specifiers and restricts file permissions', () => {
 const unit = serviceUnit({ config: '/srv/pi data/100%/${HOME}/webui.json', node: '/opt/node binary' });
 assert.match(unit, /ExecStart="\/opt\/node binary"/);
 assert.match(unit, /100%%/); assert.ok(unit.includes('$${HOME}'), 'literal dollars must not expand in systemd'); assert.match(unit, /UMask=0077/);
 assert.doesNotMatch(unit, /Environment=.*TOKEN/);
});
