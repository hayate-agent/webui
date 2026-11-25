import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverAgent, mergeSnapshot } from '../dashboard/public/agent-discovery.js';

for (const streamsFail of [false, true]) for (const projectsFail of [false, true]) {
  test(`discovery retains successful responses: streamsFail=${streamsFail}, projectsFail=${projectsFail}`, async () => {
    const streams = [{ id: 'legacy-chat', projectId: null }];
    const projects = [{ id: 'project' }];
    const calls = [];
    const snapshot = await discoverAgent(async (capability, input) => {
      calls.push([capability, input]);
      if (capability === 'streams') {
        if (streamsFail) throw Error('unavailable');
        return { streams, features: ['standalone-chats'] };
      }
      if (projectsFail) throw Error('unavailable');
      return { projects };
    });
    assert.deepEqual(snapshot.streams, streamsFail ? [] : streams);
    assert.deepEqual(snapshot.projects, projectsFail ? [] : projects);
    assert.equal(snapshot.unavailable, streamsFail && projectsFail);
    assert.equal(snapshot.incomplete, streamsFail !== projectsFail);
    assert.deepEqual(snapshot.features, streamsFail ? undefined : ['standalone-chats']);
    assert.deepEqual(calls, [['streams', { action: 'list' }], ['projects', { action: 'list' }]]);
    assert.equal(streams.length, 1);
  });
}

test('a PI stream list without projects never leaves the sidebar lists undefined', () => {
  const known = { projects: [{ id: 'p' }], streams: [{ id: 'old' }], features: ['pi-live-v1'] };
  const merged = mergeSnapshot(known, { streams: [{ id: 'new' }], features: ['pi-live-v1'] });
  assert.deepEqual(merged.projects, [{ id: 'p' }]);
  assert.deepEqual(merged.streams, [{ id: 'new' }]);
  const cold = mergeSnapshot(undefined, { streams: [{ id: 'new' }] });
  assert.deepEqual(cold.projects, []);
  assert.deepEqual(mergeSnapshot(undefined, {}).streams, []);
  assert.deepEqual(mergeSnapshot({ projects: [{ id: 'p' }] }, { projects: [] }).projects, []);
  assert.deepEqual(mergeSnapshot({ streams: [{ id: 'old' }] }, { features: [] }).streams, [{ id: 'old' }]);
});
