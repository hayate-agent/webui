import test from 'node:test';
import assert from 'node:assert/strict';
import { settleReceipts } from '../dashboard/public/receipts.js';

const receipt = (id, text, previousIds = []) => ({ id, text, previousIds });
const user = (id, text) => ({ id, role: 'user', text });

test('an authoritative page that contains the submission delivers it', () => {
  const r = receipt('r1', 'hello');
  const { pending, delivered } = settleReceipts([r], [user('m1', 'hello')], { authoritative: true });
  assert.deepEqual(delivered, [r]); assert.deepEqual(pending, []);
});

test('a cached page never settles or drops a receipt', () => {
  const r = receipt('r1', 'hello');
  const { pending, delivered } = settleReceipts([r], [user('m1', 'hello')], { authoritative: false });
  assert.deepEqual(delivered, []); assert.deepEqual(pending, [r]);
});

test('messages that existed before the submission do not prove it; duplicates match one by one', () => {
  const first = receipt('r1', 'again', ['old']), second = receipt('r2', 'again', ['old']);
  const page = [user('old', 'again'), user('n1', 'again')];
  const { pending, delivered } = settleReceipts([first, second], page, { authoritative: true });
  assert.deepEqual(delivered, [first]); assert.deepEqual(pending, [second]);
});
