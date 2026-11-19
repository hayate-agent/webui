import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventLog, createPiEventNormalizer, MAX_EVENT_BYTES } from '../pi-adapter/event-log.mjs';
import { createStreamState } from '../dashboard/public/stream-state.js';

const manualTimers = () => { const pending = new Set(); return { setTimeout(fn) { const t = { fn }; pending.add(t); return t; }, clearTimeout(t) { pending.delete(t); }, run() { for (const t of [...pending]) { pending.delete(t); t.fn(); } } }; };

test('event log assigns contiguous per-session seq, bounds retention and repairs or resets gaps', () => {
 const log = createEventLog({ maxEventsPerSession: 3 });
 for (let i = 0; i < 5; i++) log.append('a', 'text.delta', { delta: String(i) });
 log.append('b', 'turn.status', { busy: true });
 assert.deepEqual(log.head('a'), { epoch: log.epoch + '.1', session: 'a', seq: 5 });
 assert.notEqual(log.head('b').epoch, log.head('a').epoch, 'each session window has its own generation');
 assert.equal(log.head('b').seq, 1, 'sessions have independent sequences');
 const repair = log.since('a', 3);
 assert.deepEqual(repair.events.map(e => e.seq), [4, 5]);
 assert.equal(repair.reset, undefined);
 assert.equal(log.since('a', 1).reset, true, 'gap older than retained window forces page reload');
 assert.equal(log.since('a', 5).events.length, 0);
 assert.equal(log.since('a', 9).reset, true, 'future cursor is invalid');
 assert.equal(log.since('a', 4, { epoch: 'other-epoch' }).reset, true, 'restarted producer forces reset');
});

test('event frames are bounded and sinks are isolated extension points', async () => {
 const seen = [];
 const log = createEventLog({ sinks: [{ onEvent: e => seen.push(e.seq) }, { onEvent() { throw Error('broken sink'); } }, { onEvent: async () => { throw Error('async sink'); } }] });
 log.append('a', 'turn.status', { busy: true });
 assert.deepEqual(seen, [1], 'failing sinks never block delivery');
 assert.throws(() => log.append('a', 'text.delta', { delta: 'x'.repeat(MAX_EVENT_BYTES) }), /frame budget/);
 assert.equal(log.head('a').seq, 1, 'rejected event does not consume a sequence number');
 const extra = []; const remove = log.addSink({ onEvent: e => extra.push(e.kind) });
 log.append('a', 'message.end', {}); remove(); log.append('a', 'message.end', {});
 assert.deepEqual(extra, ['message.end']);
});

test('normalizer coalesces token deltas, keeps order before status and bounds tool previews', () => {
 const timers = manualTimers(); const log = createEventLog(); const out = []; log.subscribe(e => out.push(e));
 const pi = createPiEventNormalizer(log, { timers });
 pi.handle('s', { type: 'agent_start' });
 for (const delta of ['Hel', 'lo', ' world']) pi.handle('s', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
 assert.equal(out.length, 1, 'deltas are buffered, not one frame per token');
 pi.handle('s', { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'x'.repeat(10000) } });
 assert.deepEqual(out.map(e => e.kind), ['turn.status', 'text.delta', 'tool.status'], 'buffered text precedes the tool event');
 assert.equal(out[1].data.delta, 'Hello world');
 assert.ok(out[2].data.arguments.length <= 2000);
 pi.handle('s', { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: true, durationMs: 12 });
 pi.handle('s', { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } });
 timers.run();
 pi.handle('s', { type: 'agent_settled' });
 assert.deepEqual(out.slice(3).map(e => [e.kind, e.data.status ?? e.data.delta ?? e.data.busy]), [['tool.status', 'failed'], ['thinking.delta', 'hmm'], ['turn.status', false]]);
 assert.deepEqual(out.map(e => e.seq), [1, 2, 3, 4, 5, 6]);
});

test('browser stream state applies deltas once, repairs gaps via changes and resets on lost window', async () => {
 const log = createEventLog();
 const page = { messages: [{ id: 'm1', role: 'user', text: 'hi' }], busy: false, stream: log.head('s') };
 let reloads = 0, updates = 0;
 const state = createStreamState({ fetchChanges: async (session, since, epoch) => log.since(session, since, { epoch }), reload: async () => { reloads++; }, onUpdate: () => { updates++; } });
 state.reset('s', page);
 const e1 = log.append('s', 'text.delta', { delta: 'Hel' });
 const e2 = log.append('s', 'text.delta', { delta: 'lo' });
 const e3 = log.append('s', 'entry.appended', { message: { id: 'm2', role: 'assistant', text: 'Hello' } });
 assert.equal(state.receive(e1), true);
 assert.equal(state.receive(e1), false, 'duplicate delivery is ignored');
 assert.equal(state.view.activity.text, 'Hel');
 assert.equal(state.receive(e3), false, 'out-of-order event waits for gap repair');
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(state.view.seq, 3, 'missing event fetched via changes and queued one applied');
 assert.deepEqual(state.view.messages.map(m => m.id), ['m1', 'm2']);
 assert.equal(state.view.activity.text, '', 'durable assistant entry replaces live text');
 assert.equal(state.receive(e2), false);
 assert.ok(updates >= 1); assert.equal(reloads, 0);
 const small = createEventLog({ maxEventsPerSession: 2 });
 const lost = createStreamState({ fetchChanges: async (session, since, epoch) => small.since(session, since, { epoch }), reload: async () => { reloads++; } });
 lost.reset('s', { messages: [], stream: small.head('s') });
 for (let i = 0; i < 5; i++) small.append('s', 'text.delta', { delta: 'x' });
 await lost.resync();
 assert.equal(reloads, 1, 'window lost while disconnected leads to exactly one bounded page reload');
 const other = createStreamState({ fetchChanges: async () => ({ events: [] }), reload: async () => { reloads++; } });
 other.reset('s', { messages: [], stream: { epoch: 'old', seq: 0 } });
 other.receive({ epoch: 'new', session: 's', seq: 1, kind: 'text.delta', data: { delta: 'x' } });
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(reloads, 2, 'restarted producer epoch reloads instead of mixing sequences');
});

test('pages without stream position never enable streaming (older connectors)', () => {
 const state = createStreamState({ fetchChanges: async () => { throw Error('must not be called'); }, reload: async () => {} });
 state.reset('s', { messages: [] });
 assert.equal(state.streaming, false);
 assert.equal(state.receive({ epoch: 'x', session: 's', seq: 1, kind: 'text.delta', data: {} }), false);
});

test('PI service streams native events as envelopes, serves changes?since and appends durable entries', async () => {
 const { EventEmitter } = await import('node:events');
 const { mkdtemp, rm } = await import('node:fs/promises');
 const os = (await import('node:os')).default, path = (await import('node:path')).default;
 const { createPiService } = await import('../pi-adapter/service.mjs');
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-stream-'));
 let fake;
 const entries = [{ id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'question' } }];
 class Fake extends EventEmitter {
  id = 'stream-session'; cwd = directory;
  async ready() { return { sessionId: this.id }; }
  async snapshot() { return { entries: [...entries], leafId: entries.at(-1).id, busy: false }; }
  async command(type) { if (type === 'get_state') return { isStreaming: false, pendingMessageCount: 0 }; return {}; }
  async close() { this.emit('exit'); }
 }
 const audited = [];
 const service = await createPiService({ directory, roots: [directory], makeRpc: () => (fake = new Fake()), sinks: [{ onEvent: e => audited.push(e.kind) }] });
 const origin = `http://127.0.0.1:${service.server.address().port}`;
 try {
  assert.equal((await fetch(origin + '/api/pi/sessions', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: JSON.stringify({ cwd: directory }) })).status, 201);
  const page = await (await fetch(origin + '/api/pi/sessions/stream-session/snapshot?view=remote')).json();
  assert.equal(page.stream.seq, 0); assert.equal(typeof page.stream.epoch, 'string');
  fake.emit('event', { type: 'agent_start' });
  fake.emit('event', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'An' } });
  fake.emit('event', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'swer' } });
  entries.push({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] } });
  fake.emit('event', { type: 'message_end', message: { role: 'assistant' } });
  fake.emit('event', { type: 'agent_settled' });
  const read = since => fetch(`${origin}/api/pi/sessions/stream-session/changes?since=${since}&epoch=${page.stream.epoch}`).then(r => r.json());
  let changes; const until = Date.now() + 3000;
  do { changes = await read(0); if (changes.events.some(e => e.kind === 'entry.appended')) break; await new Promise(r => setTimeout(r, 50)); } while (Date.now() < until);
  const kinds = changes.events.map(e => e.kind);
  assert.deepEqual(kinds.slice(0, 4), ['turn.status', 'text.delta', 'message.end', 'turn.status']);
  assert.equal(changes.events[1].data.delta, 'Answer');
  const appended = changes.events.filter(e => e.kind === 'entry.appended').map(e => e.data.message.id);
  assert.ok(appended.includes('a1'), 'durable assistant entry is streamed');
  assert.deepEqual(changes.events.map(e => e.seq), changes.events.map((_, i) => i + 1));
  const tail = await read(changes.events.at(-1).seq - 1);
  assert.equal(tail.events.length, 1, 'changes returns only what follows the cursor');
  assert.equal((await fetch(`${origin}/api/pi/sessions/stream-session/changes?since=0&epoch=stale`).then(r => r.json())).reset, true);
  assert.deepEqual(audited.slice(0, 4), kinds.slice(0, 4), 'sinks observe the same envelopes');
 } finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('evicted session windows get a new epoch so clients reset instead of dropping reused seq numbers', () => {
 const log = createEventLog({ maxSessions: 1 });
 const before = log.head('a'); log.append('a', 'text.delta', { delta: 'x' }); log.append('a', 'text.delta', { delta: 'y' });
 log.append('b', 'turn.status', { busy: true }); // evicts 'a'
 const fresh = log.append('a', 'text.delta', { delta: 'z' });
 assert.equal(fresh.seq, 1);
 assert.notEqual(fresh.epoch, before.epoch, 'recreated window has a new generation');
 assert.equal(log.since('a', 2, { epoch: before.epoch }).reset, true);
 let reloads = 0;
 const state = createStreamState({ fetchChanges: async () => ({ events: [] }), reload: async () => { reloads++; } });
 state.reset('a', { messages: [], stream: { ...before, seq: 2 } });
 assert.equal(state.receive(fresh), false); assert.equal(reloads, 1, 'client reloads instead of treating seq 1 as duplicate');
});

test('durable entries: more than eight new entries or a moved branch emit history.reset, never a partial tail', async () => {
 const { EventEmitter } = await import('node:events');
 const { mkdtemp, rm } = await import('node:fs/promises');
 const os = (await import('node:os')).default, path = (await import('node:path')).default;
 const { createPiService } = await import('../pi-adapter/service.mjs');
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-stream-gap-'));
 let fake; const entries = [{ id: 'u0', parentId: null, type: 'message', message: { role: 'user', content: 'start' } }];
 class Fake extends EventEmitter {
  id = 'gap-session'; cwd = directory;
  async ready() { return { sessionId: this.id }; }
  async snapshot() { return { entries: [...entries], leafId: entries.at(-1).id, busy: false }; }
  async command(type) { return type === 'get_state' ? { isStreaming: false, pendingMessageCount: 0 } : {}; }
  async close() { this.emit('exit'); }
 }
 const service = await createPiService({ directory, roots: [directory], makeRpc: () => (fake = new Fake()) });
 const origin = `http://127.0.0.1:${service.server.address().port}`;
 const kinds = async (since, kind) => { const until = Date.now() + 3000; let result; do { result = await fetch(`${origin}/api/pi/sessions/gap-session/changes?since=${since}`).then(r => r.json()); if (result.events.some(e => e.kind === kind)) return result.events; await new Promise(r => setTimeout(r, 50)); } while (Date.now() < until); return result.events; };
 try {
  await fetch(origin + '/api/pi/sessions', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: JSON.stringify({ cwd: directory }) });
  const page = await (await fetch(origin + '/api/pi/sessions/gap-session/snapshot?view=remote')).json();
  for (let i = 1; i <= 10; i++) entries.push({ id: 'm' + i, parentId: entries.at(-1).id, type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: i % 2 ? [{ type: 'text', text: 'a' + i }] : 'u' + i } });
  fake.emit('event', { type: 'agent_settled' });
  const events = await kinds(page.stream.seq, 'history.reset');
  assert.equal(events.filter(e => e.kind === 'entry.appended').length, 0, 'no partial tail');
  assert.equal(events.filter(e => e.kind === 'history.reset').length, 1);
  const seq = events.at(-1).seq;
  entries.push({ id: 'm11', parentId: 'm10', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'one more' }] } });
  fake.emit('event', { type: 'message_end', message: { role: 'assistant' } });
  const next = await kinds(seq, 'entry.appended');
  assert.deepEqual(next.filter(e => e.kind === 'entry.appended').map(e => e.data.message.id), ['m11'], 'small increments still stream');
 } finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('PI questions stay visible while streaming: RPC dialogs open/close, TUI prompts show waiting', () => {
 const timers = manualTimers(); const log = createEventLog();
 const pi = createPiEventNormalizer(log, { timers });
 const state = createStreamState({ fetchChanges: async () => ({ events: [] }), reload: async () => {} });
 state.reset('s', { messages: [], dialogs: [], stream: log.head('s') });
 const out = []; log.subscribe(e => { out.push(e); state.receive(e); });
 pi.handle('s', { type: 'agent_start' });
 pi.handle('s', { type: 'extension_ui_request', id: 'q1', method: 'select', title: 'Pick', options: ['a', 'b'], timeout: 60000 });
 assert.deepEqual(state.view.dialogs.map(d => [d.id, d.method, d.options.join()]), [['q1', 'select', 'a,b']]);
 pi.handle('s', { type: 'dialog_answered', id: 'q1' });
 assert.equal(state.view.dialogs.length, 0);
 pi.handle('s', { type: 'ui_prompt_start', title: 'Approve in terminal' });
 assert.equal(state.view.activity.waiting, 'Approve in terminal');
 pi.handle('s', { type: 'ui_prompt_end' });
 assert.equal(state.view.activity.waiting, null);
 assert.ok(out.every(e => Buffer.byteLength(JSON.stringify(e)) < 64 * 1024));
});

test('escaped or oversized deltas and dialogs stay within the frame budget and never throw from timers', () => {
 const timers = manualTimers(); const log = createEventLog({ maxBytesPerSession: 8 * 1024 * 1024, maxEventsPerSession: 4096 }); const out = []; log.subscribe(e => out.push(e));
 const pi = createPiEventNormalizer(log, { timers });
 const hostile = '\u0001'.repeat(40000) + '😀'.repeat(5000);
 pi.handle('s', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: hostile } });
 assert.doesNotThrow(() => timers.run());
 assert.equal(out.map(e => e.data.delta).join(''), hostile, 'content preserved across bounded frames');
 assert.ok(out.every(e => Buffer.byteLength(JSON.stringify(e)) <= MAX_EVENT_BYTES));
 out.length = 0;
 pi.handle('s', { type: 'extension_ui_request', id: 'q', method: 'select', title: '\u0002'.repeat(300), message: '\u0003'.repeat(4000), prefill: '\u0004'.repeat(8000), options: Array.from({ length: 64 }, () => '\u0005'.repeat(300)) });
 assert.equal(out.length, 1); assert.equal(out[0].kind, 'dialog.open'); assert.equal(out[0].data.dialog.id, 'q');
});

test('events emitted while a page snapshot is in flight are delivered after the page, never skipped', async () => {
 const { EventEmitter } = await import('node:events');
 const { mkdtemp, rm } = await import('node:fs/promises');
 const os = (await import('node:os')).default, path = (await import('node:path')).default;
 const { createPiService } = await import('../pi-adapter/service.mjs');
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-stream-race-'));
 let fake, release; const entries = [{ id: 'u0', parentId: null, type: 'message', message: { role: 'user', content: 'start' } }];
 class Fake extends EventEmitter {
  id = 'race-session'; cwd = directory; hold = false;
  async ready() { return { sessionId: this.id }; }
  async snapshot() { const copy = [...entries]; if (this.hold) await new Promise(resolve => { release = resolve; }); return { entries: copy, leafId: copy.at(-1).id, busy: false }; }
  async command(type) { return type === 'get_state' ? { isStreaming: false, pendingMessageCount: 0 } : {}; }
  async close() { this.emit('exit'); }
 }
 const service = await createPiService({ directory, roots: [directory], makeRpc: () => (fake = new Fake()) });
 const origin = `http://127.0.0.1:${service.server.address().port}`;
 try {
  await fetch(origin + '/api/pi/sessions', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: JSON.stringify({ cwd: directory }) });
  await (await fetch(origin + '/api/pi/sessions/race-session/snapshot?view=remote')).json();
  fake.hold = true;
  const pending = fetch(origin + '/api/pi/sessions/race-session/snapshot?view=remote').then(r => r.json());
  while (!release) await new Promise(r => setTimeout(r, 5));
  fake.emit('event', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'during snapshot' } });
  fake.emit('event', { type: 'agent_start' });
  fake.hold = false; release();
  const page = await pending;
  const after = await fetch(`${origin}/api/pi/sessions/race-session/changes?since=${page.stream.seq}&epoch=${page.stream.epoch}`).then(r => r.json());
  assert.ok(after.events.some(e => e.kind === 'text.delta' && e.data.delta === 'during snapshot'), 'in-flight delta is after the advertised position');
 } finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('a gap that appears while a repair is in flight is repaired too, never left queued', async () => {
 const log = createEventLog();
 let gate, calls = 0;
 const state = createStreamState({
  fetchChanges: async (session, since, epoch) => { calls++; const snapshot = log.since(session, since, { epoch }); if (calls === 1) await new Promise(resolve => { gate = resolve; }); return snapshot; },
  reload: async () => { throw Error('must not reload'); },
 });
 state.reset('s', { messages: [], stream: log.head('s') });
 const e1 = log.append('s', 'text.delta', { delta: 'a' }); const e2 = log.append('s', 'text.delta', { delta: 'b' });
 state.receive(e2); // gap at 1 -> repair #1 starts, snapshot contains 1..2
 while (!gate) await new Promise(r => setImmediate(r));
 log.append('s', 'text.delta', { delta: 'c' }); const e4 = log.append('s', 'text.delta', { delta: 'd' });
 state.receive(e4); // gap at 3 while repair #1 is in flight
 gate();
 for (let i = 0; i < 20 && state.view.seq < 4; i++) await new Promise(r => setImmediate(r));
 assert.equal(state.view.seq, 4); assert.equal(state.view.activity.text, 'abcd'); assert.equal(calls, 2);
 void e1;
});

test('closed history pages are immutable with a stable ETag (revalidated, 304); the open page stays no-store', async () => {
 const { EventEmitter } = await import('node:events');
 const { mkdtemp, rm } = await import('node:fs/promises');
 const os = (await import('node:os')).default, path = (await import('node:path')).default;
 const { createPiService } = await import('../pi-adapter/service.mjs');
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-pages-'));
 const entries = Array.from({ length: 100 }, (_, i) => ({ id: 'm' + i, parentId: i ? 'm' + (i - 1) : null, type: 'message', message: { role: 'user', content: 'message ' + i } }));
 class Fake extends EventEmitter {
  id = 'paged'; cwd = directory;
  async ready() { return { sessionId: this.id }; }
  async snapshot() { return { entries: [...entries], leafId: entries.at(-1).id, busy: true }; }
  async command(type) { if (type === 'get_state') return { isStreaming: true, pendingMessageCount: 0 }; return {}; }
  async close() { this.emit('exit'); }
 }
 const service = await createPiService({ directory, roots: [directory], makeRpc: () => new Fake() });
 const origin = `http://127.0.0.1:${service.server.address().port}`;
 try {
  assert.equal((await fetch(origin + '/api/pi/sessions', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: JSON.stringify({ cwd: directory }) })).status, 201);
  const openResponse = await fetch(origin + '/api/pi/sessions/paged/snapshot?view=remote');
  assert.equal(openResponse.headers.get('cache-control'), 'no-store');
  const open = await openResponse.json();
  assert.ok(open.before); assert.notEqual(open.immutable, true); assert.ok(open.stream);
  const closedResponse = await fetch(origin + '/api/pi/sessions/paged/snapshot?view=remote&before=' + open.before);
  assert.equal(closedResponse.headers.get('cache-control'), 'private, no-cache');
  const etag = closedResponse.headers.get('etag'); assert.ok(etag);
  assert.equal((await fetch(origin + '/api/pi/sessions/paged/snapshot?view=remote&before=' + open.before, { headers: { 'if-none-match': etag } })).status, 304, 'unchanged closed page revalidates without body');
  const closed = await closedResponse.json();
  assert.equal(closed.immutable, true);
  assert.deepEqual(Object.keys(closed).sort(), ['before', 'historyTruncated', 'immutable', 'messages'], 'no live state in an immutable page');
  // Appending to the session does not change an already closed page.
  entries.push({ id: 'm100', parentId: 'm99', type: 'message', message: { role: 'user', content: 'later' } });
  const again = await (await fetch(origin + '/api/pi/sessions/paged/snapshot?view=remote&before=' + open.before)).json();
  assert.deepEqual(again, closed);
 } finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('usage.update refreshes the context figures during streaming, ignores junk and survives a page reset', () => {
 const state = createStreamState({ fetchChanges: async () => ({ events: [] }), reload() {}, onUpdate() {}, onError() {} });
 const page = { stream: { epoch: 'e1', seq: 0 }, messages: [], usage: { tokens: 10, totals: {} } };
 state.reset('s', page);
 assert.equal(state.view.usage.tokens, 10);
 const send = (seq, data) => state.receive({ v: 1, epoch: 'e1', session: 's', seq, kind: 'usage.update', data });
 send(1, { usage: { tokens: 99, totals: { input: 5 } } });
 assert.equal(state.view.usage.tokens, 99);
 send(2, { usage: 'nope' }); send(3, {});
 assert.equal(state.view.usage.tokens, 99, 'malformed updates never wipe the figures');
 state.reset('s', { stream: { epoch: 'e2', seq: 0 }, messages: [], usage: { tokens: 7, totals: {} } });
 assert.equal(state.view.usage.tokens, 7);
});
