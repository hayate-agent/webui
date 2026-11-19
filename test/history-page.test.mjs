import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyPage } from '../pi-adapter/history-page.mjs';
test('native history pages stay bounded and cover10Kmessages without overlap', () => {
 const entries = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), parentId: i ? String(i - 1) : null, type: 'message', message: { role: 'user', content: `Message${i}` } }));
 const ids = new Set(); let before, pages = 0;
 do {
  const page = historyPage(entries, '9999', before);
  assert.ok(page.messages.length <= 64); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 125000);
  for (const message of page.messages) { assert.ok(!ids.has(message.id)); ids.add(message.id); }
  before = page.before; pages++;
 } while (before);
 assert.equal(ids.size, 10000); assert.ok(pages > 100);
 assert.throws(() => historyPage(entries, '9999', 'missing'), /cursor changed/);
});
test('large message and tool arguments are capped before owner socket serialization', () => {
 const entries = [{ id: 'one', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000000) }, { type: 'toolCall', id: 'tool', name: 'read', arguments: { output: 'y'.repeat(1000000) } }] } }];
 const page = historyPage(entries, 'one');
 assert.equal(page.messages[0].text.length, 12000);
 assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16000);
});
