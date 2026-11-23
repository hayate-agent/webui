import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';
let loginBody;
const backend = createServer(async (req, res) => {
 res.setHeader('content-type', 'application/json');
 const out = value => res.end(JSON.stringify(value));
 if (req.url === '/api/auth') return out({ required: true, authenticated: false });
 if (req.url === '/api/auth/login') { let raw = ''; for await (const chunk of req) raw += chunk; loginBody = JSON.parse(raw); res.statusCode = 401; return out({ error: 'Wrong credentials' }); }
 res.writeHead(404); res.end('{}');
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(origin);
  const dialog = page.locator('dialog.auth-dialog');
  await dialog.waitFor();
  const has = async (locator, ...tokens) => { const classes = (await locator.getAttribute('class') ?? '').split(' '); return tokens.every(token => classes.includes(token)); };
  assert.ok(await has(dialog.locator('button[type="submit"]'), 'bg-primary', 'rounded-md', 'w-full'), 'Sign in is a full-width shadcn primary Button');
  for (const input of await dialog.locator('input').all()) assert.ok(await has(input, 'rounded-md', 'border-input'), 'sign-in fields are shadcn Inputs');
  assert.equal(await dialog.locator('input').count(), 2);
  await dialog.locator('input[type="text"]').fill('operator'); await dialog.locator('input[type="password"]').fill('wrong');
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('[role="alert"]').filter({ hasText: 'Wrong credentials' }).waitFor();
  assert.ok(await has(dialog.locator('[role="alert"]'), 'border-destructive/50', 'text-destructive'), 'sign-in error is a shadcn destructive Alert');
  assert.equal(loginBody.username, 'operator');
  await page.waitForFunction(() => !document.querySelector('dialog.auth-dialog button[type="submit"]').disabled);
  await page.waitForTimeout(400);
  assert.equal(await dialog.locator('button[type="submit"]').isEnabled(), true, 'Sign in is usable again after a failed attempt');
  assert.equal(await dialog.locator('button[type="submit"]').evaluate(e => getComputedStyle(e).opacity), '1', 'Sign in is not faded once enabled');
  await page.screenshot({ path: '/tmp/ui-login.png' });
  console.log('Login: sign-in dialog uses shadcn Input, Button and Alert passed');
} catch (error) { console.error(error); process.exitCode = 1; } finally { await browser.close(); backend.close(); process.exit(process.exitCode ?? 0); }
