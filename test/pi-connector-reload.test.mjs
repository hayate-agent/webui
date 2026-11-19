import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { installConnector } from '../scripts/install-connector.mjs';
test('generated connector bundle reloads changed source with actual PI Jiti loader', async t => {
 let createJiti;
 try {
  const require = createRequire(import.meta.url);
  const entry = process.env.PI_TEST_RUNTIME_ENTRY || require.resolve('@earendil-works/pi-coding-agent');
  ({ createJiti } = await import(pathToFileURL(path.join(path.dirname(entry), 'core/extensions/jiti-loader.js')).href));
 } catch { t.skip('PI runtime loader unavailable'); return; }
 const root = await mkdtemp(path.join(os.tmpdir(), 'pi-reload-')), home = path.join(root, 'home');
 try {
  await mkdir(path.join(root, 'pi-adapter'));
  const source = path.join(root, 'pi-adapter/extension.mjs');
  await writeFile(source, 'export default function(){return "old"}');
  const file = await installConnector({ root, home });
  const load = async () => (await createJiti(import.meta.url, { moduleCache: false }).import(file, { default: true }))();
  assert.equal(await load(), 'old');
  await writeFile(source, 'export default function(){return "new"}');
  await installConnector({ root, home, update: true });
  assert.equal(await load(), 'new', 'a fresh PI loader sees new connector code, not cached transitive mjs');
 } finally { await rm(root, { recursive: true, force: true }); }
});
