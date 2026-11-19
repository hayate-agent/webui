import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveTransport } from '../dashboard/public/live-transport.js';
const flush = () => new Promise(resolve => setImmediate(resolve));
test('websocket auth revocation stops rather than falling back; stalled handshake enters fallback', async () => {
 const sockets = [], timers = new Map(), requests = []; let id = 0;
 class Socket { constructor() { sockets.push(this); } close() {} }
 const clock = { setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clearTimeout(i) { timers.delete(i); } };
 const live = createLiveTransport({ socketURL: 'ws://fixture', revisionURL: '/revision', WebSocketClass: Socket, timers: clock, onChange: async () => {}, fetcher: async (_url, input) => { requests.push(input); return { ok: true, status: 304, headers: { get: () => 'one' } }; } });
 live.start(); sockets[0].onopen(); sockets[0].onclose({ code: 4003 }); await flush();
 assert.equal(live.mode, 'stopped'); assert.equal(requests.length, 0); assert.equal(timers.size, 0);
 live.start(); const timeout = [...timers].find(([, timer]) => timer.ms === 5000); timers.delete(timeout[0]); timeout[1].fn(); await flush();
 assert.equal(live.mode, 'fallback'); assert.equal(requests.length, 1); assert.equal(requests[0].method, 'HEAD');
 live.stop(); assert.equal(timers.size, 0);
});
test('event bursts coalesce one in-flight resync instead of overlapping history reads', async () => {
 let socket, release, calls = 0, active = 0, max = 0;
 class Socket { constructor() { socket = this; } close() {} }
 const live = createLiveTransport({ socketURL: 'ws://fixture', revisionURL: '/revision', WebSocketClass: Socket,
  onChange: async () => { calls++; active++; max = Math.max(max, active); if (calls === 1) await new Promise(resolve => { release = resolve; }); active--; } });
 live.start(); socket.onopen();
 for (let i = 0; i < 50; i++) socket.onmessage({ data: JSON.stringify({ type: 'changed', revision: String(i) }) });
 assert.equal(calls, 1); release(); await flush(); assert.equal(max, 1); assert.equal(calls, 2); live.stop();
});

test('failed reconnect resumes fallback after obsolete aborted HEAD settles', async () => {
 const sockets = [], jobs = new Map(); let id = 0, release, calls = 0;
 class Socket { constructor() { sockets.push(this); } close() {} }
 const timers = { setTimeout(fn, ms) { jobs.set(++id, { fn, ms }); return id; }, clearTimeout(i) { jobs.delete(i); } };
 const run = ms => { const [id, job] = [...jobs].find(([, j]) => j.ms === ms); jobs.delete(id); job.fn(); };
 const live = createLiveTransport({ socketURL: 'ws://fixture', revisionURL: '/revision', WebSocketClass: Socket, timers, onChange: async () => {}, fetcher: async () => { if (++calls === 1) await new Promise(resolve => { release = resolve; }); return { ok: true, status: 304, headers: { get: () => 'one' } }; } });
 live.start(); sockets[0].onclose({ code: 1006 }); assert.equal(calls, 1);
 run(15000); sockets[1].onclose({ code: 1006 }); assert.equal(calls, 1);
 release(); await flush(); run(0); await flush(); assert.equal(calls, 2); live.stop();
});
