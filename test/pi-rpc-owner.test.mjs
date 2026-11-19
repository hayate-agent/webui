import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RpcOwner } from '../pi-adapter/rpc-owner.mjs';

test('RPC owner reserves busy status before prompt response and refuses ambiguous concurrent input', async () => {
 const child = new EventEmitter();
 child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
 const owner = new RpcOwner({ cwd: '/tmp', spawnProcess: () => child });
 const commands = []; child.stdin.on('data', data => commands.push(JSON.parse(data.toString())));
 const first = owner.command('prompt', { message: 'first' });
 await assert.rejects(owner.command('prompt', { message: 'ambiguous' }), /choose steer/);
 assert.equal(commands.length, 1);
 child.stdout.write(JSON.stringify({ type: 'response', id: commands[0].id, success: true, data: { disposition: 'started' } }) + '\n');
 await first;
 const steer = owner.command('prompt', { message: 'explicit', streamingBehavior: 'steer' });
 child.stdout.write(JSON.stringify({ type: 'response', id: commands[1].id, success: true, data: { disposition: 'queued' } }) + '\n'); await steer;
 child.stdout.write('{"type":"agent_settled"}\n'); assert.equal(owner.busy, false);
 owner.fail();
});
