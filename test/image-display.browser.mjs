import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';
import { imageChunk } from '../pi-adapter/history-page.mjs';
import { validPng } from './image-fixture.mjs';
const entry = { id: 'img1', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Look at this' }, { type: 'image', mimeType: 'image/png', data: validPng.toString('base64') }] } };
let chunkRequests = 0, pageBytesHaveImage = false;
const backend = createServer(async (req, res) => {
 res.setHeader('content-type', 'application/json'); const out = value => res.end(JSON.stringify(value));
 if (req.url === '/api/auth') return out({ required: false, authenticated: true });
 if (req.url === '/api/state') return out({ agent: 'Central', backends: { workspaces: 1 }, chats: [] });
 if (req.url === '/api/workspace/capabilities') return out({ workspaces: 1, 'agent-hub': 1 });
 if (req.url === '/api/workspace/state') return out({ agent: 'Central', projects: [], streams: [], settings: {} });
 if (req.url === '/api/workspace/agents') return out({ agents: [{ id: 'pi-host', name: 'My PI host', capabilities: ['projects', 'streams', 'messages', 'activity'] }] });
 if (req.url === '/api/workspace/agents/pi-host/request') {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const { capability, input } = JSON.parse(raw);
  if (capability === 'projects') return out({ projects: [], features: ['pi-live-v1'] });
  if (capability === 'activity') return out({ streams: [] });
  if (capability === 'streams') return out({ streams: [{ id: 'session', title: 'Picture chat', projectId: null }] });
  if (input.action === 'image-read') { chunkRequests++; try { return out(imageChunk([entry], input.messageId, input.index, input.offset)); } catch (error) { res.statusCode = error.status ?? 500; return out({ error: error.message }); } }
  if (input.action === 'read') { const body = { id: 'session', title: 'Picture chat', busy: false, messages: [{ id: 'img1', role: 'user', text: 'Look at this', images: [{ mimeType: 'image/png', bytes: validPng.length }] }] }; pageBytesHaveImage = JSON.stringify(body).includes(validPng.toString('base64').slice(0, 40)); return out(body); }
 }
 if (req.url.includes('events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write(': ready\n\n'); }
 res.writeHead(404); res.end('{}');
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('response', response => { if (response.status() === 404 && new URL(response.url()).pathname !== '/api/pi/sessions') errors.push('404 ' + new URL(response.url()).pathname); });
 await page.goto(origin);
 await page.getByRole('button', { name: /Picture chat/ }).first().click();
 const open = page.locator('.tui-image-open'); await open.waitFor();
 assert.equal(chunkRequests, 0, 'no image bytes are fetched before the user asks');
 assert.equal(pageBytesHaveImage, false, 'history page carries no image bytes');
 await open.click();
 const picture = page.locator('img.tui-image-pic'); await picture.waitFor();
 await page.waitForFunction(() => { const image = document.querySelector('img.tui-image-pic'); return image?.complete && image.naturalWidth > 0; });
 assert.equal(await picture.evaluate(image => image.naturalWidth), 16, 'real pixels decoded from the assembled blob');
 assert.ok((await picture.getAttribute('src')).startsWith('blob:'));
 assert.equal(chunkRequests >= 1, true);
 // A released (revoked) blob must not leave a broken picture behind: the control comes back.
 await page.evaluate(() => { const image = document.querySelector('img.tui-image-pic'); image.src = 'blob:http://invalid/revoked'; });
 await page.locator('.tui-image-open').waitFor();
 assert.match(await page.locator('.tui-image-open').innerText(), /show again/);
 assert.deepEqual(errors, [], 'no page or CSP errors');
 // The restored control works again (cached or not): click shows a picture a second time.
 await page.locator('.tui-image-open').click();
 await page.locator('img.tui-image-pic').waitFor();
 console.log('image display browser test passed');
} catch (error) { console.error(error); process.exitCode = 1; } finally { await browser.close(); await dashboard.close?.(); backend.close(); setTimeout(() => process.exit(process.exitCode ?? 0), 50); }
