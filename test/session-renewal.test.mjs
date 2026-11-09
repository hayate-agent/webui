import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('session renewal is driven only by visible trusted interaction and throttles polling', async () => {
  const listeners = new Map(), calls = []; let now = 100000;
  const document = { visibilityState: 'visible', getElementById: () => ({}), addEventListener: (type, callback) => listeners.set(type, callback) };
  const source = (await readFile(new URL('../dashboard/public/auth-client.js', import.meta.url), 'utf8')).replaceAll('export async function', 'async function');
  const context = vm.createContext({ document, Date: { now: () => now }, fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ required: true, authenticated: true }) }; } });
  vm.runInContext(source + '\nglobalThis.start = authenticate;', context);
  await context.start(); calls.length = 0;
  const event = listeners.get('keydown');
  await event({ isTrusted: false }); assert.equal(calls.length, 0);
  document.visibilityState = 'hidden'; await event({ isTrusted: true }); assert.equal(calls.length, 0);
  document.visibilityState = 'visible'; await event({ isTrusted: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/auth/renew');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.headers['X-Hayate-WebUI'], '1');
  now += 30000; await listeners.get('wheel')({ isTrusted: true }); assert.equal(calls.length, 1);
  now += 30000; assert.equal(calls.length, 1, 'elapsed time alone must not renew');
  await listeners.get('pointerdown')({ isTrusted: true }); assert.equal(calls.length, 2);
});
