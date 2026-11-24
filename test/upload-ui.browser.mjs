import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';
import { validPng } from './image-fixture.mjs';
// Real built page: an image draft is a thumbnail with a small remove button; while it uploads the thumbnail shows
// progress and the send button says so; the sent image stays visible in the pending receipt; spacing in the live tail.
const png = Buffer.from(validPng, 'base64');
const stream = { id: 's1', projectId: null, title: 'Chat', updatedAt: 1, messages: [], cwd: '/w', features: ['image-prompt-v1'], pi: true };
const state = { agent: 'a', projects: [], streams: [stream], roots: ['/w'], settings: {} };
let release, chunks = 0, failMessages = true; const gate = new Promise(resolve => { release = resolve; });
const backend = createServer(async (req, res) => {
  const json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  let data = ''; for await (const part of req) data += part;
  if (req.url === '/api/auth') return json({ required: false, authenticated: true });
  if (req.url === '/api/state') return json({ agent: 'a', chats: [], backends: { workspaces: 1 } });
  if (req.url === '/api/workspace/capabilities') return json({ workspaces: 1 });
  if (req.url === '/api/workspace/state') return json(state);
  if (req.url.startsWith('/api/workspace/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
  if (req.url === '/api/workspace/streams/s1/media') { chunks++; await gate; return json({ id: 'img1', sha256: 'abc', size: png.length }); }
  if (req.url === '/api/workspace/streams/s1/messages') { if (failMessages) { res.statusCode = 500; return json({ error: 'agent offline' }); } return json({ accepted: true }); }
  res.writeHead(404); res.end('{}');
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(origin); await page.waitForSelector('.workspace-stream-row'); await page.locator('.workspace-stream-row button').first().click();
  await page.locator('input[type=file]').setInputFiles([{ name: 'image.png', mimeType: 'image/png', buffer: png }, { name: 'second.png', mimeType: 'image/png', buffer: png }]);
  const thumb = page.locator('.ui-attachment').first(); await page.locator('.ui-attachment').nth(1).waitFor();
  const box = await thumb.boundingBox(), remove = await thumb.locator('button').boundingBox();
  assert.ok(box.width <= 90 && box.height <= 90, 'thumbnail stays small');
  assert.ok(remove.width <= 26 && remove.x + remove.width <= box.x + box.width + 1 && remove.y >= box.y - 1, 'the remove button sits inside the thumbnail corner');
  assert.equal(await thumb.locator('button').getAttribute('aria-label'), 'Remove image.png');
  assert.equal(await page.locator('.ui-attachment progress').count(), 0, 'no progress before sending');
  await page.getByLabel('Next project step').fill('Bild dabei');
  // Same tick as the submit, before any upload has started: no remove button may be usable, not even one.
  const atSubmit = await page.evaluate(() => { document.querySelector('.bui-composer').requestSubmit(); return [...document.querySelectorAll('.ui-attachment > button')].map(b => getComputedStyle(b).display); });
  assert.deepEqual(atSubmit, ['none', 'none'], 'remove buttons are gone the moment a send starts');
  await page.waitForSelector('.ui-attachment[data-uploading]');
  assert.equal(await page.locator('.ui-attachment progress').count(), 1, 'progress bar while uploading');
  assert.match(await page.locator('.ui-attachment .pct').textContent(), /\d+ %/);
  await page.waitForFunction(() => /Lade hoch/.test(document.querySelector('.bui-composer button[type=submit]').textContent), null, { timeout: 5000 });
  assert.equal(await thumb.locator('button').isHidden(), true, 'cannot remove an image that is being sent');
  assert.equal(await page.locator('.ui-attachment').nth(1).locator('button').evaluate(b => getComputedStyle(b).display), 'none', 'nor one that is still waiting for its turn');
  await page.locator('input[type=file]').setInputFiles({ name: 'third.png', mimeType: 'image/png', buffer: png });
  assert.equal(await page.locator('.ui-attachment').count(), 2, 'no image can be added while a send is in progress');
  assert.equal(await thumb.locator('button').evaluate(b => getComputedStyle(b).display), 'none', 'computed display is none although .ui-attachment>button sets display:flex (style.css [hidden]{display:none!important} wins)');
  release();
  // The send fails after the upload: the draft is kept, so the images must be removable again (nothing stays locked).
  await page.waitForFunction(() => document.querySelectorAll('.ui-attachment').length === 2 && ![...document.querySelectorAll('.ui-attachment > button')].some(b => getComputedStyle(b).display === 'none') && !document.querySelector('.ui-attachment progress'));
  assert.equal(await page.locator('.ui-attachment > button').count(), 2, 'both images can be removed again after a failed send');
  failMessages = false; await page.locator('.bui-composer button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.ui-attachment'));
  assert.doesNotMatch(await page.locator('.bui-composer button[type=submit]').textContent(), /Lade hoch/, 'label restored');
  assert.equal(chunks, 2, 'both images were uploaded');
  // Live tail of a chat (tool boxes, a receipt of a message sent while the agent works, the status line): measured on the built CSS.
  const gaps = await page.evaluate(() => {
    const host = document.querySelector('.workspace-content'); host.replaceChildren();
    const make = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls; e.textContent = text; host.append(e); return e; };
    const tool = make('div', 'tui-tool', 'bash $ cd /x'), receipt = make('article', 'message user ui-chat-message pending-receipt', ''); receipt.append(Object.assign(document.createElement('p'), { textContent: '???' }), Object.assign(document.createElement('small'), { className: 'tui-receipt', textContent: 'Steuerung angenommen' }));
    const status = make('p', 'workspace-context tui-working', 'Target is working…');
    const r = e => e.getBoundingClientRect();
    return { toolToReceipt: r(receipt).top - r(tool).bottom, receiptToStatus: r(status).top - r(receipt).bottom, receiptPadding: parseFloat(getComputedStyle(receipt).paddingTop), receiptRadius: parseFloat(getComputedStyle(receipt).borderTopLeftRadius), statusAfterTool: (() => { host.replaceChildren(tool, status); return r(status).top - r(tool).bottom; })() };
  });
  assert.ok(gaps.toolToReceipt >= 14, `receipt keeps its distance from the tool box above (${gaps.toolToReceipt}px)`);
  assert.ok(gaps.receiptToStatus >= 12, `status line keeps its distance from the receipt (${gaps.receiptToStatus}px)`);
  assert.ok(gaps.statusAfterTool >= 14, `"Target is working" keeps its distance from the tool box above (${gaps.statusAfterTool}px)`);
  assert.ok(gaps.receiptPadding <= 10 && gaps.receiptRadius <= 8, 'receipt looks like a normal user message block, not an oversized bubble');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await browser.close(); backend.closeAllConnections?.(); setTimeout(() => process.exit(process.exitCode ?? 0), 50); }
if (!process.exitCode) console.log('upload-ui ok');
