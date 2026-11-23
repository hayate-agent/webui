import test from 'node:test';
import assert from 'node:assert/strict';
import { describeArgs, MAX_SHOWN_CHARS } from '../dashboard/public/confirm-args.js';

test('small arguments are shown completely and verbatim', () => {
  const args = { id: 42, note: 'x'.repeat(100), nested: { a: [1, 2, 3] } };
  const shown = describeArgs(args);
  assert.equal(shown.ok, true); assert.deepEqual(JSON.parse(shown.text), args);
  assert.deepEqual(describeArgs(undefined), { ok: true, text: '{}' });
});

test('arguments that do not fit are never shortened: the write is refused', () => {
  assert.deepEqual(describeArgs({ body: 'x'.repeat(MAX_SHOWN_CHARS) }), { ok: false });
  const edge = describeArgs({ k: 'y'.repeat(MAX_SHOWN_CHARS - 40) });
  assert.equal(edge.ok, true); assert.ok(edge.text.length <= MAX_SHOWN_CHARS);
});

test('unserialisable arguments are refused', () => {
  const cyclic = {}; cyclic.self = cyclic;
  assert.deepEqual(describeArgs(cyclic), { ok: false });
  assert.deepEqual(describeArgs({ n: 10n }), { ok: false });
  assert.deepEqual(describeArgs(() => 1), { ok: false });
});
