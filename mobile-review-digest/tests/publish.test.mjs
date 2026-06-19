import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish } from '../scripts/publish.mjs';

const base = (over) => ({ siteDir: mkdtempSync(join(tmpdir(), 'pub-')), date: '2026-06-19',
  generatedAt: 'x', since: 's', now: Date.now(), repos: [{ slug: 'r', newPrs: [], tasks: [], prError: false }],
  priorScheduledAt: '2026-06-18T06:30:00Z', nowISO: '2026-06-19T06:30:00Z',
  deployFn: () => ({ ok: true, url: 'https://x.vercel.app', error: null }), ...over });

test('scheduled-core + all repos ok advances the cutoff', () => {
  const args = base({ mode: 'scheduled-core', allReposOk: true });
  publish(args);
  const lr = JSON.parse(readFileSync(join(args.siteDir, 'last-run.json'), 'utf8'));
  assert.equal(lr.lastScheduledRunAt, '2026-06-19T06:30:00Z');
  assert.equal(lr.status, 'core');
});

test('on-demand keeps the prior cutoff', () => {
  const args = base({ mode: 'on-demand', allReposOk: true });
  publish(args);
  const lr = JSON.parse(readFileSync(join(args.siteDir, 'last-run.json'), 'utf8'));
  assert.equal(lr.lastScheduledRunAt, '2026-06-18T06:30:00Z');
});

test('scheduled-core with a repo error keeps the prior cutoff', () => {
  const args = base({ mode: 'scheduled-core', allReposOk: false });
  publish(args);
  const lr = JSON.parse(readFileSync(join(args.siteDir, 'last-run.json'), 'utf8'));
  assert.equal(lr.lastScheduledRunAt, '2026-06-18T06:30:00Z');
});

test('a failed deploy is recorded as deploy-failed (not enrichable)', () => {
  const args = base({ mode: 'scheduled-core', allReposOk: true, deployFn: () => ({ ok: false, url: null, error: 'boom' }) });
  publish(args);
  const lr = JSON.parse(readFileSync(join(args.siteDir, 'last-run.json'), 'utf8'));
  assert.equal(lr.status, 'deploy-failed');
});
