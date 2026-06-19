import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizePr, recentMerged, newOpenPrs, prSummary } from '../scripts/pr-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, '../fixtures/sample-pr.json'), 'utf8'));

test('normalizes core fields and passing checks', () => {
  const pr = normalizePr(raw, 'open');
  assert.equal(pr.number, 6);
  assert.equal(pr.branch, 'gate-open-multiplayer-room-entry');
  assert.equal(pr.checks, 'passing');
  assert.deepEqual(pr.files, ['components/exercises/trade-or-tighten/lobby.js']);
});

test('normalizePr surfaces createdAt, url, reviewDecision, prState', () => {
  const pr = normalizePr(raw, 'open');
  assert.equal(pr.createdAt, '2026-06-18T12:00:00Z');
  assert.equal(pr.url, 'https://github.com/khe618/traderprep/pull/6');
  assert.equal(pr.reviewDecision, 'REVIEW_REQUIRED');
  assert.equal(pr.prState, 'OPEN');
});

test('newOpenPrs keeps only open PRs created after the cutoff', () => {
  const cutoff = Date.parse('2026-06-18T06:30:00Z');
  const before = normalizePr({ ...raw, createdAt: '2026-06-17T00:00:00Z' }, 'open');
  const after = normalizePr({ ...raw, createdAt: '2026-06-18T12:00:00Z' }, 'open');
  const merged = normalizePr({ ...raw, state: 'MERGED', createdAt: '2026-06-18T13:00:00Z' }, 'merged');
  const out = newOpenPrs([before, after, merged], cutoff);
  assert.deepEqual(out.map((p) => p.createdAt), ['2026-06-18T12:00:00Z']);
});

test('prSummary takes the first meaningful body line, else the title', () => {
  assert.equal(prSummary(normalizePr(raw, 'open')), 'Adds the trial wall to open multiplayer room entry.');
  assert.equal(prSummary(normalizePr({ ...raw, body: '' }, 'open')), raw.title);
});

test('failing check wins', () => {
  const pr = normalizePr({ ...raw, statusCheckRollup: [{ conclusion: 'FAILURE' }] }, 'open');
  assert.equal(pr.checks, 'failing');
});

test('empty rollup is none', () => {
  const pr = normalizePr({ ...raw, statusCheckRollup: [] }, 'open');
  assert.equal(pr.checks, 'none');
});

test('recentMerged filters by window', () => {
  const now = Date.parse('2026-06-17T00:00:00Z');
  const prs = [
    normalizePr({ ...raw, mergedAt: '2026-06-15T00:00:00Z' }, 'merged'),
    normalizePr({ ...raw, mergedAt: '2026-06-01T00:00:00Z' }, 'merged'),
  ];
  const out = recentMerged(prs, 7, now);
  assert.equal(out.length, 1);
});
