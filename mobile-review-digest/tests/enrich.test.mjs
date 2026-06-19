import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spliceAttention, enrich } from '../scripts/enrich.mjs';

test('spliceAttention replaces the marker; no marker -> ok:false unchanged', () => {
  const r = spliceAttention('<a><!--ATTENTION-SLOT--><b>', '<section>X</section>');
  assert.equal(r.ok, true);
  assert.equal(r.html, '<a><section>X</section><b>');
  const r2 = spliceAttention('<a><b>', '<section>X</section>');
  assert.equal(r2.ok, false);
  assert.equal(r2.html, '<a><b>');
});

function site(status, date) {
  const dir = mkdtempSync(join(tmpdir(), 'enr-'));
  mkdirSync(join(dir, 'archive'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<body>core<!--ATTENTION-SLOT--></body>');
  writeFileSync(join(dir, 'archive', `${date}.html`), '<body>core<!--ATTENTION-SLOT--></body>');
  writeFileSync(join(dir, 'last-run.json'), JSON.stringify({ date, status, lastScheduledRunAt: '2026-06-19T06:30:00Z' }));
  return dir;
}
const items = [{ repo: 'r', taskNum: 1, taskTitle: 't', diagnosis: 'd' }];

test('enrich splices, deploys index, sets status=enriched, preserves cutoff, leaves archive', () => {
  const dir = site('core', '2026-06-19');
  const r = enrich({ siteDir: dir, today: '2026-06-19', items, deployFn: () => ({ ok: true, url: 'u' }) });
  assert.equal(r.ok, true);
  assert.match(readFileSync(join(dir, 'index.html'), 'utf8'), /Needs your attention/);
  assert.doesNotMatch(readFileSync(join(dir, 'archive', '2026-06-19.html'), 'utf8'), /Needs your attention/);
  const lr = JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'));
  assert.equal(lr.status, 'enriched');
  assert.equal(lr.lastScheduledRunAt, '2026-06-19T06:30:00Z');
});

test('enrich no-ops when Job A is not today', () => {
  const dir = site('core', '2026-06-18');
  assert.equal(enrich({ siteDir: dir, today: '2026-06-19', items, deployFn: () => ({ ok: true }) }).ok, false);
});

test('enrich with no stalled items splices an all-clear note (and confirms it ran)', () => {
  const dir = site('core', '2026-06-19');
  const r = enrich({ siteDir: dir, today: '2026-06-19', items: [], deployFn: () => ({ ok: true, url: 'u' }) });
  assert.equal(r.ok, true);
  assert.match(readFileSync(join(dir, 'index.html'), 'utf8'), /Nothing needs your attention/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8')).status, 'enriched');
});

test('enrich rolls index.html back to core on deploy failure', () => {
  const dir = site('core', '2026-06-19');
  const before = readFileSync(join(dir, 'index.html'), 'utf8');
  const r = enrich({ siteDir: dir, today: '2026-06-19', items, deployFn: () => ({ ok: false, error: 'boom' }) });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), before);   // rolled back (marker intact)
  assert.equal(JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8')).status, 'core'); // not enriched
});
