import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { verifyDecodedImage } from '../pi-adapter/media-decode.mjs';

for (const [format, mimeType] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
 test(`full decoder accepts actual ${format} pixels and rejects truncated payloads`, async () => {
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } })[format]().toBuffer();
  const image = { type: 'image', mimeType, data: bytes.toString('base64') };
  assert.equal(await verifyDecodedImage(image), image);
  await assert.rejects(verifyDecodedImage({ ...image, data: bytes.subarray(0, Math.floor(bytes.length / 2)).toString('base64') }));
 });
}

test('compressed raster larger than 16 million pixels is rejected before pixel allocation', async () => {
 const bytes = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: 'red' } }).png().toBuffer();
 assert.ok(bytes.length < 5 * 1024 * 1024, 'byte budget alone does not catch this image');
 await assert.rejects(verifyDecodedImage({ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }), /pixel limit/i);
});
