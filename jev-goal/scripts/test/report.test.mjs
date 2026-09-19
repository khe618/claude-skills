import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScript } from './helpers/run.mjs';

const rec = (over = {}) => ({ at: '2026-09-19T14:02:11.120Z', session: 's', cwd: 'C:\\dev\\proj', mode: 'shadow', nudgeCount: 0, gateCount: 0, gate: null, batteryRan: true,
  answers: { asks_user: 0.03, blocked_external: 0.05, declined: 0.02, promises_pending: 0.84, request_unmet: 0.91 },
  fired: { triggers: ['promises_pending', 'request_unmet'], vetoes: [] }, wouldBlock: true, blocked: false,
  reason: 'jev-stop-nudge#abcd1234 (1/2): x', finalMessagePreview: 'I edited the route. Next I will', usage: null, error: null, label: null, ...over });

test('report prints a row per record with fired signals and gate states', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-rep-'));
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, [JSON.stringify(rec()), JSON.stringify(rec({ batteryRan: false, wouldBlock: false, gate: { owned: ['t.json'], states: { 't.json': 'open' }, blockedOn: 'open', gateYielded: false } }))].join('\n') + '\n');
  const r = runScript('stop-hook-report.mjs', ['--log', log]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3, 'header + 2 rows');
  assert.match(lines[1], /proj/); assert.match(lines[1], /Y/); assert.match(lines[1], /promises_pending,request_unmet/); assert.match(lines[1], /I edited the route/);
  assert.match(lines[2], /t\.json=open/);
});

test('--label rewrites the record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-rep-'));
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, JSON.stringify(rec()) + '\n' + JSON.stringify(rec()) + '\n');
  const r = runScript('stop-hook-report.mjs', ['--log', log, '--label', '2', 'bad']);
  assert.equal(r.status, 0, r.stderr);
  const recs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(recs[0].label, null); assert.equal(recs[1].label, 'bad');
});
