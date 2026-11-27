import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createDashboard } from '../server/server.mjs';

// "Invite outbound agent": the operator gets ONE prompt with the dashboard URL and the code already inside,
// copies it with one click and pastes it into the target agent. Nothing has to be typed or assembled by hand.
const invites = [];
const PROMPT = 'Connect this agent to the central Hayate dashboard "https://dash.example.org" as "Minerva".\nInvitation code: SECRET-CODE-123';
const backend = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const out = value => res.end(JSON.stringify(value));
  if (req.url === '/api/auth') return out({ required: false, authenticated: true });
  if (req.url === '/api/state') return out({ agent: 'Central', backends: { workspaces: 1 }, chats: [] });
  if (req.url === '/api/preferences') return out({ theme: 'green', mode: 'system', hidden: [], name: '' });
  if (req.url === '/api/workspace/capabilities') return out({ workspaces: 1, 'agent-hub': 1, 'agent-link-relay': 1, 'local-agent': false, 'project-creation': false });
  if (req.url === '/api/workspace/state') return out({ agent: 'Central', projects: [], streams: [], settings: {} });
  if (req.url === '/api/workspace/agents') return out({ agents: [], adapters: ['hayate', 'hayate-wss'] });
  if (req.url === '/api/workspace/agent-relay' && req.method === 'GET') return out({ agents: [] });
  if (req.url === '/api/workspace/agent-relay' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk; invites.push(JSON.parse(raw));
    res.statusCode = 201; return out({ code: 'SECRET-CODE-123', expiresAt: Date.now() + 3600000, endpoint: 'https://dash.example.org', transport: 'hayate-wss', ...(process.env.NO_PROMPT ? {} : { prompt: PROMPT }) });
  }
  return out({});
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${backend.address().port}` });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click();
  await page.getByRole('button', { name: 'Invite outbound agent' }).click();
  await page.getByLabel('Agent name').fill('Minerva');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const prompt = page.getByLabel('Prompt for the target agent');
  await prompt.waitFor();
  assert.deepEqual(invites, [{ name: 'Minerva' }]);
  assert.equal(await prompt.inputValue(), PROMPT, 'the prompt shown is exactly what the relay produced');
  assert.equal(await prompt.getAttribute('readonly') !== null, true);
  // It is the first thing in the dialog, before the code-only fallback.
  const order = await page.locator('.agent-management').first().evaluate(section => [...section.children].map(child => child.textContent.trim().slice(0, 60)));
  assert.ok(order[0].startsWith('Paste this into the target agent'), `prompt first, got ${order[0]}`);
  assert.ok(order.indexOf('Code only') > order.findIndex(text => text.startsWith('Copy prompt')), 'code-only fallback comes after the prompt');
  // One click puts the whole prompt on the clipboard and says so.
  await page.getByRole('button', { name: 'Copy prompt' }).click();
  await page.getByRole('status').filter({ hasText: 'Copied' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), PROMPT);
  // The code itself stays masked until the operator asks.
  assert.equal(await page.getByLabel('Outbound invitation code').getAttribute('type'), 'password');
  assert.deepEqual(errors, []);
  console.log('Enrollment prompt: shown first, copied in one click, code masked.');
} finally { await browser.close(); await dashboard.close?.(); backend.closeAllConnections?.(); backend.close(); }
setTimeout(() => process.exit(process.exitCode ?? 0), 50);
