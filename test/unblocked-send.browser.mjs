import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';
// Regression: a message whose send failed (no answer) stayed as an "unconfirmed attempt" in the browser and the composer then
// refused every other message ("Retry the previous unconfirmed input before sending different work"), so the operator had to
// clear it by hand. Now: the same text is retried with the same id (the agent deduplicates), a different text is simply sent.
const stream = { id: 's1', projectId: null, title: 'Chat', updatedAt: 1, messages: [], cwd: '/w' };
const state = { agent: 'a', projects: [], streams: [stream], roots: ['/w'], settings: {} };
const posts = [], creations = []; let failNext = true, failCreate = true;
const backend = createServer(async (req, res) => {
  const json = (body, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  let data = ''; for await (const part of req) data += part;
  if (req.url === '/api/auth') return json({ required: false, authenticated: true });
  if (req.url === '/api/state') return json({ agent: 'a', chats: [], backends: { workspaces: 1 } });
  if (req.url === '/api/workspace/capabilities') return json({ workspaces: 1 });
  if (req.url === '/api/workspace/state') return json(state);
  if (req.url.startsWith('/api/workspace/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
  if (req.url === '/api/workspace/streams' && req.method === 'POST') { creations.push(JSON.parse(data)); if (failCreate) { failCreate = false; return json({ error: 'agent offline' }, 502); } return json({ ...stream, id: 'new1', title: 'neu' }); }
  const target = /^\/api\/workspace\/streams\/([^/]+)\/messages$/.exec(req.url);
  if (target) { const body = JSON.parse(data); posts.push({ ...body, stream: target[1] }); if (target[1] !== 's1') return json({ accepted: true }); if (failNext) { failNext = false; return json({ error: 'agent offline' }, 502); } return json({ accepted: true }); }
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
  const submit = page.locator('.bui-composer button[type=submit]'), field = page.getByLabel('Next project step');
  await field.fill('erste'); await submit.click(); await page.waitForFunction(() => !document.querySelector('.bui-composer button[type=submit]').disabled);
  assert.equal(posts.length, 1, 'the first send reached the server and failed');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('workspace.pending')).length), 1, 'an unconfirmed attempt is stored');
  // A different message must go out, not be refused.
  await field.fill('zweite'); await submit.click(); await page.waitForFunction(() => document.querySelector('.bui-composer textarea').value === '', null, { timeout: 5000 });
  assert.equal(posts.length, 2, 'a different message is sent');
  assert.equal(posts[1].text, 'zweite');
  assert.notEqual(posts[1].id, posts[0].id, 'it is a new submission, not the old one');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('workspace.pending')).length), 0, 'nothing stays pending');
  // The same text after a failure is retried with the SAME id (the agent deduplicates it).
  failNext = true; await field.fill('dritte'); await submit.click(); await page.waitForFunction(() => !document.querySelector('.bui-composer button[type=submit]').disabled && document.querySelector('.bui-composer textarea').value === 'dritte');
  await submit.click(); await page.waitForFunction(() => document.querySelector('.bui-composer textarea').value === '', null, { timeout: 5000 });
  assert.equal(posts.length, 4); assert.equal(posts[3].id, posts[2].id, 'same text is retried under the same id');
  // New chat whose creation failed: another text creates under a new idempotency key instead of being refused.
  const fresh = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await fresh.goto(origin); await fresh.waitForSelector('.bui-composer');
  const fsubmit = fresh.locator('.bui-composer button[type=submit]'), ffield = fresh.getByLabel('Next project step');
  await ffield.fill('Neu A'); await fsubmit.click(); await fresh.waitForFunction(() => !document.querySelector('.bui-composer button[type=submit]').disabled);
  assert.equal(creations.length, 1, 'creation was attempted and failed');
  await ffield.fill('Neu B'); await fsubmit.click(); await fresh.waitForFunction(() => document.querySelector('.bui-composer textarea').value === '', null, { timeout: 5000 });
  assert.equal(creations.length, 2, 'a different text creates its own chat');
  assert.notEqual(creations[1].idempotencyKey, creations[0].idempotencyKey, 'under a new creation key');
  await fresh.waitForFunction(() => !document.querySelector('.bui-composer button[type=submit]').disabled);
  assert.deepEqual(posts.filter(post => post.stream === 'new1').map(post => post.text), ['Neu B'], 'the message of the new chat really reached the server');
  console.log('unblocked-send ok');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await browser.close(); backend.closeAllConnections?.(); setTimeout(() => process.exit(process.exitCode ?? 0), 50); }
