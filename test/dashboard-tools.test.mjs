import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolProvider, normalizeMode, ToolRefused, DEFAULT_MODE } from '../dashboard/public/dashboard-tools.js';

const tools = [{ name: 'list_tickets', kind: 'read' }, { name: 'close_ticket', kind: 'write' }, { name: 'mystery' }];
const setup = (mode, confirmAnswer) => {
  const calls = [], asked = [], log = [];
  const provider = createToolProvider({ mode, tools, call: async (name, args) => { calls.push([name, args]); return { ok: name }; },
    confirm: async request => { asked.push(request); return confirmAnswer; }, audit: entry => log.push(entry) });
  return { provider, calls, asked, log };
};

test('the default and every unknown value is strict', () => {
  assert.equal(DEFAULT_MODE, 'strict');
  for (const value of [undefined, null, '', 'maybe', 'OPEN ', 'true', 1, {}]) assert.equal(normalizeMode(value), value === 'OPEN ' ? 'open' : 'strict', String(value));
  assert.equal(normalizeMode(' Off '), 'off');
});

test('strict: reads run without asking', async () => {
  const { provider, calls, asked } = setup('strict', false);
  assert.deepEqual(await provider.list_tickets({ q: 1 }), { ok: 'list_tickets' });
  assert.deepEqual(calls, [['list_tickets', { q: 1 }]]); assert.equal(asked.length, 0);
});

test('strict: a write is only called after an explicit yes, and only for that call', async () => {
  const yes = setup('strict', true);
  assert.deepEqual(await yes.provider.close_ticket({ id: 42 }), { ok: 'close_ticket' });
  assert.deepEqual(yes.asked, [{ tool: 'close_ticket', args: { id: 42 } }]);
  await yes.provider.close_ticket({ id: 43 }); assert.equal(yes.asked.length, 2, 'asked again for the second call');
  const no = setup('strict', false);
  await assert.rejects(no.provider.close_ticket({ id: 1 }), ToolRefused);
  assert.equal(no.calls.length, 0, 'nothing was sent to the agent');
  assert.deepEqual(no.log, [{ tool: 'close_ticket', kind: 'write', outcome: 'declined' }]);
});

test('strict: only a literal true confirms; a throwing or truthy-but-not-true answer refuses', async () => {
  for (const answer of ['yes', 1, {}, undefined, null]) { const s = setup('strict', answer); await assert.rejects(s.provider.close_ticket({}), ToolRefused, String(answer)); assert.equal(s.calls.length, 0); }
  const throwing = createToolProvider({ mode: 'strict', tools, call: async () => assert.fail('must not be called'), confirm: async () => { throw new Error('dialog crashed'); } });
  await assert.rejects(throwing.close_ticket({}), ToolRefused);
});

test('strict: a tool without a kind is treated as a write', async () => {
  const s = setup('strict', false);
  await assert.rejects(s.provider.mystery({}), ToolRefused); assert.equal(s.calls.length, 0);
});

test('tools the agent does not offer are not in the map; broken entries are ignored', () => {
  const { provider } = setup('strict', true);
  assert.deepEqual(Object.keys(provider).sort(), ['close_ticket', 'list_tickets', 'mystery']);
  assert.equal(provider.delete_everything, undefined);
  const odd = createToolProvider({ mode: 'strict', tools: [null, {}, { name: '' }, { name: 5 }, { name: 'ok', kind: 'read' }], call: async () => 1 });
  assert.deepEqual(Object.keys(odd), ['ok']);
});

test('off: no tool is available at all', () => {
  assert.deepEqual(Object.keys(setup('off', true).provider), []);
});

test('open: writes run without any confirmation (explicit, unsafe switch)', async () => {
  const s = setup('open', false);
  assert.deepEqual(await s.provider.close_ticket({ id: 7 }), { ok: 'close_ticket' });
  assert.equal(s.asked.length, 0); assert.deepEqual(s.calls, [['close_ticket', { id: 7 }]]);
});

test('transport errors are audited and re-thrown', async () => {
  const log = [];
  const provider = createToolProvider({ mode: 'strict', tools, call: async () => { throw new Error('agent down'); }, audit: entry => log.push(entry) });
  await assert.rejects(provider.list_tickets({}), /agent down/);
  assert.deepEqual(log, [{ tool: 'list_tickets', kind: 'read', outcome: 'error' }]);
});
