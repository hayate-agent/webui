import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage();
 await page.setContent('<style>#scroll{height:500px;overflow:auto}article{height:80px;margin:0 0 16px}</style><div id="scroll"></div>');
 const source = await readFile(new URL('../dashboard/public/history-viewport.js', import.meta.url), 'utf8');
 await page.evaluate(async source => {
  const { createHistoryViewport } = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  const scroller = document.querySelector('#scroll');
  window.earlierCalls = 0;
  window.viewport = createHistoryViewport({ scroller, onEarlier: () => { window.earlierCalls++; }, render: message => { const node = document.createElement('article'); node.textContent = message.text; const details = document.createElement('details'); details.dataset.disclosureId = 'thinking:' + message.id; details.innerHTML = '<summary>Thinking</summary><p>Details</p>'; node.append(details); return node; } });
  scroller.append(window.viewport.element);
  window.messages = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), text: `Message ${i}` }));
  window.viewport.update(window.messages);
 }, source);
 assert.ok(await page.locator('article').count() <= 32);
 await page.locator('#scroll').evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
 await page.evaluate(() => new Promise(requestAnimationFrame));
 assert.ok((await page.locator('article').first().textContent()).startsWith('Message 0'));
 await page.locator('details[data-disclosure-id="thinking:0"]').evaluate(node => { node.open = true; });
 for (const position of [10000, 300000, 900000, 0]) {
  await page.locator('#scroll').evaluate((node, y) => { node.scrollTop = y; node.dispatchEvent(new Event('scroll')); }, position);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.ok(await page.locator('article').count() <= 32, 'DOM stays bounded while navigating10Kmessages');
 }
 await page.locator('#scroll').evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
 await page.evaluate(() => new Promise(requestAnimationFrame));
 assert.ok((await page.locator('article').last().textContent()).startsWith('Message 9999'), 'newest messages remain reachable');
 await page.locator('#scroll').evaluate(node => { node.scrollTop = 200000; node.dispatchEvent(new Event('scroll')); });
 await page.evaluate(() => new Promise(requestAnimationFrame));
 const anchor = await page.locator('#scroll').evaluate(node => [...node.querySelectorAll('article')].find(row => row.getBoundingClientRect().bottom > node.getBoundingClientRect().top)?.dataset.historyId);
 await page.evaluate(() => window.viewport.update([...window.messages, { id: 'live-update', text: 'Latest output' }]));
 const afterAnchor = await page.locator('#scroll').evaluate(node => [...node.querySelectorAll('article')].find(row => row.getBoundingClientRect().bottom > node.getBoundingClientRect().top)?.dataset.historyId);
 assert.equal(afterAnchor, anchor, 'live update preserves older reading position');
 assert.equal(await page.evaluate(() => window.earlierCalls), 0, 'programmatic scrolling and layout must not drain all history');
 await page.locator('#scroll').evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
 await page.evaluate(() => new Promise(requestAnimationFrame));
 assert.equal(await page.evaluate(() => window.earlierCalls), 1, 'upward user scrolling requests one earlier page');
 assert.equal(await page.locator('details[data-disclosure-id="thinking:0"]').evaluate(node => node.open), true, 'expanded disclosure survives window eviction and re-entry');
 await page.evaluate(() => { for (let i = 0; i < 100; i++) window.viewport.update([...window.messages, { id: 'live', text: `update${i}` }]); });
 assert.ok(await page.locator('article').count() <= 32, '100refreshes do not accumulate DOM');
 await page.setViewportSize({ width: 700, height: 700 });
 await page.locator('article').first().evaluate(node => { node.style.height = '240px'; });
 await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 assert.ok(await page.locator('article').count() <= 32, 'resize and disclosure growth keep DOM bounded');
 assert.equal(await page.locator('article').first().evaluate(node => node.getBoundingClientRect().height), 240, 'resize measurement preserves existing row rather than replacing its DOM');
 // Jump to a message far away: it lands at the top of the view, the DOM stays bounded, unknown ids are refused.
 await page.setViewportSize({ width: 1000, height: 800 });
 // The reader scrolled by hand a moment ago; a jump to the top must still not fetch earlier pages.
 await page.locator('#scroll').evaluate(node => { node.scrollTop = 5000; node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
 await page.evaluate(() => new Promise(requestAnimationFrame));
 for (const id of ['7000', '0', '9999', '4321']) {
  const jumped = await page.evaluate(id => window.viewport.scrollToMessage(id), id);
  assert.equal(jumped, true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const place = await page.locator('#scroll').evaluate((node, id) => { const row = node.querySelector(`[data-history-id="${id}"]`); return row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : null; }, id);
  assert.notEqual(place, null, `message ${id} is rendered after the jump`);
  assert.ok(place >= -2 && place < 400, `message ${id} is in view after the jump (top offset ${place})`);
  assert.ok(await page.locator('article').count() <= 32, 'jump keeps the DOM bounded');
 }
 assert.equal(await page.evaluate(() => window.viewport.scrollToMessage('does-not-exist')), false);
 assert.equal(await page.evaluate(() => window.earlierCalls), 1, 'jumping must not drain history');
 await page.evaluate(() => window.viewport.destroy());
 console.log('History viewport:10Kmessages, scrolling and100updates keep at most32message nodes.');
} finally { await browser.close(); }
