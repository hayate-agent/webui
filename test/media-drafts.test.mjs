import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaDrafts, uploadImageChunks } from '../dashboard/public/media-drafts.js';
test('image drafts are isolated by conversation and removable', () => {
 const drafts = createMediaDrafts();
 const file = new Blob([new Uint8Array([1, 2])], { type: 'image/png' });
 drafts.add('a', [file]); assert.equal(drafts.list('a').length, 1); assert.equal(drafts.list('b').length, 0);
 assert.throws(() => drafts.add('a', [new Blob(['no'], { type: 'text/plain' })]), /Supported/);
 drafts.remove('a', drafts.list('a')[0].id); assert.equal(drafts.list('a').length, 0); drafts.destroy();
});
test('media uploader bounds every JSON frame and stops on failed chunk', async () => {
 const file = new Blob([new Uint8Array(120000)], { type: 'image/png' });
 let count = 0;
 const result = await uploadImageChunks(file, async chunk => {
  count++; assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < 65000);
  return chunk.final ? { id: 'opaque', sha256: 'digest', size: file.size } : { next: chunk.index + 1 };
 });
 assert.equal(count, 3); assert.equal(result.id, 'opaque');
 count = 0;
 await assert.rejects(uploadImageChunks(file, async () => { count++; throw Error('offline'); }), /offline/);
 assert.equal(count, 1, 'no automatic upload replay');
});
