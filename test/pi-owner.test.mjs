import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createOwnerServer } from '../pi-adapter/owner-server.mjs';

test('private dedicated service registers an owner and routes correlated commands', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-webui-'));
 const server = await createOwnerServer(directory);
 const peer = net.createConnection(server.socketPath); peer.setEncoding('utf8');
 try {
  await once(peer, 'connect');
  const ready = once(peer, 'data');
  peer.write(JSON.stringify({ type: 'register', sessionId: 'test-session', cwd: directory, name: 'Test' }) + '\n');
  assert.equal(JSON.parse((await ready)[0]).type, 'registered');
  assert.equal(server.list()[0].id, 'test-session');
  const incoming = once(peer, 'data');
  const result = server.command('test-session', 'snapshot');
  const command = JSON.parse((await incoming)[0]);
  peer.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: { busy: false } }) + '\n');
  assert.deepEqual(await result, { busy: false });
  await assert.rejects(server.command('test-session', 'bash'), /Unsupported/);
  await assert.rejects(server.command('missing', 'snapshot'), /no connected owner/);
 } finally { peer.destroy(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('legacy owner snapshot above 8 MiB remains connected for long sessions', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-large-'));
 const server = await createOwnerServer(directory);
 const peer = net.createConnection(server.socketPath); peer.setEncoding('utf8');
 try {
  await once(peer, 'connect'); const ready = once(peer, 'data');
  peer.write(JSON.stringify({ type: 'register', sessionId: 'long-session', cwd: directory }) + '\n'); await ready;
  const incoming = once(peer, 'data'); const result = server.command('long-session', 'snapshot');
  const duplicate = server.command('long-session', 'snapshot');
  assert.equal(duplicate, result, 'concurrent snapshot readers share one native command');
  const command = JSON.parse((await incoming)[0]);
  peer.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: { entries: [], padding: 'x'.repeat(9 * 1024 * 1024) } }) + '\n');
  assert.equal((await result).padding.length, 9 * 1024 * 1024);
  assert.equal(server.list()[0].id, 'long-session');
  await duplicate;
  const nextCommand = once(peer, 'data');
  const next = server.command('long-session', 'snapshot');
  assert.notEqual(next, result, 'completed snapshot is not cached across refreshes');
  const nextRecord = JSON.parse((await nextCommand)[0]);
  peer.write(JSON.stringify({ type: 'response', id: nextRecord.id, success: true, data: { busy: true } }) + '\n');
  assert.deepEqual(await next, { busy: true });
 } finally { peer.destroy(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unsafe directory and second daemon are rejected without taking over socket', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-webui-'));
 try {
  await chmod(directory, 0o755);
  await assert.rejects(createOwnerServer(directory), /private/);
  await chmod(directory, 0o700);
  const server = await createOwnerServer(directory);
  try { await assert.rejects(createOwnerServer(directory), /EADDRINUSE/); }
  finally { await server.close(); }
 } finally { await rm(directory, { recursive: true, force: true }); }
});

test('duplicate session owner is refused; disconnect makes command outcome explicit', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-webui-'));
 const server = await createOwnerServer(directory);
 const first = net.createConnection(server.socketPath); first.setEncoding('utf8');
 try {
  await once(first, 'connect'); const ready = once(first, 'data');
  const record = JSON.stringify({ type: 'register', sessionId: 'same', cwd: directory }) + '\n';
  first.write(record); await ready;
  const second = net.createConnection(server.socketPath);
  await once(second, 'connect'); const closed = once(second, 'close'); second.write(record); await closed;
  assert.equal(server.list().length, 1);
  const result = assert.rejects(server.command('same', 'prompt', { text: 'hello' }), /outcome may be unknown/);
  first.destroy(); await result;
 } finally { first.destroy(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
