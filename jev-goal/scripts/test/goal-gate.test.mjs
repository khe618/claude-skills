import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, readFileSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { makeProject, writeCriteria, freezeFile, appendRound } from './helpers/goal-dir.mjs';
import { parseSlug, readRoundsTolerant, goalStates, gateDecision } from '../lib/goal-gate.mjs';
import { confirmationToken } from '../lib/token.mjs';

const spec = (extra = {}) => ({ task: 'demo task', criteria: [{ id: 'a', check: 'exit0', question: 'a?', evidence: 'true' }], ...extra });
const T0 = '2026-09-19T10:00:00.000Z', T1 = '2026-09-19T10:05:00.000Z', T2 = '2026-09-19T10:10:00.000Z', T3 = '2026-09-19T10:15:00.000Z';

test('parseSlug splits base and revision', () => {
  assert.deepEqual(parseSlug('C:\\p\\.claude\\jev\\task-2.json'), { slug: 'task-2', base: 'task', revision: 2 });
  assert.deepEqual(parseSlug('/p/.claude/jev/task.json'), { slug: 'task', base: 'task', revision: 1 });
  assert.deepEqual(parseSlug('/p/x-10.json'), { slug: 'x-10', base: 'x', revision: 10 });
});

test('readRoundsTolerant tolerates a truncated trailing line only', () => {
  const { jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'r', spec());
  assert.deepEqual(readRoundsTolerant(file.replace(/\.json$/, '.rounds.jsonl')), { rounds: [], corrupt: false });
  appendRound(file, { round: 1, at: T1, passed: false, failed: ['a'] });
  appendFileSync(file.replace(/\.json$/, '.rounds.jsonl'), '{"round":2,"at":"2026'); // no trailing newline: a writer mid-append
  const r = readRoundsTolerant(file.replace(/\.json$/, '.rounds.jsonl'));
  assert.equal(r.rounds.length, 1); assert.equal(r.corrupt, false);
  writeFileSync(file.replace(/\.json$/, '.rounds.jsonl'), '{bad}\n{"round":2,"at":"x","passed":true}\n');
  assert.equal(readRoundsTolerant(file.replace(/\.json$/, '.rounds.jsonl')).corrupt, true, 'bad line in the middle');
  writeFileSync(file.replace(/\.json$/, '.rounds.jsonl'), '{"round":1,"at":"x","passed":false}\n{bad}\n');
  assert.equal(readRoundsTolerant(file.replace(/\.json$/, '.rounds.jsonl')).corrupt, true, 'complete but corrupt last line (ends with newline)');
});

test('goalStates: open (no rounds), open (failed), passed, reopened, exhausted, invalid, superseded', () => {
  const { jevDir } = makeProject();
  const noRounds = writeCriteria(jevDir, 'a', spec()); freezeFile(noRounds, { frozenAt: T0 });
  const failed = writeCriteria(jevDir, 'b', spec()); freezeFile(failed, { frozenAt: T0 }); appendRound(failed, { round: 1, at: T1, passed: false, failed: ['a'] });
  const passed = writeCriteria(jevDir, 'c', spec()); freezeFile(passed, { frozenAt: T0 }); appendRound(passed, { round: 1, at: T1, passed: true });
  const reopened = writeCriteria(jevDir, 'd', spec()); freezeFile(reopened, { frozenAt: T0 }); appendRound(reopened, { round: 1, at: T1, passed: true });
  const exhausted = writeCriteria(jevDir, 'e', spec({ maxRounds: 1 })); freezeFile(exhausted, { frozenAt: T0 }); appendRound(exhausted, { round: 1, at: T1, passed: false, failed: ['a'] });
  const invalid = writeCriteria(jevDir, 'f', spec()); freezeFile(invalid, { frozenAt: T0 }); writeFileSync(invalid, JSON.stringify(spec({ task: 'edited' })));
  // revisions: g (rev 1) < g-2 < g-3; g-3 is frozen but its criteria were edited afterwards, so it is invalid
  // AND it still supersedes the lower revisions (supersession keys off "has a parseable lock", not validity).
  const old = writeCriteria(jevDir, 'g', spec()); freezeFile(old, { frozenAt: T0 });
  const newer = writeCriteria(jevDir, 'g-2', spec()); freezeFile(newer, { frozenAt: T1 });
  const newest = writeCriteria(jevDir, 'g-3', spec()); freezeFile(newest, { frozenAt: T2 }); writeFileSync(newest, JSON.stringify(spec({ task: 'tampered' })));
  const unfrozen = writeCriteria(jevDir, 'h', spec());

  // Edit timestamps are global to the transcript. The single edit below is at T2, so d (passed at T1) reopens
  // while c must have passed after T2 to stay 'passed': rewrite c's rounds with a pass at T3.
  writeFileSync(passed.replace(/\.json$/, '.rounds.jsonl'), '');
  appendRound(passed, { round: 1, at: T3, passed: true });

  const states = goalStates([noRounds, failed, passed, reopened, exhausted, invalid, old, newer, newest, unfrozen], { editTimestamps: [T2] });
  const byFile = Object.fromEntries(states.map((s) => [basename(s.file), s.state]));
  assert.deepEqual(byFile, {
    'a.json': 'open', 'b.json': 'open', 'c.json': 'passed', 'd.json': 'reopened', 'e.json': 'exhausted',
    'f.json': 'invalid', 'g.json': 'superseded', 'g-2.json': 'superseded', 'g-3.json': 'invalid', 'h.json': 'released',
  });
  assert.equal(states.find((s) => s.file === unfrozen).frozen, false);
  assert.equal(states.find((s) => s.file === newest).frozen, true);
  assert.equal(states.find((s) => s.file === failed).lastRound.failed[0], 'a');
  assert.equal(states.find((s) => s.file === exhausted).maxRounds, 1);
});

test('deleting the criteria file after freezing releases the goal instead of blocking', () => {
  const { jevDir } = makeProject();
  const p = writeCriteria(jevDir, 'gone', spec()); freezeFile(p, { frozenAt: T0 });
  unlinkSync(p);
  const states = goalStates([p], { editTimestamps: [] });
  assert.equal(states[0].state, 'released');
  assert.equal(states[0].frozen, false);
  assert.equal(gateDecision(states, { gateCount: 0, latestPromptIso: T0, finalText: '' }), null);
});

test('gateDecision yields at the cap and reports nothing when everything is terminal', () => {
  const { jevDir } = makeProject();
  const p = writeCriteria(jevDir, 'c', spec()); freezeFile(p, { frozenAt: T0 }); appendRound(p, { round: 1, at: T1, passed: true });
  const states = goalStates([p], { editTimestamps: [] });
  assert.deepEqual(gateDecision(states, { gateCount: 3, latestPromptIso: T0, finalText: '' }), { yielded: true });
  // passed before the latest prompt: no confirmation demanded
  assert.equal(gateDecision(states, { gateCount: 0, latestPromptIso: T2, finalText: '' }), null);
});

test('gateDecision blocks invalid before open, names files and failing ids', () => {
  const { jevDir } = makeProject();
  const bad = writeCriteria(jevDir, 'bad', spec()); freezeFile(bad, { frozenAt: T0 }); writeFileSync(bad, '{"task":"x","criteria":[]}');
  const open = writeCriteria(jevDir, 'open', spec()); freezeFile(open, { frozenAt: T0 }); appendRound(open, { round: 2, at: T1, passed: false, failed: ['a'] });
  const states = goalStates([bad, open], { editTimestamps: [] });
  const d = gateDecision(states, { gateCount: 0, latestPromptIso: T0, finalText: '' });
  assert.equal(d.kind, 'invalid');
  assert.match(d.reason, /^jev-goal-gate#[0-9a-f]{8}/);
  assert.match(d.reason, /bad\.json/);
  const d2 = gateDecision(states.filter((s) => s.state !== 'invalid'), { gateCount: 0, latestPromptIso: T0, finalText: '' });
  assert.equal(d2.kind, 'open');
  assert.match(d2.reason, /open\.json .*round 2.*failing: a/);
  assert.match(d2.reason, /yields after three blocks/);
});

test('gateDecision demands the confirmation token for a pass after the latest prompt', () => {
  const { jevDir } = makeProject();
  const p = writeCriteria(jevDir, 'c', spec()); const sha = freezeFile(p, { frozenAt: T0 }); appendRound(p, { round: 1, at: T2, passed: true });
  const states = goalStates([p], { editTimestamps: [] });
  const missing = gateDecision(states, { gateCount: 0, latestPromptIso: T1, finalText: 'all done' });
  assert.equal(missing.kind, 'confirmation');
  const wrong = gateDecision(states, { gateCount: 0, latestPromptIso: T1, finalText: `token: ${confirmationToken('other', sha, 1, T2)}` });
  assert.equal(wrong.kind, 'confirmation');
  const right = gateDecision(states, { gateCount: 0, latestPromptIso: T1, finalText: `--- jev-goal confirmation\ntoken: ${confirmationToken('c', sha, 1, T2)}\n--- end confirmation ---` });
  assert.equal(right, null);
});

test('reopened blocks with an explanation about edits after the pass', () => {
  const { jevDir } = makeProject();
  const p = writeCriteria(jevDir, 'c', spec()); freezeFile(p, { frozenAt: T0 }); appendRound(p, { round: 1, at: T1, passed: true });
  const states = goalStates([p], { editTimestamps: [T2] });
  const d = gateDecision(states, { gateCount: 0, latestPromptIso: T0, finalText: '' });
  assert.equal(d.kind, 'open');
  assert.match(d.reason, /changed after the passing grade/);
});
