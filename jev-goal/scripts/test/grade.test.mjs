import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runScript } from './helpers/run.mjs';
import { makeProject, writeCriteria } from './helpers/goal-dir.mjs';

const passing = { task: 't', criteria: [{ id: 'ok', check: 'exit0', question: 'ok?', evidence: 'true' }] };
const failing = { task: 't', maxRounds: 1, criteria: [{ id: 'no', check: 'exit0', question: 'no?', evidence: 'false' }] };

test('freeze then grade passes on exit0-only criteria with no gateway call', () => {
  const { jevDir } = makeProject({ git: true });
  const file = writeCriteria(jevDir, 'demo', passing);
  const f = runScript('grade.mjs', ['freeze', file]);
  assert.equal(f.status, 0, f.stderr);
  assert.ok(existsSync(file + '.lock'));
  const g = runScript('grade.mjs', ['grade', file]);
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /VERDICT: PASS/);
  assert.match(g.stdout, /--- jev-goal confirmation/);
  assert.equal(readFileSync(file.replace(/\.json$/, '.rounds.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('status reports frozen state and rounds', () => {
  const { jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'demo', passing);
  runScript('grade.mjs', ['freeze', file]);
  runScript('grade.mjs', ['grade', file]);
  const s = runScript('grade.mjs', ['status', file]);
  assert.match(s.stdout, /frozen: yes/);
  assert.match(s.stdout, /rounds run: 1\/10/);
});

test('grade refuses when criteria are not frozen', () => {
  const { jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'demo', passing);
  const g = runScript('grade.mjs', ['grade', file]);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /not frozen/);
});
