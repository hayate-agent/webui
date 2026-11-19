import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createOwnerServer } from '../pi-adapter/owner-server.mjs';
import { createPiService } from '../pi-adapter/service.mjs';
import { createDashboard } from '../server/server.mjs';

test('real PI TUI registers and serves owner commands over private connector', { skip: !process.env.PI_WEBUI_NATIVE_TEST || process.platform !== 'darwin', timeout: 25000 }, async () => {
 const temp = await mkdtemp(path.join(os.tmpdir(), 'pi-tui-native-'));
 const home = path.join(temp, 'agent'), directory = path.join(temp, 'bridge'); await mkdir(home);
 let requests = 0;
 const provider = createServer(async (req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  for await (const _chunk of req) { /* Drain only isolated fixture prompts. */ }
  requests++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  chunk({ role: 'assistant', content: 'Live native ' }); chunk({ content: 'TUI answer' }); chunk({}, 'stop'); res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
 await writeFile(path.join(home, 'models.json'), JSON.stringify({ providers: { 'bridge-fixture': { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', models: [{ id: 'fixture', contextWindow: 32000, maxTokens: 1000 }] } } }));
 const browserMode = process.env.PI_WEBUI_BROWSER_NATIVE_TEST === '1';
 const adapter = browserMode ? await createPiService({ directory, roots: [temp] }) : undefined;
 const bridge = adapter?.owners ?? await createOwnerServer(directory);
 let browser, dashboard, hayate;
 const extension = fileURLToPath(new URL('../pi-adapter/extension.mjs', import.meta.url));
 // Python's standard-library pty gives PI a real terminal and forwards bytes.
 const driver = `import os,pty,sys,select,signal,fcntl,termios,struct\npid,fd=pty.fork()\nif pid==0: os.execvp('pi',sys.argv[1:])\nfcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))\ndef stop(*args):\n try: os.kill(pid,signal.SIGTERM)\n except ProcessLookupError: pass\nsignal.signal(signal.SIGTERM,stop)\ntry:\n while True:\n  ready,_,_=select.select([fd,0],[],[],1)\n  if fd in ready:\n   try: data=os.read(fd,65536)\n   except OSError: break\n   if not data: break\n   os.write(1,data)\n  if 0 in ready:\n   data=os.read(0,65536)\n   if data: os.write(fd,data)\n   else: stop(); break\nfinally:\n stop(); os.waitpid(pid,0)\n`;
 const child = spawn('python3', ['-c', driver, 'pi', '--provider', 'bridge-fixture', '--model', 'fixture', '--api-key', 'fixture', '--offline', '--no-extensions', '--no-skills', '--no-context-files', '--no-approve', '--session-dir', path.join(temp, 'sessions'), '-e', extension], {
  cwd: temp, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TERM: 'xterm-256color', PI_CODING_AGENT_DIR: home, PI_WEBUI_BRIDGE_DIR: directory, PI_OFFLINE: '1' },
 });
 let output = ''; child.stdout.on('data', bytes => { output = (output + bytes).slice(-12000); }); child.stderr.resume();
 const exit = new Promise(resolve => child.once('exit', resolve));
 try {
  const registered = await new Promise((resolve, reject) => {
   const timer = setTimeout(() => { bridge.events.off('change', inspect); reject(Error('Native TUI registration timed out: ' + output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-1500))); }, 15000);
   const inspect = () => { const owner = bridge.list()[0]; if (owner) { clearTimeout(timer); bridge.events.off('change', inspect); resolve(owner); } };
   bridge.events.on('change', inspect); inspect();
  });
  assert.equal(registered.cwd, await realpath(temp));
  const snapshot = await bridge.command(registered.id, 'snapshot');
  assert.ok(Array.isArray(snapshot.entries)); assert.equal(snapshot.busy, false);
  let streamed = '';
  const settled = new Promise((resolve, reject) => {
   const timer = setTimeout(() => { bridge.events.off('event', observe); reject(Error('Native prompt did not settle')); }, 10000);
   const observe = ({ event }) => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') streamed += event.assistantMessageEvent.delta;
    if (event.type === 'agent_settled') { clearTimeout(timer); bridge.events.off('event', observe); resolve(); }
   }; bridge.events.on('event', observe);
  });
  if (browserMode) {
   hayate = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/auth') return res.end('{"required":false,"authenticated":true}');
    if (req.url === '/api/state') return res.end('{"agent":"Hayate fixture","backends":{"workspaces":1},"chats":[]}');
    if (req.url === '/api/workspace/capabilities') return res.end('{"workspaces":1}');
    if (req.url === '/api/workspace/state') return res.end('{"agent":"Hayate fixture","projects":[],"streams":[],"settings":{}}');
    if (req.url.includes('events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
    res.writeHead(404); res.end('{}');
   });
   await new Promise(resolve => hayate.listen(0, '127.0.0.1', resolve));
   const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
   const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
   const origin = `http://127.0.0.1:${port}`;
   dashboard = await createDashboard({ origin, upstream: `http://127.0.0.1:${hayate.address().port}`, piUpstream: `http://127.0.0.1:${adapter.server.address().port}` });
   const { chromium } = await import('playwright'); browser = await chromium.launch({ headless: true });
   const page = await browser.newPage(), errors = [];
   page.on('pageerror', error => errors.push(error.message));
   await page.goto(origin);
   await page.getByLabel('Active agent', { exact: true }).waitFor();
   await page.getByRole('button', { name: /PI session · tui/ }).click();
   const dialog = page.locator('dialog[open]');
   await dialog.locator('textarea').fill('Respond with the fixture answer');
   await dialog.getByRole('button', { name: 'Send', exact: true }).click();
   await dialog.getByText('Live native TUI answer', { exact: true }).waitFor();
   assert.deepEqual(errors, []);
  } else await bridge.command(registered.id, 'prompt', { text: 'Respond with the fixture answer' });
  await settled;
  assert.equal(requests, 1); assert.equal(streamed, 'Live native TUI answer');
  const after = await bridge.command(registered.id, 'snapshot');
  assert.ok(after.entries.some(entry => entry.message?.role === 'assistant'));
  await bridge.command(registered.id, 'rename', { name: 'Isolated live TUI' });
  await bridge.command(registered.id, 'abort');
  const admission = await bridge.command(registered.id, 'reload');
  assert.equal(admission.completion, 'reconnect-required');
  const deadline = Date.now() + 8000;
  let reconnected = false;
  bridge.events.on('change', () => { if (bridge.list().some(owner => owner.id === registered.id)) reconnected = true; });
  while (!reconnected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(reconnected, true, 'actual native reload reconnects the same session');
  const resumed = await bridge.command(registered.id, 'snapshot');
  assert.ok(resumed.entries.some(entry => entry.message?.role === 'assistant'), 'reload retains native history');
 } finally {
  // Idle native exit via terminal EOF; signal only this isolated test process
  // if it does not exit promptly. No user PI processes are touched.
  await browser?.close(); await dashboard?.stop();
  if (hayate) { hayate.closeAllConnections(); await new Promise(resolve => hayate.close(resolve)); }
  child.stdin.write('\x04');
  const timer = setTimeout(() => child.kill('SIGTERM'), 2000);
  await exit; clearTimeout(timer); if (adapter) await adapter.stop(); else await bridge.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(temp, { recursive: true, force: true });
 }
});
