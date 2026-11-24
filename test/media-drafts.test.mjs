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
test('upload progress: 0 before the first chunk, one step per acknowledged chunk, exactly 1 at the end, nothing after a failure', async () => {
 const file = new Blob([new Uint8Array(100000)], { type: 'image/png' });
 const seen = [];
 await uploadImageChunks(file, async chunk => chunk.final ? { id: 'i', sha256: 's', size: 100000 } : { next: chunk.index + 1 }, fraction => seen.push(fraction));
 assert.deepEqual(seen, [0, 45000 / 100000, 90000 / 100000, 1]);
 const failed = [];
 await assert.rejects(uploadImageChunks(file, async chunk => { if (chunk.index === 1) throw Error('offline'); return {}; }, fraction => failed.push(fraction)), /offline/);
 assert.deepEqual(failed, [0, 0.45], 'no progress is reported for the chunk that failed');
});
