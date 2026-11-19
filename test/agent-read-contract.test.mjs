import test from 'node:test';
import assert from 'node:assert/strict';
// Cross-repository route contract is verified against its actual owner when
// available. The WebUI does not invent backend support or convert GET to POST.
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
test('GET agent contract rejects mutations, including mutations hidden in PI routes', async t => {
 const file = process.env.HAYATE_WORKSPACE_HTTP_SOURCE;
 if (!file) { t.skip('Set HAYATE_WORKSPACE_HTTP_SOURCE for backend contract test'); return; }
 await access(file);
 const { validateAgentRead } = await import(pathToFileURL(path.resolve(file)).href);
 assert.equal(validateAgentRead('messages', { action: 'read', streamId: 'session' }).capability, 'messages');
 assert.doesNotThrow(() => validateAgentRead('messages', { action: 'pi-chats', operation: 'preview' }));
 for (const input of [{ action: 'send' }, { action: 'pi-chats', operation: 'set' }, { action: 'pi', route: '/api/pi/sessions/session/abort' }]) assert.throws(() => validateAgentRead('messages', input), /Read-only/);
 assert.throws(() => validateAgentRead('streams', { action: 'fork' }), /Read-only/);
});
