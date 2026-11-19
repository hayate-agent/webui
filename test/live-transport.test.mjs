import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveTransport } from '../dashboard/public/live-transport.js';
const flush = () => new Promise(resolve => setImmediate(resolve));
test('healthy WebSocket never polls; fallback HEAD is conditional; recovery stops polling; no POST replay', async () => {
 const sockets = [], calls = [], changes = [], pending = new Map(); let timerId = 0;
 class Socket { constructor() { sockets.push(this); } close() {} }
 const timers = { setTimeout(fn, ms) { const id = ++timerId; pending.set(id, { fn, ms }); return id; }, clearTimeout(id) { pending.delete(id); } };
 let etag = '"one"';
 const transport = createLiveTransport({ socketURL: 'wss://example.test/api/workspace/live', revisionURL: '/api/workspace/revision', WebSocketClass: Socket, timers,
  fetcher: async (url, options) => { calls.push({ url, ...options }); return { status: options.headers['If-None-Match'] === etag ? 304 : 200, ok: true, headers: { get: () => etag } }; },
  onChange: async event => { changes.push(event); } });
 transport.start(); assert.equal(calls.length, 0);
 sockets[0].onopen(); await flush(); assert.equal(transport.mode, 'websocket'); assert.equal(calls.length, 0);
 sockets[0].onmessage({ data: JSON.stringify({ type: 'changed', revision: 'live-one' }) }); await flush();
 assert.equal(changes.length, 2); assert.equal(calls.length, 0, 'healthy websocket has no HTTP polling');
 sockets[0].onclose(); await flush(); assert.equal(calls.length, 1); assert.equal(calls[0].method, 'HEAD');
 const runPoll = async () => { const pair = [...pending].find(([, value]) => value.ms === 10000); assert.ok(pair); pending.delete(pair[0]); pair[1].fn(); await flush(); };
 await runPoll(); assert.equal(calls.at(-1).headers['If-None-Match'], etag); const before = changes.length;
 await runPoll(); assert.equal(changes.length, before, 'unchanged HEAD does not fetch history');
 etag = '"two"'; await runPoll(); assert.equal(changes.length, before + 1);
 const reconnect = [...pending].find(([, value]) => value.ms === 15000); pending.delete(reconnect[0]); reconnect[1].fn();
 sockets[1].onopen(); await flush(); assert.equal(transport.mode, 'websocket');
 assert.equal([...pending.values()].filter(value => value.ms === 10000).length, 0);
 assert.ok(calls.every(call => call.method === 'HEAD'), 'transport cannot replay POST mutations');
 transport.stop(); assert.equal(pending.size, 0);
});
