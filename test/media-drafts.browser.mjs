import assert from 'node:assert/strict';
import { validPng } from './image-fixture.mjs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage();
 await page.route('https://media-fixture.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Media test</title>' }));
 await page.goto('https://media-fixture.test/');
 const source = await readFile(new URL('../dashboard/public/media-drafts.js', import.meta.url), 'utf8');
 const result = await page.evaluate(async ({ source, png }) => {
  const { createMediaDrafts, uploadImageChunks } = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  const revoked = [], revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
  const drafts = createMediaDrafts();
  const file = new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'pixel.png', { type: 'image/png' });
  drafts.add('chat-a', [file]);
  const item = drafts.list('chat-a')[0];
  const image = new Image(); image.src = item.url; document.body.append(image); await image.decode();
  const preview = { width: image.naturalWidth, height: image.naturalHeight };
  const other = drafts.list('chat-b').length;
  const original = drafts.list('chat-a')[0].id;
  drafts.add('chat-b', [file]);
  const preserved = drafts.list('chat-a')[0].id === original;
  const frames = [];
  const attachment = await uploadImageChunks(file, async chunk => { frames.push(chunk); return { id: 'opaque-id', sha256: 'verified-hash', size: file.size }; });
  drafts.remove('chat-a', original);
  const removed = drafts.list('chat-a').length === 0 && revoked.includes(item.url);
  const failedFrames = [];
  let failed = false;
  try { await uploadImageChunks(file, async chunk => { failedFrames.push(chunk); throw Error('offline'); }); } catch { failed = true; }
  const retainedOnFailure = drafts.list('chat-b').length;
  drafts.destroy();
  return { preview, other, preserved, removed, attachment, frames: frames.map(frame => ({ size: JSON.stringify(frame).length, final: frame.final })), failed, failedCount: failedFrames.length, retainedOnFailure };
 }, { source, png: validPng.toString('base64') });
 assert.deepEqual(result.preview, { width: 16, height: 16 });
 assert.equal(result.other, 0); assert.equal(result.preserved, true); assert.equal(result.removed, true);
 assert.equal(result.attachment.id, 'opaque-id');
 assert.ok(result.frames.every(frame => frame.size < 65000));
 assert.equal(result.frames.at(-1).final, true);
 assert.equal(result.failed, true); assert.equal(result.failedCount, 1); assert.equal(result.retainedOnFailure, 1);
 console.log('Media browser: real PNG preview, conversation-isolated drafts, URL cleanup, bounded chunks and failed upload retention passed.');
} finally { await browser.close(); }
