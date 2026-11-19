import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SessionCatalog } from '../pi-adapter/catalog.mjs';
test('native catalog is read only, opaque, incremental and ignores symlink escape', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-catalog-'));
 const outside = await mkdtemp(path.join(os.tmpdir(), 'pi-outside-'));
 try {
  await mkdir(path.join(directory, 'project'));
  const records = [
   { type: 'session', version: 3, id: 'native', cwd: '/work/project' },
   { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'hello' } },
   { type: 'session_info', id: 'b', parentId: 'a', name: 'Saved project' },
  ];
  const file = path.join(directory, 'project', 'saved.jsonl');
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n{"partial":');
  await writeFile(path.join(outside, 'private.jsonl'), JSON.stringify(records[0]) + '\n');
  await symlink(outside, path.join(directory, 'escape'));
  const catalog = new SessionCatalog([directory]);
  const items = await catalog.refresh(); assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Saved project'); assert.equal(items[0].readOnly, true);
  assert.match(items[0].id, /^disk_[a-f0-9]+$/); assert.equal(items[0].path, undefined);
  const snapshot = catalog.snapshot(items[0].id); assert.equal(snapshot.leafId, 'b');
  assert.throws(() => catalog.snapshot('/etc/passwd'), /not in allowed/);
  assert.equal((await catalog.refresh())[0].id, items[0].id);
 } finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
