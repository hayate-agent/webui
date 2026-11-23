// Images on an agent's OWN dashboard (Peter): no relay, no agentId. The browser must fetch image bytes
// only after a click, through GET /api/workspace/streams/:id/image, and show real decoded pixels.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';
import { validPng } from './image-fixture.mjs';
const requests = []; let conversationHasBytes = false;
const backend = createServer((req, res) => {
 res.setHeader('content-type', 'application/json'); const out = value => res.end(JSON.stringify(value));
 const url = new URL(req.url, 'http://x');
 if (url.pathname === '/api/auth') return out({ required: false, authenticated: true });
 if (url.pathname === '/api/state') return out({ agent: 'Peter', backends: { workspaces: 1 }, chats: [] });
 if (url.pathname === '/api/workspace/capabilities') return out({ workspaces: 1 });
 const stream = { id: 's1', title: 'Picture chat', projectId: null, busy: false, activity: null, unread: false, updatedAt: 1, messages: [{ id: 'm1', role: 'user', text: 'Look at this', images: [{ mimeType: 'image/png', bytes: validPng.length }] }] };
 if (url.pathname === '/api/workspace/state') return out({ agent: 'Peter', projects: [], streams: [{ ...stream, messages: undefined }], settings: {}, roots: [] });
 if (url.pathname === '/api/workspace/streams/s1') { conversationHasBytes = JSON.stringify(stream).includes(validPng.toString('base64').slice(0, 30)); return out(stream); }
 if (url.pathname === '/api/workspace/streams/s1/image') {
  requests.push(url.search);
  if (url.searchParams.get('message') !== 'm1') { res.statusCode = 404; return out({ error: 'not found' }); }
  const offset = Number(url.searchParams.get('offset')), end = Math.min(validPng.length, offset + 60000);
  return out({ mimeType: 'image/png', size: validPng.length, offset, data: validPng.subarray(offset, end).toString('base64'), done: end >= validPng.length, next: end });
 }
 if (url.pathname.includes('events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write(': ready\n\n'); }
 res.writeHead(404); res.end('{}');
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
 await page.goto(origin);
 await page.getByText('Picture chat').first().click();
 const open = page.locator('.tui-image-open'); await open.waitFor();
 assert.equal(requests.length, 0, 'no image bytes are fetched before the user asks');
 assert.equal(conversationHasBytes, false, 'the conversation carries no image bytes');
 await open.click();
 const picture = page.locator('img.tui-image-pic'); await picture.waitFor();
 await page.waitForFunction(() => { const image = document.querySelector('img.tui-image-pic'); return image?.complete && image.naturalWidth > 0; });
 assert.equal(await picture.evaluate(image => image.naturalWidth), 16, 'real pixels decoded from the assembled blob');
 assert.ok((await picture.getAttribute('src')).startsWith('blob:'));
 assert.ok(requests.length >= 1 && requests.every(search => search.includes('message=m1') && search.includes('index=0')), 'own-route GET with message and index');
 assert.deepEqual(errors, [], 'no page or CSP errors');
 console.log('local image display browser test passed');
} catch (error) { console.error(error); process.exitCode = 1; } finally { await browser.close(); await dashboard.close?.(); backend.close(); setTimeout(() => process.exit(process.exitCode ?? 0), 50); }
