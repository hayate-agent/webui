import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendNewer, prependOlder, MAX_RETAINED_MESSAGES } from '../dashboard/public/history-window.js';

const messages = (from, to) => Array.from({ length: to - from }, (_, i) => ({ id: 'm' + (from + i), text: String(from + i) }));

test('live appends keep at most the retained maximum and move the cursor to the oldest kept message', () => {
 let state = { history: messages(0, 10), before: null };
 for (let start = 10; start < 5010; start += 50) state = appendNewer(state.history, state.before, messages(start, start + 50));
 assert.equal(state.history.length, MAX_RETAINED_MESSAGES);
 assert.equal(state.history.at(-1).id, 'm5009');
 assert.equal(state.before, state.history[0].id, 'Load earlier pages in exactly the dropped messages');
 const updated = appendNewer(state.history, state.before, [{ id: 'm5009', text: 'edited' }]);
 assert.equal(updated.history.at(-1).text, 'edited'); assert.equal(updated.history.length, MAX_RETAINED_MESSAGES);
});

test('prepending older pages stays bounded and marks the window detached', () => {
 let state = { history: messages(9000, 9064), before: 'm9000', detached: false };
 let next = 9000;
 while (!state.detached) { state = prependOlder(state.history, { messages: messages(next - 64, next), before: 'm' + (next - 64) }); next -= 64; }
 assert.equal(state.history.length, MAX_RETAINED_MESSAGES);
 assert.equal(state.history[0].id, 'm' + next, 'oldest loaded page retained');
 assert.equal(state.before, 'm' + next);
});
