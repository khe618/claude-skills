import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDigest } from '../scripts/write-digest.mjs';

const setup = () => mkdtempSync(join(tmpdir(), 'site-'));

test('writes index, dated archive, archive index, last-run.json', () => {
  const dir = setup();
  writeDigest({ siteDir: dir, date: '2026-06-19', generatedAt: 'Fri', html: '<p>hi</p>',
    status: 'deployed', url: 'https://x.vercel.app' });
  assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), '<p>hi</p>');
  assert.ok(existsSync(join(dir, 'archive', '2026-06-19.html')));
  assert.match(readFileSync(join(dir, 'archive', 'index.html'), 'utf8'), /2026-06-19/);
  const lr = JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'));
  assert.equal(lr.status, 'deployed');
  assert.equal(lr.url, 'https://x.vercel.app');
});

test('last-run.json persists status, date, and lastScheduledRunAt', () => {
  const dir = setup();
  writeDigest({ siteDir: dir, date: '2026-06-19', generatedAt: 'x', html: '<p>1</p>',
    status: 'core', lastScheduledRunAt: '2026-06-19T06:30:00Z' });
  const lr = JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'));
  assert.equal(lr.status, 'core');
  assert.equal(lr.date, '2026-06-19');
  assert.equal(lr.lastScheduledRunAt, '2026-06-19T06:30:00Z');
});

test('archive index newest-first; re-run overwrites not duplicates', () => {
  const dir = setup();
  writeDigest({ siteDir: dir, date: '2026-06-18', generatedAt: 'a', html: '<p>1</p>' });
  writeDigest({ siteDir: dir, date: '2026-06-19', generatedAt: 'b', html: '<p>2</p>' });
  writeDigest({ siteDir: dir, date: '2026-06-19', generatedAt: 'c', html: '<p>3</p>' });
  const dated = readdirSync(join(dir, 'archive')).filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f));
  assert.equal(dated.length, 2);
  const idx = readFileSync(join(dir, 'archive', 'index.html'), 'utf8');
  assert.ok(idx.indexOf('2026-06-19') < idx.indexOf('2026-06-18'));
  assert.equal(readFileSync(join(dir, 'archive', '2026-06-19.html'), 'utf8'), '<p>3</p>');
});
