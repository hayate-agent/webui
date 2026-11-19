import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RpcOwner } from '../pi-adapter/rpc-owner.mjs';
test('RPC dialog answers validate options and first client wins without command ack', () => {
 const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
 const owner = new RpcOwner({ cwd: '/tmp', spawnProcess: () => child });
 let sent; child.stdin.on('data', bytes => { sent = JSON.parse(bytes); });
 child.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'question', method: 'select', options: ['Allow', 'Deny'] }) + '\n');
 assert.throws(() => owner.respondToDialog('question', { value: 'Invented' }), /Invalid/);
 assert.deepEqual(owner.respondToDialog('question', { value: 'Deny' }), { submitted: true });
 assert.deepEqual(sent, { type: 'extension_ui_response', id: 'question', value: 'Deny' });
 assert.throws(() => owner.respondToDialog('question', { value: 'Allow' }), /expired/);
 child.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'timed', method: 'confirm', timeout: -1 }) + '\n');
 assert.throws(() => owner.respondToDialog('timed', { confirmed: true }), /expired/);
 owner.fail();
});
