import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Clock models server idle expiry as well as browser time. No real requests,
// production credentials or wall-clock delays are involved.
async function fixture({ renew = async () => {} } = {}) {
  let now = 100000, expiresAt = now + 3600000, renewals = 0;
  const listeners = new Map(), timers = new Map(); let timerId = 0;
  const elements = new Map(); let reloads = 0;
  const document = { visibilityState: 'visible', getElementById: id => elements.get(id),
    createElement: () => ({}), querySelector: () => ({ append: (...nodes) => nodes.forEach(node => elements.set(node.id, node)) }),
    addEventListener: (type, listener) => listeners.set(type, listener) };
  const source = (await readFile(new URL('../dashboard/public/auth-client.js', import.meta.url), 'utf8'))
    .replaceAll('export async function', 'async function');
  const context = vm.createContext({ document, sessionStorage: {}, location: { reload: () => { reloads++; } }, Date: { now: () => now },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async url => {
      if (url === '/api/auth/renew') {
        assert.ok(now < expiresAt, 'renewal cannot resurrect an expired server session');
        renewals++; await renew(renewals);
        expiresAt = now + 3600000;
      }
      return { ok: true, json: async () => ({ required: true, authenticated: true, expiresAt }) };
    } });
  vm.runInContext(source + '\nglobalThis.start = authenticate;', context);
  await context.start();
  return {
    listeners, document,
    logout: () => elements.get('sign-out').onclick(),
    get reloads() { return reloads; },
    get now() { return now; }, get expiresAt() { return expiresAt; }, get renewals() { return renewals; },
    async event(type) { await listeners.get(type)?.({ isTrusted: true }); },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; timers.delete(id); now = timer.at; await timer.callback();
      }
      now = end;
    },
  };
}

test('trusted input editing renews idle expiry without requiring a keyboard or pointer event', async () => {
  const f = await fixture();
  assert.ok(f.listeners.has('input'), 'trusted editing needs an input listener (e.g. dictation or context-menu paste)');
  await f.advance(120000); await f.event('input');
  assert.equal(f.renewals, 1);
  assert.equal(f.expiresAt, f.now + 3600000);
});

test('pending activity does not renew while the page is hidden', async () => {
  const f = await fixture();
  await f.event('keydown');
  await f.advance(59000); await f.event('input');
  f.document.visibilityState = 'hidden';
  await f.advance(1000);
  assert.equal(f.renewals, 1);
  await f.advance(120000);
  assert.equal(f.renewals, 1, 'hidden page must not establish a keepalive loop');
});

test('last interaction inside throttle window retains the full configured inactivity interval', async () => {
  const f = await fixture();
  await f.event('keydown');
  await f.advance(59000); await f.event('pointerdown');
  const lastActivity = f.now;
  await f.advance(1000); // Allow a coalesced trailing renewal; no new interaction.
  assert.ok(f.expiresAt >= lastActivity + 3600000,
    'expiry must cover the full idle interval measured from the last interaction, not the first throttled event');
  const afterTrailing = f.renewals;
  await f.advance(1800000);
  assert.equal(f.renewals, afterTrailing, 'a trailing renewal must not become a periodic keepalive');
});


function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('activity during in-flight renewal is flushed once after that request', async () => {
  const held = deferred();
  const f = await fixture({ renew: count => count === 1 ? held.promise : Promise.resolve() });
  const first = f.event('keydown');
  await f.advance(59000); await f.event('input');
  assert.equal(f.renewals, 1, 'no concurrent renewal');
  held.resolve(); await first;
  await f.advance(1000);
  assert.equal(f.renewals, 2);
  await f.advance(120000);
  assert.equal(f.renewals, 2, 'no periodic retry after pending activity is consumed');
});

test('failed renewal without further activity does not retry itself', async () => {
  const f = await fixture({ renew: async () => { throw Error('offline'); } });
  await f.event('keydown');
  await f.advance(120000);
  assert.equal(f.renewals, 1);
});

test('activity during failed renewal observes backoff then receives one retry', async () => {
  const held = deferred();
  const f = await fixture({ renew: count => count === 1 ? held.promise : Promise.resolve() });
  const first = f.event('keydown');
  await f.advance(1000); await f.event('input');
  held.reject(Error('offline')); await first;
  await f.advance(9999); assert.equal(f.renewals, 1);
  await f.advance(1); assert.equal(f.renewals, 2);
  await f.advance(120000); assert.equal(f.renewals, 2);
});

test('logout cancels a pending trailing renewal', async () => {
  const f = await fixture();
  await f.event('keydown');
  await f.advance(59000); await f.event('input');
  await f.logout(); assert.equal(f.reloads, 1);
  await f.advance(120000); assert.equal(f.renewals, 1);
  await f.event('input'); assert.equal(f.renewals, 1, 'logged-out interaction cannot renew');
});

test('completion of in-flight renewal after logout does not revive pending activity', async () => {
  const held = deferred();
  const f = await fixture({ renew: () => held.promise });
  const first = f.event('keydown');
  await f.event('input');
  await f.logout();
  held.resolve(); await first;
  await f.advance(120000);
  assert.equal(f.renewals, 1);
  assert.equal(f.reloads, 1);
});
