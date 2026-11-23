import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('only assistant text may become live UI (legacy PI path passes the role)', async () => {
  const pi = await readFile(new URL('../dashboard/public/pi-client.js', import.meta.url), 'utf8');
  assert.match(pi, /markdown\(message\.text, \{ live: message\.role === 'assistant' \}\)/);
  const app = await readFile(new URL('../dashboard/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(live && isOpenUIFence\(code\)\)/);
});
