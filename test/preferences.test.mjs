import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreferences, sanitize, applyLocal, DEFAULTS, CACHE_KEY, LEGACY_HIDDEN_KEY, LEGACY_THEME_KEY, validKey } from '../dashboard/public/preferences.js';

const memory = (initial = {}) => { const data = new Map(Object.entries(initial)); return { data, getItem: k => data.has(k) ? data.get(k) : null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) }; };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
// A tiny server with the same patch semantics as dashboard-api/preferences.mjs.
function server(initial = {}) {
  const state = { ...DEFAULTS, ...initial }, calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body && JSON.parse(init.body) });
    if (server.fail) return reply(server.fail, { error: 'refused' });
    if (!init.method) return reply(200, state);
    Object.assign(state, applyLocal(state, JSON.parse(init.body)), { revision: state.revision + 1 }); return reply(200, state);
  };
  return { state, calls, fetch };
}

test('sanitize accepts only what this browser understands', () => {
  assert.deepEqual(sanitize(undefined), DEFAULTS);
  assert.deepEqual(sanitize({ theme: 'neon', mode: 'sepia', pageTitle: 5, headerTitle: 'x'.repeat(61), hidden: 'a', revision: -1 }), DEFAULTS);
  const ok = sanitize({ theme: 'blue', mode: 'dark', pageTitle: ' Work ', headerTitle: 'me', hidden: ['b', 'a', 'a', 'has space', 5, 'chat:x:1'], revision: 3 });
  assert.deepEqual(ok, { theme: 'blue', mode: 'dark', pageTitle: 'Work', headerTitle: 'me', hidden: ['a', 'b', 'chat:x:1'], revision: 3 });
  assert.ok(validKey('akira') && validKey('project:a:b:c') && validKey('chat:local:1'));
  assert.ok(!validKey('a:b') && !validKey('chat:a') && !validKey('other:a:b') && !validKey('') && !validKey('x'.repeat(201)));
});

test('sanitize: control characters in a title and more than 2000 hidden items are dropped', () => {
  assert.equal(sanitize({ pageTitle: 'a\u0007b', headerTitle: 'tab\there' }).pageTitle, ''); assert.equal(sanitize({ headerTitle: 'tab\there' }).headerTitle, '');
  const many = Array.from({ length: 2500 }, (_, i) => `chat:a:${String(i).padStart(4, '0')}`);
  assert.equal(sanitize({ hidden: many }).hidden.length, 2000);
});

test('migration sends nothing when the server already hides everything the old list had, and ignores an unknown old mode', async () => {
  const store = memory({ [LEGACY_HIDDEN_KEY]: JSON.stringify(['akira']), [LEGACY_THEME_KEY]: 'sepia' }), s = server({ hidden: ['akira', 'example'], revision: 0 });
  const prefs = createPreferences({ fetch: s.fetch, storage: () => store }); await prefs.load();
  assert.equal(s.calls.filter(call => call.method === 'POST').length, 0); assert.equal(prefs.value.mode, 'system'); assert.equal(store.data.has(LEGACY_HIDDEN_KEY), false);
});

test('load reads the server record, caches it and tells the listeners', async () => {
  const s = server({ theme: 'red', hidden: ['akira'], revision: 5 }), store = memory(), prefs = createPreferences({ fetch: s.fetch, storage: () => store });
  const seen = []; prefs.onChange(value => seen.push(value.theme));
  const value = await prefs.load();
  assert.equal(value.theme, 'red'); assert.equal(prefs.serverBacked, true); assert.ok(prefs.isHidden('akira')); assert.deepEqual(seen, ['red']);
  assert.equal(JSON.parse(store.data.get(CACHE_KEY)).theme, 'red');
});

test('a second browser starts from the cache and then follows the server', async () => {
  const store = memory({ [CACHE_KEY]: JSON.stringify({ theme: 'blue', hidden: ['old'] }) });
  const s = server({ theme: 'gray', hidden: ['akira'], revision: 2 }), prefs = createPreferences({ fetch: s.fetch, storage: () => store });
  assert.equal(prefs.value.theme, 'blue', 'cache gives the first paint');
  await prefs.load(); assert.equal(prefs.value.theme, 'gray'); assert.deepEqual(prefs.value.hidden, ['akira'], 'the server wins over the cache');
});

test('one-time migration: old local hidden items are added, never replace the server list, and the old keys go away', async () => {
  const store = memory({ [LEGACY_HIDDEN_KEY]: JSON.stringify(['example', 'chat:akira:9', 'bad key']), [LEGACY_THEME_KEY]: 'dark' });
  const s = server({ hidden: ['akira'], revision: 0 }), prefs = createPreferences({ fetch: s.fetch, storage: () => store });
  await prefs.load();
  assert.deepEqual(prefs.value.hidden, ['akira', 'chat:akira:9', 'example']); assert.equal(prefs.value.mode, 'dark');
  assert.deepEqual(s.state.hidden, ['akira', 'chat:akira:9', 'example']);
  assert.equal(store.data.has(LEGACY_HIDDEN_KEY), false); assert.equal(store.data.has(LEGACY_THEME_KEY), false);
  assert.equal(s.calls.filter(call => call.method === 'POST').length, 1, 'one request for the whole migration');
  const again = createPreferences({ fetch: s.fetch, storage: () => store }); const before = s.calls.length; await again.load();
  assert.equal(s.calls.length - before, 1, 'nothing left to migrate: only the read');
});

test('the old light/dark choice does not override a mode the operator already set on the server', async () => {
  const store = memory({ [LEGACY_THEME_KEY]: 'dark' }), s = server({ mode: 'light', revision: 4 });
  const prefs = createPreferences({ fetch: s.fetch, storage: () => store }); await prefs.load();
  assert.equal(prefs.value.mode, 'light'); assert.equal(s.calls.filter(call => call.method === 'POST').length, 0); assert.equal(store.data.has(LEGACY_THEME_KEY), false);
});

test('a failed migration keeps the old keys so the next start tries again', async () => {
  const store = memory({ [LEGACY_HIDDEN_KEY]: JSON.stringify(['example']) }), s = server();
  const flaky = async (url, init) => init?.method ? reply(500, { error: 'down' }) : s.fetch(url, init);
  const prefs = createPreferences({ fetch: flaky, storage: () => store }); await prefs.load();
  assert.equal(store.data.has(LEGACY_HIDDEN_KEY), true); assert.equal(prefs.serverBacked, true);
});

test('update is applied at once, sent as a patch with the WebUI header, and confirmed by the server record', async () => {
  const s = server(), prefs = createPreferences({ fetch: s.fetch, storage: () => memory() }); await prefs.load();
  const seen = []; prefs.onChange(value => seen.push(value.theme + ':' + value.hidden.join(',')));
  const pending = prefs.update({ theme: 'blue', hide: ['akira'] });
  assert.equal(prefs.value.theme, 'blue', 'optimistic'); await pending;
  const post = s.calls.find(call => call.method === 'POST');
  assert.deepEqual(post.body, { theme: 'blue', hide: ['akira'] }); assert.equal(post.headers['X-Hayate-WebUI'], '1'); assert.equal(post.url, '/api/preferences');
  assert.equal(prefs.value.revision, s.state.revision); assert.equal(seen[0], 'blue:akira');
  await prefs.update({ show: ['akira'] }); assert.deepEqual(prefs.value.hidden, []); assert.deepEqual(s.state.hidden, []);
});

test('a refused change is rolled back, reported to the caller and never cached', async () => {
  const s = server({ theme: 'red', revision: 1 }), store = memory(), prefs = createPreferences({ fetch: s.fetch, storage: () => store }); await prefs.load();
  server.fail = 403; const seen = []; prefs.onChange(value => seen.push(value.theme));
  await assert.rejects(prefs.update({ theme: 'blue' }), /refused/);
  server.fail = 0; assert.equal(prefs.value.theme, 'red'); assert.deepEqual(seen, ['blue', 'red']); assert.equal(JSON.parse(store.data.get(CACHE_KEY)).theme, 'red');
});

test('without a server route (older backend) the browser keeps working with its local cache', async () => {
  const store = memory({ [LEGACY_HIDDEN_KEY]: JSON.stringify(['example']) });
  const prefs = createPreferences({ fetch: async () => reply(404, { error: 'Not found' }), storage: () => store }); await prefs.load();
  assert.equal(prefs.serverBacked, false); assert.equal(store.data.has(LEGACY_HIDDEN_KEY), true, 'old keys untouched');
  await prefs.update({ hide: ['akira'], theme: 'blue' }); assert.deepEqual(prefs.value.hidden, ['akira']); assert.equal(JSON.parse(store.data.get(CACHE_KEY)).theme, 'blue');
  const reloaded = createPreferences({ fetch: async () => { throw Error('offline'); }, storage: () => store }); await reloaded.load();
  assert.equal(reloaded.value.theme, 'blue'); assert.deepEqual(reloaded.value.hidden, ['akira']);
});

test('a blocked or throwing storage never breaks the page', async () => {
  const s = server(), prefs = createPreferences({ fetch: s.fetch, storage: () => { throw Error('SecurityError'); } });
  await prefs.load(); await prefs.update({ theme: 'gray' }); assert.equal(prefs.value.theme, 'gray');
  const broken = memory({ [CACHE_KEY]: '{not json' }); assert.equal(createPreferences({ fetch: s.fetch, storage: () => broken }).value.theme, 'green');
  const full = { ...memory(), setItem() { throw Error('QuotaExceeded'); } }; const p2 = createPreferences({ fetch: s.fetch, storage: () => full }); await p2.load(); await p2.update({ mode: 'dark' }); assert.equal(p2.value.mode, 'dark');
});

test('applyLocal: scalars replace, hide/show change single items and hide wins', () => {
  const next = applyLocal({ ...DEFAULTS, hidden: ['a', 'b'] }, { mode: 'dark', hide: ['c', 'a'], show: ['a', 'b'] });
  assert.equal(next.mode, 'dark'); assert.deepEqual(next.hidden, ['a', 'c']);
});
