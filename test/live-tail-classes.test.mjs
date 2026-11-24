import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// The live tail of a chat is built by workspace-client.js and styled by chat-surface.css; the browser test (upload-ui.browser.mjs)
// measures the spacing of exactly these classes. This pins that the app really puts them on its elements.
const client = await readFile(new URL('../dashboard/public/workspace-client.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../dashboard/public/chat-surface.css', import.meta.url), 'utf8');
test('the "Target is working" line carries the class that gives it distance from the tool boxes', () => {
  assert.match(client, /'Target is working…', 'workspace-context tui-working'\)/);
  assert.match(css, /\.workspace-content \.tui-working\{margin:16px 0 4px/);
});
test('the receipt of a message sent while the agent works is a normal user message block with its own spacing and keeps its images', () => {
  assert.match(client, /node\('article', undefined, 'message user ui-chat-message pending-receipt'\)/);
  assert.match(client, /'tui-receipt'\)\);\s*fragment\.append\(row\)/);
  assert.match(client, /previews: submittedImages\.map\(item => \(\{ url: URL\.createObjectURL\(item\.file\)/);
  assert.match(client, /URL\.revokeObjectURL\(preview\.url\)/, 'receipt previews are released once the agent history shows the message');
  assert.match(css, /\.message\.user\.pending-receipt\{margin:16px 0 12px;padding:8px 14px;border-radius:6px/);
});
