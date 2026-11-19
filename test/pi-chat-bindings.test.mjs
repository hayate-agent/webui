import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chatBindings } from '../pi-adapter/chat-bindings.mjs';
test('PI chat selections start empty, persist lifecycle and serialize concurrent updates', async () => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-bindings-')); const file = path.join(dir, 'chats.json');
 try {
  const store = chatBindings(file); assert.deepEqual(await store.list(), {});
  await Promise.all([store.set('one', 'active'), store.set('two', 'archived')]);
  await store.set('one', 'closed');
  assert.deepEqual(await chatBindings(file).list(), { one: { status: 'closed' }, two: { status: 'archived' } });
  await store.set('one', 'deleted'); await store.set('one', 'active');
  assert.equal((await store.list()).one.status, 'active');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(store.set('../history', 'deleted'));
 } finally { await rm(dir, { recursive: true, force: true }); }
});
