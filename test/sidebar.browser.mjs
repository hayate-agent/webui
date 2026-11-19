import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const css = await readFile(new URL('../dashboard/public/style.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  // Match the delivered PI mount: aside > section > h2, create button,
  // div > session buttons. It supplies no classes; do not add fixture-only ones.
  for (const workspace of [false, true]) {
    for (const [width, height] of [[320, 700], [390, 844], [650, 900], [760, 700], [761, 700], [1280, 900], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>
        <aside aria-label="Conversations"><div class="brand">hayate</div><button id="new">＋ New chat</button>
          <input id="search" placeholder="Find a conversation"><nav id="chats" ${workspace ? 'class="workspace-tree"' : ''}><button>Retained Hayate conversation</button></nav>
          <footer>No external services or browser-side keys.</footer><button id="account-settings">Account settings</button><button id="sign-out">Sign out</button>
          ${[1, 2].map(n => `<section><h2>PI · pi-mac-work-${'long-agent-name-'.repeat(n * 4)}</h2><button>＋ New PI session</button><div>${Array.from({ length: 18 }, (_, i) => `<button>Session ${i} · tui · /Users/example/Work/Development/${'unbroken-path-'.repeat(12)}</button>`).join('')}</div></section>`).join('')}
        </aside>
        <main ${workspace ? 'class="workspace-screen"' : ''}><header><h1>New chat</h1></header><section ${workspace ? 'class="workspace-content"' : 'id="conversation"'}>Main conversation remains visible.</section>
        <form ${workspace ? 'class="workspace-composer"' : 'id="composer"'}><textarea aria-label="Message" rows="3"></textarea><button>Send</button></form></main>
      </body></html>`);
      const result = await page.evaluate(() => {
        const aside = document.querySelector('aside'), main = document.querySelector('main');
        const a = aside.getBoundingClientRect(), m = main.getBoundingClientRect();
        const composer = main.querySelector('form').getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          asideOverflow: aside.scrollWidth > aside.clientWidth,
          compact: [...aside.querySelectorAll('h2')].every(h => parseFloat(getComputedStyle(h).fontSize) <= 14),
          contained: [...aside.querySelectorAll('section button')].every(b => b.getBoundingClientRect().right <= a.right),
          mainVisible: m.left >= 0 && m.right <= innerWidth && m.height >= 180 && m.bottom <= innerHeight + 1,
          composerVisible: composer.top >= m.top && composer.bottom <= innerHeight + 1,
          scrollable: aside.scrollHeight > aside.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(aside).overflowY),
        };
      });
      assert.deepEqual(result, { overflow: false, asideOverflow: false, compact: true, contained: true, mainVisible: true, composerVisible: true, scrollable: true }, `${width}x${height}, workspace=${workspace}`);
      await page.locator('aside > section:last-child button:last-child').last().scrollIntoViewIfNeeded();
      assert.ok(await page.locator('aside > section:last-child button:last-child').last().isVisible());
      if (process.env.HAYATE_LAYOUT_SCREENSHOT && width === 390 && workspace) {
        await page.locator('aside').evaluate(el => { el.scrollTop = 0; });
        await page.screenshot({ path: process.env.HAYATE_LAYOUT_SCREENSHOT });
      }
    }
  }
  console.log('Sidebar layout: 14 viewport/mode combinations passed; compact PI headings, long labels, scrollable sidebar and visible main/composer.');
} finally { await browser.close(); }
