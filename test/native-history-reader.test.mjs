import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeHistoryReader } from '../pi-adapter/native-history-reader.mjs';
test('read-only legacy owner pages large history, validates identity and refreshes appended records', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'native-reader-'));
 try {
  const file = path.join(root, 'time_session-id.jsonl');
  const header = { type: 'session', version: 3, id: 'session-id', cwd: '/work' };
  const entries = Array.from({ length: 500 }, (_, i) => ({ type: 'message', id: String(i), parentId: i ? String(i - 1) : null, message: { role: 'user', content: 'x'.repeat(20000) } }));
  await writeFile(file, [header, ...entries].map(JSON.stringify).join('\n') + '\n');
  const original = await readFile(file);
  const reader = new NativeHistoryReader([root]);
  const page = await reader.page('session-id', '/work');
  assert.ok(page.messages.length <= 64); assert.ok(page.before); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 125000);
  assert.deepEqual(await readFile(file), original, 'no migration or source writes');
  assert.equal(await reader.page('session-id', '/wrong'), null);
  await appendFile(file, JSON.stringify({ type: 'message', id: 'new', parentId: '499', message: { role: 'user', content: 'Newest message' } }) + '\n');
  assert.equal((await reader.page('session-id', '/work')).messages.at(-1).id, 'new');
  await symlink(file, path.join(root, 'other-id.jsonl'));
  assert.equal(await reader.page('other-id', '/work'), null);
 } finally { await rm(root, { recursive: true, force: true }); }
});
