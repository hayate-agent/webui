import test from 'node:test';
import assert from 'node:assert/strict';
import { webuiVersion } from '../scripts/version.mjs';

const rev = 'a'.repeat(39) + 'b';
const git = (answers = {}) => (...args) => { const key = args.join(' '); if (!(key in answers)) throw Error('no git'); return answers[key]; };

test('version counts up with every commit and names the revision', () => {
  const at = commits => webuiVersion({ pkg: { version: '0.2.1' }, git: git({ 'rev-parse HEAD': rev, 'rev-parse --is-shallow-repository': 'false', 'rev-list --count HEAD': String(commits) }) });
  assert.equal(at(113).version, '0.2.1+113.aaaaaaa');
  assert.equal(at(114).version, '0.2.1+114.aaaaaaa');
  assert.notEqual(at(113).version, at(114).version);
  assert.equal(at(114).revision, rev);
});
test('image builds without .git take revision and commit count from build arguments', () => {
  const result = webuiVersion({ pkg: { version: '0.2.1' }, git: git(), env: { HAYATE_WEBUI_REVISION: rev, HAYATE_WEBUI_COMMITS: '120' } });
  assert.equal(result.version, '0.2.1+120.aaaaaaa');
});
test('a git archive carries its revision via export-subst, an unexpanded placeholder is ignored', () => {
  assert.equal(webuiVersion({ pkg: { version: '0.2.1' }, git: git(), archived: rev + '\n' }).version, '0.2.1+aaaaaaa');
  assert.equal(webuiVersion({ pkg: { version: '0.2.1' }, git: git(), archived: '$Format:%H$\n' }).version, '0.2.1+unknown');
});
test('a shallow checkout never reports a wrong commit count', () => {
  const result = webuiVersion({ pkg: { version: '0.2.1' }, git: git({ 'rev-parse HEAD': rev, 'rev-parse --is-shallow-repository': 'true', 'rev-list --count HEAD': '1' }) });
  assert.equal(result.version, '0.2.1+aaaaaaa'); assert.equal(result.commits, null);
});
test('missing metadata is labelled unknown, never a fixed number; hostile inputs are ignored', () => {
  assert.equal(webuiVersion({ pkg: { version: '0.2.1' }, git: git() }).version, '0.2.1+unknown');
  assert.equal(webuiVersion({ pkg: { version: 'evil<script>' }, git: git() }).version, '0.0.0+unknown');
  const result = webuiVersion({ pkg: { version: '0.2.1' }, git: git(), env: { HAYATE_WEBUI_REVISION: 'not-a-revision', HAYATE_WEBUI_COMMITS: '-5' } });
  assert.equal(result.version, '0.2.1+unknown');
});
