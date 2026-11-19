import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RpcOwner } from '../pi-adapter/rpc-owner.mjs';
function fixture() {
 const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
 const owner = new RpcOwner({ cwd: '/tmp', spawnProcess: () => child }), commands = [];
 child.stdin.on('data', bytes => commands.push(JSON.parse(bytes)));
 const reply = (index, success, data = {}) => child.stdout.write(JSON.stringify({ type: 'response', id: commands[index].id, success, data }) + '\n');
 return { owner, child, commands, reply };
}
test('explicit rejection releases only local reservation, allowing retry', async () => {
 const { owner, reply } = fixture();
 const rejected = assert.rejects(owner.command('prompt', { message: 'reject' }), /rejected/);
 reply(0, false); await rejected; assert.equal(owner.busy, false);
 const retry = owner.command('prompt', { message: 'retry' }); reply(1, true, { disposition: 'started' }); await retry; owner.fail();
});
test('idle snapshot cannot erase prompt reservation before agent_start', async () => {
 const { owner, reply } = fixture();
 const first = owner.command('prompt', { message: 'first' }); reply(0, true, { disposition: 'started' }); await first;
 const snapshot = owner.snapshot(); reply(1, true, { isStreaming: false, isCompacting: false });
 await Promise.resolve(); reply(2, true, { entries: [], leafId: null }); await snapshot;
 assert.equal(owner.busy, true);
 await assert.rejects(owner.command('prompt', { message: 'second' }), /choose steer/); owner.fail();
});
