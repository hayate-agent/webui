import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, formatRoute } from '../dashboard/public/navigation.js';
import { createChatCache, MAX_CACHED_CHATS, MAX_CACHED_MESSAGES } from '../dashboard/public/chat-cache.js';

const memory = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data }; };

test('routes round-trip and unknown or hostile hashes fall back to home', () => {
  for (const route of [{ kind: 'home' }, { kind: 'agent', agent: 'a1' }, { kind: 'chat', agent: 'local', id: 'c-1' }, { kind: 'chat', agent: 'x', id: '01a1e831-7f25-70c2-b7d0-d8eaf752fb17' }, { kind: 'project', agent: 'a', id: 'p' }]) assert.deepEqual(parseRoute(formatRoute(route)), route);
  for (const bad of ['', '#', '#/', '#/chat', '#/chat/a', '#/chat/a/b/c', '#/chat/a/<script>', '#/chat/a/%00', '#/chat/%E0%A4%A/x', '#/unknown/x/y', '#/chat//b', '#/chat/a//b', '#//chat/a/b', '#/agent/' + 'a'.repeat(200)]) assert.deepEqual(parseRoute(bad), { kind: 'home' }, bad);
});

test('cache is bounded in chats and messages and never keeps media', () => {
  const cache = createChatCache({ storage: memory() });
  for (let i = 0; i < MAX_CACHED_CHATS + 5; i++) cache.set(`a:${i}`, { id: String(i), title: 't', messages: [{ id: 'm', role: 'user', text: 'x', attachments: [{ data: 'AAAA' }], images: ['b64'] }] });
  assert.equal(cache.size, MAX_CACHED_CHATS);
  assert.equal(cache.get('a:0'), undefined, 'least recently used chat is evicted');
  const kept = cache.get(`a:${MAX_CACHED_CHATS + 4}`);
  assert.equal(kept.messages[0].attachments, undefined); assert.equal(kept.messages[0].images, undefined);
  cache.set('big', { id: 'b', title: 't', messages: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, role: 'user', text: 'y' })) });
  const big = cache.get('big');
  assert.equal(big.messages.length, MAX_CACHED_MESSAGES); assert.equal(big.messages.at(-1).id, 'm499');
  assert.equal(big.before, 'm436', 'cursor continues exactly before the oldest cached message');
});

test('cache survives reload through storage, ignores corrupt data, and entries are copies', () => {
  const storage = memory(); const first = createChatCache({ storage });
  first.set('a:1', { id: '1', title: 'One', messages: [{ id: 'm1', role: 'user', text: 'hi' }] });
  const second = createChatCache({ storage });
  assert.equal(second.get('a:1').title, 'One');
  second.get('a:1').messages[0].text = 'mutated'; assert.equal(second.get('a:1').messages[0].text, 'hi');
  storage.setItem('workspace.chat-cache.v1', '{broken'); assert.equal(createChatCache({ storage }).size, 0);
  storage.setItem('workspace.chat-cache.v1', JSON.stringify([['x', { nope: 1 }]])); assert.equal(createChatCache({ storage }).size, 0);
  const full = { getItem: () => null, setItem() { throw new Error('quota'); }, removeItem() {} };
  assert.doesNotThrow(() => createChatCache({ storage: full }).set('a:1', { id: '1', title: 't', messages: [] }), 'storage failure is not an error');
});

test('oversized entries are skipped instead of stored', () => {
  const cache = createChatCache({ storage: memory() });
  cache.set('huge', { id: 'h', title: 't', messages: [{ id: 'm', role: 'assistant', text: 'z'.repeat(400000) }] });
  assert.equal(cache.get('huge'), undefined);
});

test('restored mirrors cannot exceed the bounds enforced on write', () => {
  const storage = memory();
  const rows = Array.from({ length: 40 }, (_, i) => [`a:${i}`, { id: String(i), title: 't', messages: [{ id: 'm', role: 'user', text: 'x' }] }]);
  rows.push(['fat', { id: 'f', title: 't', messages: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, role: 'user', text: 'x' })) }]);
  rows.push(['huge', { id: 'h', title: 't', messages: [{ id: 'm', role: 'assistant', text: 'z'.repeat(400000) }] }]);
  rows.push(['anon', { id: 'n', title: 't', messages: [{ role: 'user' }] }]);
  storage.setItem('workspace.chat-cache.v1', JSON.stringify(rows));
  const cache = createChatCache({ storage });
  assert.ok(cache.size <= MAX_CACHED_CHATS);
  for (const key of ['fat', 'huge', 'anon']) assert.equal(cache.get(key), undefined, key);
});
