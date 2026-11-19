import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RpcOwner } from '../pi-adapter/rpc-owner.mjs';
function fixture(timeout = 1000) {
 const child = new EventEmitter(); child.pid = 123;
 child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
 const owner = new RpcOwner({ cwd: '/tmp', spawnProcess: () => child, shutdownTimeoutMs: timeout });
 return { child, owner };
}
test('shutdown waits for actual exit even after command channel failure', async () => {
 const { child, owner } = fixture(); owner.fail();
 let completed = false; const closing = owner.close().then(() => { completed = true; });
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(completed, false); assert.equal(child.stdin.writableEnded, true);
 assert.equal(owner.close(), owner.close());
 child.emit('exit', 0); await closing; assert.equal(completed, true);
});
test('shutdown deadline reports retained owner rather than claiming exit', async () => {
 const { child, owner } = fixture(10);
 await assert.rejects(owner.close(), /owner retained/);
 assert.equal(owner.exited, undefined);
 await assert.rejects(owner.command('get_state'), /unavailable/);
 child.emit('exit', 0); await owner.close();
});
test('spawn failure has no child to wait for', async () => {
 const { child, owner } = fixture(); child.pid = undefined;
 child.emit('error', Error('spawn failed')); await owner.close();
 assert.equal(owner.exited, true);
});
