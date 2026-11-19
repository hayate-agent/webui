import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { validPng } from './image-fixture.mjs';
import assert from 'node:assert/strict';
import { inspectImage, createMediaStore, MAX_IMAGE_BYTES, validatePromptImages } from '../pi-adapter/media.mjs';
import { verifyDecodedImage } from '../pi-adapter/media-decode.mjs';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
test('full image decode rejects signature-only garbage and accepts valid raster', async () => {
 await assert.rejects(verifyDecodedImage({ mimeType: 'image/png', data: png.toString('base64') }));
 const valid = { mimeType: 'image/png', data: validPng.toString('base64') };
 assert.equal(await verifyDecodedImage(valid), valid);
});
test('media staging rejects unsupported signatures and declared MIME mismatch', () => {
 assert.equal(inspectImage(png, 'image/png').mimeType, 'image/png');
 assert.throws(() => inspectImage(png, 'image/jpeg'), /matching signature/);
 assert.throws(() => inspectImage(Buffer.from('<svg/>'), 'image/svg+xml'), /supported/);
 assert.throws(() => inspectImage(Buffer.alloc(MAX_IMAGE_BYTES + 1), 'image/png'), /5 MiB/);
});
test('prompt media validates aggregate size, encoding and supported content', () => {
 const image = { type: 'image', mimeType: 'image/png', data: png.toString('base64') };
 assert.deepEqual(validatePromptImages([image]), [image]);
 assert.throws(() => validatePromptImages(Array(5).fill(image)), /four/);
 assert.throws(() => validatePromptImages([{ ...image, data: '!!!!' }]), /Invalid/);
 assert.throws(() => validatePromptImages([{ ...image, mimeType: 'image/jpeg' }]), /matching/);
 const large = Buffer.alloc(3 * 1024 * 1024); png.copy(large);
 const big = { ...image, data: large.toString('base64') };
 assert.throws(() => validatePromptImages([big, big]), /Combined/);
});
test('chunk upload enforces sequence and scope before assembling image', () => {
 const store = createMediaStore(); const uploadId = randomUUID();
 assert.deepEqual(store.chunk('a', { uploadId, index: 0, data: png.subarray(0, 8).toString('base64'), mimeType: 'image/png' }), { uploadId, next: 1 });
 assert.throws(() => store.chunk('b', { uploadId, index: 1, data: 'YQ==', mimeType: 'image/png' }), /scope/);
 assert.throws(() => store.chunk('a', { uploadId, index: 0, data: 'YQ==', mimeType: 'image/png' }), /sequence/);
 const item = store.chunk('a', { uploadId, index: 1, data: png.subarray(8).toString('base64'), mimeType: 'image/png', final: true });
 assert.equal(store.get('a', item.id).data, png.toString('base64'));
});
test('media staging is scoped, bounded, expiring and copies input bytes', () => {
 let time = 0; const store = createMediaStore({ now: () => time, ttlMs: 100, maxBytes: png.length });
 const bytes = Buffer.from(png); const item = store.put('owner:agent:session', bytes, 'image/png');
 bytes.fill(0);
 assert.equal(store.get('owner:agent:session', item.id).data, png.toString('base64'));
 assert.throws(() => store.get('another-owner:agent:session', item.id), /unavailable/);
 assert.throws(() => store.put('owner:agent:session', png, 'image/png'), /capacity/);
 assert.equal(store.remove('other', item.id), false);
 time = 100; assert.throws(() => store.get('owner:agent:session', item.id), /unavailable/);
 assert.ok(store.put('owner:agent:session', png, 'image/png').id);
});
