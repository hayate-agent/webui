import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
// Transcript of mostly one-line tool calls between a few tall outputs in a tall
// window (more rows fit on screen than a fixed 32-row window covers), with adjacent margins that collapse: the situation in which spacer estimates used to leave blank screen.
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 1000, height: 1500 } });
 await page.setContent('<style>#scroll{height:1300px;overflow:auto}article{margin:6px 0 6px;padding:0}</style><div id="scroll"></div>');
 const source = await readFile(new URL('../dashboard/public/history-viewport.js', import.meta.url), 'utf8');
 await page.evaluate(async source => {
  const { createHistoryViewport } = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  const scroller = document.querySelector('#scroll');
  window.viewport = createHistoryViewport({ scroller, render: message => { const node = document.createElement('article'); const i = Number(message.id); node.style.height = `${i % 25 === 0 ? 420 : 12}px`; node.textContent = `Message ${i}`; return node; } });
  scroller.append(window.viewport.element);
  window.viewport.update(Array.from({ length: 600 }, (_, i) => ({ id: String(i) })));
 }, source);
 const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 await frame();
 const blank = () => page.locator('#scroll').evaluate(node => {
  const box = node.getBoundingClientRect(), [top, rows, bottom] = node.firstElementChild.children;
  const covered = element => Math.round(Math.max(0, Math.min(element.getBoundingClientRect().bottom, box.bottom) - Math.max(element.getBoundingClientRect().top, box.top)));
  return { top: covered(top), bottom: covered(bottom), rows: rows.children.length };
 });
 let worst = 0, widest = 0;
 for (let step = 0; step < 220; step++) {
  await page.locator('#scroll').evaluate(node => { node.scrollTop -= 170; node.dispatchEvent(new WheelEvent('wheel', { deltaY: -170 })); node.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const found = await blank(); worst = Math.max(worst, found.top, found.bottom); widest = Math.max(widest, found.rows);
 }
 assert.equal(worst, 0, `no blank spacer is ever visible while scrolling (${worst}px)`);
 assert.ok(widest <= 120, `DOM stays bounded (${widest} rows)`);
 console.log(`History blank space: none while scrolling 600 mixed rows; at most ${widest} rows mounted.`);
} finally { await browser.close(); }
