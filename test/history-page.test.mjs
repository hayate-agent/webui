import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyPage, projectMessage } from '../pi-adapter/history-page.mjs';
test('tool call arguments stay structured so clients can show the command, not JSON', () => {
 const entry = { id: 'a', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'bash', arguments: { command: 'ls -la', timeout: 5, big: 'x'.repeat(5000) } }] } };
 const [call] = projectMessage(entry).toolCalls;
 assert.equal(call.arguments.command, 'ls -la');
 assert.equal(call.arguments.timeout, '5');
 const late = projectMessage({ id: 'b', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'bash', arguments: { ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['k' + i, i])), command: 'echo late' } }] } }).toolCalls[0];
 assert.equal(late.arguments.command, 'echo late', 'command survives the key limit');
 assert.ok(call.arguments.big.length <= 1000 && !('preview' in call.arguments), 'bounded, not wrapped JSON text');
});
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

test('pages carry tool duration, timestamps and image metadata without image bytes', () => {
 const entries = [
  { id: 'u', type: 'message', parentId: null, timestamp: '2026-11-20T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', mimeType: 'image/png', data: 'A'.repeat(4000) }] } },
  { id: 'r', type: 'message', parentId: 'u', timestamp: '2026-11-20T10:00:05.000Z', message: { role: 'toolResult', toolCallId: 't', toolName: 'bash', isError: false, durationMs: 4200, content: [{ type: 'text', text: 'ok' }] } },
 ];
 const page = historyPage(entries, 'r');
 assert.equal(page.messages[0].timestamp, '2026-11-20T10:00:00.000Z');
 assert.deepEqual(page.messages[0].images, [{ mimeType: 'image/png', bytes: 3000 }]);
 assert.ok(!JSON.stringify(page).includes('AAAA'));
 assert.equal(page.messages[1].durationMs, 4200);
});
