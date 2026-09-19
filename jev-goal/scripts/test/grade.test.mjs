import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runScript } from './helpers/run.mjs';
import { makeProject, writeCriteria } from './helpers/goal-dir.mjs';
import { confirmationToken } from '../lib/token.mjs';
import { basename } from 'node:path';

const passing = { task: 't', criteria: [{ id: 'ok', check: 'exit0', question: 'ok?', evidence: 'true' }] };
const failing = { task: 't', maxRounds: 1, criteria: [{ id: 'no', check: 'exit0', question: 'no?', evidence: 'false' }] };

// Every grade.mjs invocation runs with an emptied AI_GATEWAY_API_KEY so that a criterion wrongly
// triggering a real gateway call fails loudly as no_key (exit 2) instead of silently succeeding
// against whatever key happens to be in the ambient environment.
const grade = (args) => runScript('grade.mjs', args, { env: { AI_GATEWAY_API_KEY: '' } });

test('freeze then grade passes on exit0-only criteria with no gateway call', () => {
  const { jevDir } = makeProject({ git: true });
  const file = writeCriteria(jevDir, 'demo', passing);
  const f = grade(['freeze', file]);
  assert.equal(f.status, 0, f.stderr);
  assert.ok(existsSync(file + '.lock'));
  const g = grade(['grade', file]);
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /VERDICT: PASS/);
  assert.match(g.stdout, /--- jev-goal confirmation/);
  assert.equal(readFileSync(file.replace(/\.json$/, '.rounds.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('status reports frozen state and rounds', () => {
  const { jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'demo', passing);
  grade(['freeze', file]);
  grade(['grade', file]);
  const s = grade(['status', file]);
  assert.match(s.stdout, /frozen: yes/);
  assert.match(s.stdout, /rounds run: 1\/10/);
});

test('grade refuses when criteria are not frozen', () => {
  const { jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'demo', passing);
  const g = grade(['grade', file]);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /not frozen/);
});

test('confirmation block carries a token that matches the rounds file', () => {
  const { jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'demo', passing);
  grade(['freeze', file]);
  const g = grade(['grade', file]);
  const lock = JSON.parse(readFileSync(file + '.lock', 'utf8'));
  const round = JSON.parse(readFileSync(file.replace(/\.json$/, '.rounds.jsonl'), 'utf8').trim());
  const expected = confirmationToken(basename(file, '.json'), lock.sha256, round.round, round.at);
  assert.match(g.stdout, new RegExp(`^token: ${expected}$`, 'm'));
});

test('grade refuses to run past maxRounds', () => {
  const { jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'demo', failing); // maxRounds: 1
  grade(['freeze', file]);
  const g1 = grade(['grade', file]);
  assert.equal(g1.status, 3, 'first grade hits maxRounds');
  const g2 = grade(['grade', file]);
  assert.equal(g2.status, 3);
  assert.match(g2.stdout + g2.stderr, /maxRounds reached/);
  assert.equal(readFileSync(file.replace(/\.json$/, '.rounds.jsonl'), 'utf8').trim().split('\n').length, 1, 'no round appended');
});
