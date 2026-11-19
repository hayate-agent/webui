import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshHealth } from '../dashboard/public/refresh-health.js';

test('failed read refreshes back off; recovery and target changes reset without replay', () => {
 let time = 0;
 const health = createRefreshHealth({ now: () => time, random: () => 0.5 });
 for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
  assert.equal(health.ready('a'), true);
  assert.equal(health.failure('a').delay, delay);
  assert.equal(health.ready('a'), false);
  time += delay - 1; assert.equal(health.ready('a'), false);
  time++; assert.equal(health.ready('a'), true);
 }
 health.success('a'); assert.equal(health.failure('a').delay, 5000);
 assert.equal(health.ready('b'), true, 'new conversation is never delayed by the old failure');
 assert.equal(health.failure('b').failures, 1);
});
