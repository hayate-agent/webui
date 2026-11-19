import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMediaStore } from '../pi-adapter/media.mjs';
import { validPng } from './image-fixture.mjs';

test('direct staging counts incomplete chunks and releases expired pending reservations', () => {
 let time = 0;
 const store = createMediaStore({ now: () => time, ttlMs: 10, maxBytes: validPng.length });
 store.chunk('a', { uploadId: randomUUID(), index: 0, data: validPng.subarray(0, 8).toString('base64'), mimeType: 'image/png' });
 assert.throws(() => store.put('b', validPng, 'image/png'), /capacity/);
 time = 10;
 assert.ok(store.put('b', validPng, 'image/png').id);
});

test('completed entry count is bounded and removal or expiry restores capacity', () => {
 let time = 0;
 const store = createMediaStore({ now: () => time, ttlMs: 10, maxItems: 2 });
 const first = store.put('a', validPng, 'image/png');
 store.put('a', validPng, 'image/png');
 assert.throws(() => store.put('a', validPng, 'image/png'), /capacity/);
 assert.equal(store.remove('b', first.id), false);
 assert.throws(() => store.put('a', validPng, 'image/png'), /capacity/);
 assert.equal(store.remove('a', first.id), true);
 assert.ok(store.put('a', validPng, 'image/png').id);
 time = 10;
 assert.ok(store.put('a', validPng, 'image/png').id);
});

test('final chunk transfers its reservation without double counting', () => {
 const store = createMediaStore({ maxBytes: validPng.length });
 const uploadId = randomUUID();
 store.chunk('a', { uploadId, index: 0, data: validPng.subarray(0, 8).toString('base64'), mimeType: 'image/png' });
 const item = store.chunk('a', { uploadId, index: 1, data: validPng.subarray(8).toString('base64'), mimeType: 'image/png', final: true });
 assert.equal(store.get('a', item.id).data, validPng.toString('base64'));
});
