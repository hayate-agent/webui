import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanToolList, connectDashboardTools } from '../dashboard/public/dashboard-bridge.js';
import { setDashboardContext, getDashboardContext, withDashboardContext } from '../dashboard/public/dashboard-context.js';

test('tool list: only valid names; anything not marked read counts as write; bounded; no duplicates', () => {
  const list = cleanToolList({ tools: [{ name: 'a', kind: 'read' }, { name: 'a', kind: 'write' }, { name: 'b' }, { name: 'c', kind: 'READ' }, { name: 'bad name' }, { name: '' }, null, { name: 5 }, { name: 'x'.repeat(81) }] });
  assert.deepEqual(list, [{ name: 'a', kind: 'read' }, { name: 'b', kind: 'write' }, { name: 'c', kind: 'write' }]);
  assert.equal(cleanToolList({ tools: Array.from({ length: 200 }, (_, i) => ({ name: 't' + i, kind: 'read' })) }).length, 64);
  for (const odd of [undefined, null, {}, { tools: 'x' }, []]) assert.deepEqual(cleanToolList(odd), []);
});

test('no agent, no request function, or a failing list => no tools (never all tools)', async () => {
  for (const args of [{}, { request: async () => ({}) }, { agentId: 'a' }, { agentId: 'a', request: async () => ({ tools: [{ name: 'x', kind: 'read' }] }) }]) assert.deepEqual((await connectDashboardTools(args)).tools, []);
  const failing = await connectDashboardTools({ agentId: 'a', streamId: 's', request: async () => { throw new Error('unsupported capability'); } });
  assert.deepEqual(failing.tools, []); await assert.rejects(failing.call('anything', {}));
});

test('calls go through the agent request path with its id; unlisted tools never leave the browser', async () => {
  const sent = [];
  const request = async (capability, input) => { sent.push([capability, input]); return input.op === 'list' ? { tools: [{ name: 'list_tickets', kind: 'read' }] } : { result: { rows: [1] } }; };
  const link = await connectDashboardTools({ agentId: 'pi-host', streamId: 's1', request });
  assert.deepEqual(await link.call('list_tickets', { q: 1 }), { rows: [1] });
  await assert.rejects(link.call('delete_all', {}), /Unknown dashboard tool/);
  assert.deepEqual(sent, [['messages', { action: 'dashboard-tools', op: 'list', streamId: 's1' }], ['messages', { action: 'dashboard-tools', op: 'call', streamId: 's1', tool: 'list_tickets', args: { q: 1 } }]]);
});

test('context needs both an agent and a request function', () => {
  setDashboardContext({ agentId: 'a' }); assert.equal(getDashboardContext(), undefined);
  setDashboardContext({ request() {} }); assert.equal(getDashboardContext(), undefined);
  const request = () => {}; setDashboardContext({ agentId: 'a', request }); assert.equal(getDashboardContext(), undefined, 'a conversation id is required');
  setDashboardContext({ agentId: 'a', streamId: 's', request, extra: 1 }); assert.deepEqual(getDashboardContext(), { agentId: 'a', streamId: 's', request });
  setDashboardContext(undefined); assert.equal(getDashboardContext(), undefined);
});

test('the context exists only while rendering, also after a throw, and never leaks to the next message', () => {
  const request = () => {};
  assert.equal(withDashboardContext({ agentId: 'a', streamId: 's', request }, () => getDashboardContext()?.agentId), 'a');
  assert.equal(getDashboardContext(), undefined);
  assert.throws(() => withDashboardContext({ agentId: 'a', streamId: 's', request }, () => { throw new Error('render failed'); }), /render failed/);
  assert.equal(getDashboardContext(), undefined);
});
