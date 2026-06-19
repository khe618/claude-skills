import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkTaskToPr, stallTrigger, findStalledTasks } from '../scripts/attention.mjs';

const task = (raw) => ({ raw, fields: {} });

test('linkTaskToPr resolves a same-repo pull URL', () => {
  assert.deepEqual(linkTaskToPr(task('Evidence: https://github.com/khe618/x/pull/9'), 'khe618/x'), { prNumber: 9 });
});

test('linkTaskToPr ignores other-repo URLs', () => {
  assert.equal(linkTaskToPr(task('https://github.com/other/y/pull/3'), 'khe618/x'), null);
});

test('linkTaskToPr returns null on multiple distinct same-repo PRs (ambiguous)', () => {
  assert.equal(linkTaskToPr(task('see https://github.com/khe618/x/pull/12 and https://github.com/khe618/x/pull/9'), 'khe618/x'), null);
});

test('linkTaskToPr falls back to a branch token', () => {
  assert.deepEqual(linkTaskToPr(task('Working branch: feat/export-button'), 'khe618/x'), { branch: 'feat/export-button' });
});

test('stallTrigger maps definitive states only', () => {
  assert.equal(stallTrigger({ prState: 'MERGED' }), 'merged-open');
  assert.equal(stallTrigger({ prState: 'CLOSED' }), 'closed');
  assert.equal(stallTrigger({ prState: 'OPEN', mergeable: 'CONFLICTING' }), 'conflicts');
  assert.equal(stallTrigger({ prState: 'OPEN', checks: 'failing' }), 'ci');
  assert.equal(stallTrigger({ prState: 'OPEN', reviewDecision: 'CHANGES_REQUESTED' }), 'changes');
  assert.equal(stallTrigger({ prState: 'OPEN', mergeable: 'MERGEABLE', checks: 'passing' }), null);
});

test('findStalledTasks links in-progress tasks, fetches via ghView, flags stalled', () => {
  const repos = [{ slug: 'khe618/x', tasks: [
    { num: 1, state: 'in progress', title: 'A', raw: 'Evidence: https://github.com/khe618/x/pull/9' },
    { num: 2, state: 'in progress', title: 'B', raw: 'Evidence: https://github.com/khe618/x/pull/5' },
    { num: 3, state: 'open', title: 'C', raw: 'https://github.com/khe618/x/pull/7' }, // not in-progress → skipped
  ] }];
  const ghView = (slug, ref) => ({
    9: { prState: 'MERGED', number: 9, url: 'u9' },
    5: { prState: 'OPEN', mergeable: 'MERGEABLE', checks: 'passing', number: 5, url: 'u5' },
  }[ref.prNumber] || null);
  const out = findStalledTasks(repos, ghView);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { repo: 'khe618/x', taskNum: 1, taskTitle: 'A', prNumber: 9, prUrl: 'u9', trigger: 'merged-open' });
});
