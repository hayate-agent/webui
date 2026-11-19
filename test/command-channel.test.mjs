import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandChannel } from '../dashboard/public/command-channel.js';

const manualTimers = () => { const pending = new Set(); return { setTimeout(fn) { const t = { fn }; pending.add(t); return t; }, clearTimeout(t) { pending.delete(t); }, run() { for (const t of [...pending]) { pending.delete(t); t.fn(); } } }; };

test('commands use the socket with ack and never need POST when acknowledged', async () => {
 const sent = [], posts = [];
 const channel = createCommandChannel({ transport: { command: frame => { sent.push(frame); return true; } }, post: async frame => { posts.push(frame); return {}; } });
 const result = channel.run({ agentId: 'a', capability: 'messages', input: { action: 'send', text: 'x' } });
 await Promise.resolve();
 channel.receive({ type: 'ack', opId: sent[0].opId, ok: true, result: { accepted: true } });
 assert.deepEqual(await result, { accepted: true });
 assert.equal(posts.length, 0); assert.match(sent[0].opId, /^[0-9a-z]{1,11}-[0-9a-f-]{36}$/);
});

test('lost ack, closed socket and server backpressure fall back to POST with the same opId', async () => {
 const timers = manualTimers(); const sent = [], posts = [];
 const channel = createCommandChannel({ timers, transport: { command: frame => { sent.push(frame); return true; } }, post: async frame => { posts.push(frame); return { via: 'post' }; } });
 const lost = channel.run({ agentId: 'a', capability: 'messages', input: { action: 'send' } });
 await Promise.resolve(); timers.run();
 assert.deepEqual(await lost, { via: 'post' }); assert.equal(posts[0].opId, sent[0].opId, 'fallback reuses the opId, so the server ledger deduplicates');
 const closed = channel.run({ agentId: 'a', capability: 'messages', input: { action: 'abort' } });
 await Promise.resolve(); channel.disconnected();
 await closed; assert.equal(posts[1].opId, sent[1].opId);
 const busy = channel.run({ agentId: 'a', capability: 'messages', input: { action: 'send' } });
 await Promise.resolve(); channel.receive({ type: 'ack', opId: sent[2].opId, ok: false, status: 429, executed: false });
 await busy; assert.equal(posts[2].opId, sent[2].opId);
 assert.equal(channel.pending, 0);
});

test('a socket unavailable for commands uses POST directly; recorded failures are reported, not retried', async () => {
 const posts = [];
 const offline = createCommandChannel({ transport: { command: () => false }, post: async frame => { posts.push(frame); return { ok: 1 }; } });
 await offline.run({ agentId: 'a', capability: 'messages', input: {} }); assert.equal(posts.length, 1);
 const sent = [];
 const channel = createCommandChannel({ transport: { command: frame => { sent.push(frame); return true; } }, post: async () => { throw Error('must not post'); } });
 const failed = channel.run({ agentId: 'a', capability: 'messages', input: {} });
 await Promise.resolve(); channel.receive({ type: 'ack', opId: sent[0].opId, ok: false, status: 409, error: 'Operation identity conflict' });
 await assert.rejects(failed, /identity conflict/);
});

test('opIds carry the server-time issue timestamp', () => {
 const sent = [];
 const channel = createCommandChannel({ serverOffsetMs: 5000, now: () => 1_000_000, transport: { command: frame => { sent.push(frame); return true; } }, post: async () => ({}) });
 void channel.run({ agentId: 'a', capability: 'messages', input: {} });
 assert.equal(parseInt(sent[0].opId.split('-')[0], 36), 1_005_000);
});
