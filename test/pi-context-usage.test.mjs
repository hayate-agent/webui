import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sessionUsage, historyPage } from '../pi-adapter/history-page.mjs';
import { createContextWindows } from '../pi-adapter/context-window.mjs';

const user = (id, parentId) => ({ id, parentId, type: 'message', message: { role: 'user', content: 'hi' } });
const assistant = (id, parentId, usage, extra = {}) => ({ id, parentId, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], provider: 'p', model: 'm1', usage, ...extra } });

test('usage reports the latest successful turn as context size and sums the branch', () => {
  const entries = [
    { id: 'a', parentId: null, type: 'model_change', provider: 'p', modelId: 'm0' }, { id: 'b', parentId: 'a', type: 'thinking_level_change', thinkingLevel: 'high' },
    user('u1', 'b'), assistant('a1', 'u1', { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, totalTokens: 116, cost: { total: 0.5 } }),
    user('u2', 'a1'), assistant('a2', 'u2', { input: 20, output: 7, cacheRead: 200, cacheWrite: 0, totalTokens: 227, cost: { total: 0.25 } }),
    user('u3', 'a2'), assistant('a3', 'u3', { input: 0, output: 0, totalTokens: 0 }, { stopReason: 'aborted' }),
  ];
  const usage = sessionUsage(entries, 'a3');
  assert.equal(usage.tokens, 227, 'aborted turns do not define the context size');
  assert.deepEqual(usage.totals, { input: 30, output: 12, cacheRead: 300, cacheWrite: 1, cost: 0.75 });
  assert.equal(usage.model, 'm1'); assert.equal(usage.thinkingLevel, 'high');
});

test('usage tolerates hostile values, cycles and empty branches', () => {
  assert.equal(sessionUsage([], 'x').tokens, null);
  const looped = [{ ...user('u', 'a'), parentId: 'a' }, { ...assistant('a', 'u', { input: -5, output: NaN, totalTokens: Infinity }) }];
  const usage = sessionUsage(looped, 'a');
  assert.deepEqual(usage.totals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
});

test('only the newest page carries usage; older pages stay lean', () => {
  const entries = [user('u1', null), assistant('a1', 'u1', { totalTokens: 50 }), user('u2', 'a1'), assistant('a2', 'u2', { totalTokens: 90 })];
  assert.equal(historyPage(entries, 'a2').usage.tokens, 90);
  assert.equal(historyPage(entries, 'a2', 'a2').usage, undefined);
});

test('context windows come from PI model files and unknown models are not guessed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ctx-'));
  await writeFile(path.join(directory, 'models.json'), JSON.stringify({ providers: { gw: { modelOverrides: { 'homelab/claude-x': { contextWindow: 262144 }, 'gpt-y': { contextWindow: 500000 } } } } }));
  await writeFile(path.join(directory, 'models-store.json'), JSON.stringify({ a: { models: [{ id: 'store-model', contextWindow: 272000 }] } }));
  const windows = createContextWindows({ directory });
  assert.equal(await windows.resolve('claude-x'), 262144);
  assert.equal(await windows.resolve('gpt-y'), 500000);
  assert.equal(await windows.resolve('store-model'), 272000);
  assert.equal(await windows.resolve('nope'), null);
  assert.equal(await windows.resolve(undefined), null);
  assert.equal(await createContextWindows({ directory: path.join(directory, 'missing') }).resolve('gpt-y'), null);
});
