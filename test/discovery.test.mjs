import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverAgent } from '../dashboard/public/workspace-client.js';

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
