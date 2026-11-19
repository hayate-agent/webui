import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
// Rows are far taller than the 160px estimate and differ a lot: the situation in
// which unmeasured rows used to make the view jump or land in the middle.
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
 await page.setContent('<style>#scroll{height:500px;overflow:auto}article{margin:0 0 12px;padding:0}</style><div id="scroll"></div>');
 const source = await readFile(new URL('../dashboard/public/history-viewport.js', import.meta.url), 'utf8');
 await page.evaluate(async source => {
  const { createHistoryViewport } = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  const scroller = document.querySelector('#scroll');
  window.heightOf = i => 40 + (i * 97) % 700;
  window.viewport = createHistoryViewport({ scroller, render: message => { const node = document.createElement('article'); node.style.height = `${window.heightOf(Number(message.id))}px`; node.textContent = `Message ${message.id}`; return node; } });
  scroller.append(window.viewport.element);
  window.messages = Array.from({ length: 400 }, (_, i) => ({ id: String(i), text: `Message ${i}` }));
  window.viewport.update(window.messages);
 }, source);
 const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 const firstVisible = () => page.locator('#scroll').evaluate(node => { const top = node.getBoundingClientRect().top; const row = [...node.querySelectorAll('article')].find(item => item.getBoundingClientRect().bottom > top); return { id: row.dataset.historyId, top: Math.round(row.getBoundingClientRect().top - top) }; });

 // 1. Landing after update: the newest row is fully visible, not somewhere in the middle.
 await frame();
 const landing = await page.locator('#scroll').evaluate(node => ({ gap: Math.round(node.scrollHeight - node.scrollTop - node.clientHeight), last: node.querySelector('article:last-child')?.textContent }));
 assert.ok(landing.gap <= 1, `opens at the newest message (gap ${landing.gap}px)`);
 assert.equal(landing.last, 'Message 399');

 // 2. A sent message appends and the view stays at the bottom.
 for (let i = 0; i < 5; i++) {
  await page.evaluate(i => { window.messages = [...window.messages, { id: String(400 + i), text: `Message ${400 + i}` }]; window.viewport.update(window.messages); }, i);
  await frame();
  const gap = await page.locator('#scroll').evaluate(node => Math.round(node.scrollHeight - node.scrollTop - node.clientHeight));
  assert.ok(gap <= 1, `append ${i}: still at the bottom (gap ${gap}px)`);
 }

 // 3. Slow upward scroll: the first visible row never moves by more than the scroll step.
 let worst = 0;
 for (let step = 0; step < 60; step++) {
  const before = await firstVisible();
  const scrolled = await page.locator('#scroll').evaluate(node => { const old = node.scrollTop; node.scrollTop = old - 120; node.dispatchEvent(new Event('scroll')); return old - node.scrollTop; });
  await frame();
  const after = await firstVisible();
  if (before.id === after.id) worst = Math.max(worst, Math.abs((after.top - before.top) - scrolled));
 }
 assert.ok(worst <= 3, `visible row drifts ${worst}px beyond the scroll distance (jump)`);
 console.log(`History scroll stability: lands at newest, stays at bottom on append, worst drift while scrolling ${worst}px.`);
} finally { await browser.close(); }
