import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runScript, scriptsDir } from './helpers/run.mjs';
import { makeBuilder } from './helpers/transcript-builder.mjs';
import { makeProject, writeCriteria, freezeFile, appendRound } from './helpers/goal-dir.mjs';
import { confirmationToken } from '../lib/token.mjs';

function run(transcriptPath, { mode = 'enforce', answers, error, cwd = 'C:\\proj', stopHookActive = false } = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'jev-log-'));
  const log = join(logDir, 'log.jsonl');
  const env = { JEV_STOP_HOOK: mode, JEV_STOP_HOOK_LOG: log };
  if (answers) env.JEV_FAKE_ANSWERS = JSON.stringify(answers);
  if (error) env.JEV_FAKE_ERROR = String(error);
  delete process.env.JEV_FAKE_ANSWERS; delete process.env.JEV_FAKE_ERROR;
  const input = JSON.stringify({ session_id: 's1', transcript_path: transcriptPath, cwd, stop_hook_active: stopHookActive, hook_event_name: 'Stop' });
  const r = runScript('stop-hook.mjs', [], { env, input });
  const records = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const out = r.stdout.trim();
  return { ...r, out, decision: out ? JSON.parse(out) : null, records };
}

// A turn where the assistant edited a file and then stopped with a half-finished reply.
function workingTurn(finalText = 'I edited the route. Next I will add the test.') {
  const b = makeBuilder();
  b.human('add rate limiting to POST /upload with a test');
  const id = b.toolUse('Edit', { file_path: 'src/routes/upload.ts' });
  b.toolResult(id);
  b.assistantText(finalText);
  return b;
}

const UNFINISHED = { asks_user: 0.05, blocked_external: 0.05, declined: 0.02, promises_pending: 0.9, request_unmet: 0.9 };

test('off mode prints nothing and logs nothing', () => {
  const r = run(workingTurn().write(), { mode: 'off', answers: UNFINISHED });
  assert.equal(r.status, 0); assert.equal(r.out, ''); assert.equal(r.records.length, 0);
});

test('headless transcript (sdk-cli) is ignored', () => {
  const b = makeBuilder({ entrypoint: 'sdk-cli' });
  b.human('x'); const id = b.toolUse('Edit', { file_path: 'a' }); b.toolResult(id); b.assistantText('will do later');
  const r = run(b.write(), { answers: UNFINISHED });
  assert.equal(r.out, ''); assert.equal(r.records.length, 0);
});

test('conversation-only and research-only segments never nudge', () => {
  const b = makeBuilder(); b.human('what does this do?'); b.assistantText('It does X. I could also refactor it.');
  const rb = run(b.write(), { answers: UNFINISHED });
  assert.equal(rb.out, ''); assert.equal(rb.records.length, 0, 'no log record: the battery never ran, this did not crash');
  const c = makeBuilder(); c.human('find the bug'); const id = c.toolUse('Grep', { pattern: 'x' }); c.toolResult(id); c.assistantText('Found it in a.ts; I will fix it next.');
  const rc = run(c.write(), { answers: UNFINISHED });
  assert.equal(rc.out, ''); assert.equal(rc.records.length, 0, 'no log record: the battery never ran, this did not crash');
});

test('AskUserQuestion in the segment suppresses the battery', () => {
  const b = workingTurn(); const id = b.toolUse('AskUserQuestion', { questions: [] }); b.toolResult(id); b.assistantText('Waiting on your answer.');
  assert.equal(run(b.write(), { answers: UNFINISHED }).out, '');
});

test('battery blocks with a nudge in enforce mode and logs it', () => {
  const r = run(workingTurn().write(), { answers: UNFINISHED });
  assert.equal(r.status, 0);
  assert.equal(r.decision.decision, 'block');
  assert.match(r.decision.reason, /^jev-stop-nudge#[0-9a-f]{8} \(1\/2\): the user's request looks unfinished\./);
  assert.match(r.decision.reason, /request_unmet P\(true\)=0\.90/);
  assert.match(r.decision.reason, /promises_pending P\(true\)=0\.90/);
  assert.doesNotMatch(r.decision.reason, /asks_user/);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].blocked, true); assert.equal(r.records[0].wouldBlock, true); assert.equal(r.records[0].batteryRan, true);
  assert.equal(r.records[0].mode, 'enforce');
});

test('shadow mode logs wouldBlock but prints nothing', () => {
  const r = run(workingTurn().write(), { mode: 'shadow', answers: UNFINISHED });
  assert.equal(r.out, '');
  assert.equal(r.records[0].wouldBlock, true); assert.equal(r.records[0].blocked, false);
});

test('decision rule: each veto alone suppresses, each trigger alone fires, thresholds are inclusive/exclusive as specified', () => {
  const base = { asks_user: 0, blocked_external: 0, declined: 0, promises_pending: 0, request_unmet: 0 };
  const cases = [
    [{ ...base, promises_pending: 0.8 }, true],
    [{ ...base, promises_pending: 0.79 }, false],
    [{ ...base, promises_pending: 0.799 }, false], // raw value decides; 0.799 must NOT round up to 0.80 and fire
    [{ ...base, request_unmet: 0.8 }, true],
    [{ ...base, request_unmet: 0.9, asks_user: 0.5 }, false],
    [{ ...base, request_unmet: 0.9, asks_user: 0.49 }, true],
    [{ ...base, request_unmet: 0.9, asks_user: 0.499 }, true], // 0.499 must NOT round up to 0.50 and veto
    [{ ...base, request_unmet: 0.9, blocked_external: 0.6 }, false],
    [{ ...base, request_unmet: 0.9, declined: 0.7 }, false],
  ];
  for (const [answers, expectBlock] of cases) {
    const r = run(workingTurn().write(), { answers });
    assert.equal(!!r.decision, expectBlock, JSON.stringify(answers));
    if (expectBlock) assert.deepEqual(r.records[0].fired.vetoes, []);
  }
  const fired = run(workingTurn().write(), { answers: { ...base, request_unmet: 0.9, declined: 0.7 } }).records[0].fired;
  assert.deepEqual(fired, { triggers: ['request_unmet'], vetoes: ['declined'] });
});

test('nudge cap: second nudge needs mutating progress; third never fires; restatement vetoes', () => {
  // one prior nudge, then only a Read: no second nudge
  const b1 = workingTurn(); b1.feedback('jev-stop-nudge#11111111 (1/2): unfinished'); const rd = b1.toolUse('Read', { file_path: 'a' }); b1.toolResult(rd); b1.assistantText('Still planning to add the test.');
  const r1 = run(b1.write(), { answers: UNFINISHED });
  assert.equal(r1.out, ''); assert.equal(r1.records.length, 0, 'no log record: the battery never ran, this did not crash');
  // one prior nudge, then an Edit: second nudge allowed, counter says 2/2, previousNudge sent
  const b2 = workingTurn(); b2.feedback('jev-stop-nudge#11111111 (1/2): unfinished'); const ed = b2.toolUse('Edit', { file_path: 'test/upload.test.ts' }); b2.toolResult(ed); b2.assistantText('Added the test file. I still need to run it.');
  const r2 = run(b2.write(), { answers: { ...UNFINISHED, restatement: 0.1 } });
  assert.match(r2.decision.reason, /\(2\/2\)/);
  assert.equal(r2.records[0].nudgeCount, 1);
  // same, but Jev says it is a restatement: no nudge
  assert.equal(run(b2.write(), { answers: { ...UNFINISHED, restatement: 0.9 } }).out, '');
  // two prior nudges: nothing, and no battery call
  const b3 = workingTurn(); b3.feedback('jev-stop-nudge#11111111 (1/2): x'); const e1 = b3.toolUse('Edit', { file_path: 'a' }); b3.toolResult(e1); b3.assistantText('more'); b3.feedback('jev-stop-nudge#22222222 (2/2): y'); const e2 = b3.toolUse('Edit', { file_path: 'b' }); b3.toolResult(e2); b3.assistantText('even more, will continue');
  const r3 = run(b3.write(), { answers: UNFINISHED });
  assert.equal(r3.out, '');
  assert.equal(r3.records[0]?.batteryRan ?? false, false);
  assert.equal(r3.records.length, 0, 'no log record: the battery never ran, this did not crash');
});

test('a reply to the agent-logs hook (empty segment) does not nudge even though the chain has edits', () => {
  const b = workingTurn(); b.feedback('End-of-session agent-logs check.'); b.assistantText('Nothing worth logging.');
  assert.equal(run(b.write(), { answers: UNFINISHED }).out, '');
});

test('grader failures fail open and are logged', () => {
  const r429 = run(workingTurn().write(), { error: 429 });
  assert.equal(r429.out, ''); assert.equal(r429.records[0].error.code, 'grader_unavailable'); assert.equal(r429.records[0].error.status, 429);
  assert.equal(r429.records[0].batteryRan, true);
  // A non-JevError exception (parseTranscript throwing on a directory) must also fail open, exit 0,
  // and be logged distinctly as 'exception' rather than misreported as a grader failure.
  const rExc = run(tmpdir(), { answers: UNFINISHED });
  assert.equal(rExc.status, 0); assert.equal(rExc.out, ''); assert.equal(rExc.records[0].error.code, 'exception');
});

test('missing or non-finite battery answers veto rather than nudge', () => {
  // jev.mjs's fake-answer path back-fills any omitted question id with a genuine 0, so a literally
  // omitted key can never surface as "missing" to stop-hook.mjs. A non-numeric placeholder forces
  // Number(...) to NaN inside jev.mjs's own conversion, which is what actually reaches stop-hook.mjs
  // as a non-finite probability — the real-world case this guards (a partial/garbled judge response).
  const r = run(workingTurn().write(), {
    answers: { promises_pending: 0.9, request_unmet: 0.9, asks_user: 'n/a', blocked_external: 'n/a', declined: 'n/a' },
  });
  assert.equal(r.out, '');
  assert.deepEqual(r.records[0].fired.vetoes, ['asks_user', 'blocked_external', 'declined']);
});

test('redaction reaches the log preview', () => {
  const r = run(workingTurn('Set AI_GATEWAY_API_KEY=vck_secret_value_123 in .env, then I will retry.').write(), { mode: 'shadow', answers: UNFINISHED });
  assert.match(r.records[0].finalMessagePreview, /AI_GATEWAY_API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(r.records[0]), /vck_secret/);
});

test('owned open goal: gate blocks and the battery is skipped', () => {
  const { root, jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'task', { task: 'rate limit', criteria: [{ id: 'a', check: 'exit0', question: 'a?', evidence: 'true' }] });
  freezeFile(file);
  const b = makeBuilder({ cwd: root });
  b.human('do the task with jev');
  const fz = b.toolUse('Bash', { command: `node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze "${file}"` }); b.toolResult(fz, 'frozen');
  const ed = b.toolUse('Edit', { file_path: 'src/a.ts' }); b.toolResult(ed);
  b.assistantText('Done, I think.');
  const r = run(b.write(), { answers: UNFINISHED, cwd: root });
  assert.match(r.decision.reason, /^jev-goal-gate#[0-9a-f]{8}/);
  assert.match(r.decision.reason, /task\.json.*not yet graded/);
  assert.equal(r.records[0].batteryRan, false);
  assert.equal(r.records[0].gate.states['task.json'], 'open');
});

test('owned goal passed this turn without the token blocks; with the token passes and battery stays off', () => {
  const { root, jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'task', { task: 'rate limit', criteria: [{ id: 'a', check: 'exit0', question: 'a?', evidence: 'true' }] });
  const sha = freezeFile(file);
  const b = makeBuilder({ cwd: root });
  b.human('do the task with jev');
  const fz = b.toolUse('Bash', { command: `node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze ${file}` }); b.toolResult(fz, 'frozen');
  const ed = b.toolUse('Edit', { file_path: 'src/a.ts' }); b.toolResult(ed);
  const at = new Date(Date.now() + 60_000).toISOString(); // after every transcript timestamp
  appendRound(file, { round: 1, at, passed: true });
  const gr = b.toolUse('Bash', { command: `node ~/.claude/skills/jev-goal/scripts/grade.mjs grade ${file}` }); b.toolResult(gr, 'PASS');
  b.assistantText('All criteria met.');
  const missing = run(b.write(), { answers: UNFINISHED, cwd: root });
  assert.match(missing.decision.reason, /no confirmation block/);
  b.assistantText(`--- jev-goal confirmation\ntoken: ${confirmationToken('task', sha, 1, at)}\n--- end confirmation ---`);
  const ok = run(b.write(), { answers: UNFINISHED, cwd: root });
  assert.equal(ok.out, '');
  assert.equal(ok.records[0].batteryRan, false);
});

test('gate cap: after three gate blocks the gate yields', () => {
  const { root, jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'task', { task: 't', criteria: [{ id: 'a', check: 'exit0', question: 'a?', evidence: 'true' }] });
  freezeFile(file);
  const b = makeBuilder({ cwd: root });
  b.human('go');
  const fz = b.toolUse('Bash', { command: `node grade.mjs freeze ${file}` }); b.toolResult(fz, 'frozen');
  for (const id of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) { b.assistantText('trying'); b.feedback(`jev-goal-gate#${id}: open`); }
  b.assistantText('I cannot satisfy criterion a because the API is down.');
  const r = run(b.write(), { answers: UNFINISHED, cwd: root });
  assert.equal(r.out, '');
  assert.equal(r.records[0].gate.gateYielded, true);
});

test('state sent to the judge: preceding assistant message, redacted summaries, our nudge block only', () => {
  // The fake judge cannot see the state, so the hook dumps the exact object when JEV_STOP_HOOK_DUMP_STATE is set.
  const b = makeBuilder();
  b.human('should I add caching?'); b.assistantText('Yes, I propose an LRU cache in api.ts. Want me to?');
  b.human('yes do that');
  const id = b.toolUse('Bash', { command: 'npm install lru-cache --save' }); b.toolResult(id);
  const ed = b.toolUse('Edit', { file_path: 'C:/proj/config/API_KEY=sk-abcdefghijklmnop1234.ts' }); b.toolResult(ed);
  b.assistantText('Installed. I will wire it in next.');
  b.feedback('End-of-session agent-logs check. blah\n\njev-stop-nudge#0a1b2c3d (1/2): the user\'s request looks unfinished.\n  request_unmet P(true)=0.91: the latest request asks for a deliverable the final message does not report as done.\nIf you can advance the request now, do it. If you are genuinely waiting on the user, say so in one sentence and stop.\n\nPost-deploy idea-capture check.');
  const ed2 = b.toolUse('Edit', { file_path: 'src/api.ts' }); b.toolResult(ed2);
  const ed3 = b.toolUse('Write', { file_path: 'C:/proj/notes/TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123.md', content: 'x' }); b.toolResult(ed3);
  b.assistantText('Wired the cache in. Tests still to run.');
  const dump = join(mkdtempSync(join(tmpdir(), 'jev-dump-')), 'state.json');
  const logDir = mkdtempSync(join(tmpdir(), 'jev-log-'));
  const input = JSON.stringify({ session_id: 's1', transcript_path: b.write(), cwd: 'C:\\proj', stop_hook_active: false });
  const r = runScript('stop-hook.mjs', [], { input, env: { JEV_STOP_HOOK: 'shadow', JEV_STOP_HOOK_LOG: join(logDir, 'log.jsonl'), JEV_STOP_HOOK_DUMP_STATE: dump, JEV_FAKE_ANSWERS: JSON.stringify({ ...UNFINISHED, restatement: 0.1 }) } });
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(readFileSync(dump, 'utf8'));
  assert.equal(state.latestUserRequest, 'yes do that');
  assert.equal(state.assistantMessageBeforeRequest, 'Yes, I propose an LRU cache in api.ts. Want me to?');
  assert.equal(state.finalAssistantMessage, 'Wired the cache in. Tests still to run.');
  assert.equal(state.toolCallsThisSegment.length, 2, 'segment = after our nudge only');
  assert.deepEqual(state.toolCallsThisSegment[0], { name: 'Edit', summary: 'src/api.ts', ok: true });
  assert.equal(state.toolCallsThisSegment[1].name, 'Write');
  assert.match(state.toolCallsThisSegment[1].summary, /\[REDACTED\]/, 'secret-shaped path text is redacted');
  assert.doesNotMatch(JSON.stringify(state), /ghp_abcdefghijklmnopqrstuvwxyz0123|sk-abcdefghijklmnop1234/);
  assert.match(state.previousNudge.reason, /^jev-stop-nudge#0a1b2c3d/);
  assert.doesNotMatch(state.previousNudge.reason, /agent-logs|idea-capture/, 'other hooks\' text never leaves the machine');
  assert.equal(state.previousNudge.assistantMessageBefore, 'Installed. I will wire it in next.');
  assert.equal(state.previousNudge.mutatingCallsAfter, 2);
  const logged = JSON.parse(readFileSync(join(logDir, 'log.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.ok(!('stateDigest' in logged), 'no state digest is logged');
  assert.ok(JSON.stringify(logged).length < 4000, 'log record stays small');
});

test('a frozen file this session did not freeze is not owned: no gate, battery runs', () => {
  const { root, jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'someone-elses', { task: 'other session', criteria: [{ id: 'a', check: 'exit0', question: 'a?', evidence: 'true' }] });
  freezeFile(file);
  const b = makeBuilder({ cwd: root });
  b.human('fix the bug'); const ed = b.toolUse('Edit', { file_path: 'src/a.ts' }); b.toolResult(ed); b.assistantText('Fixed one case; the other still needs a change.');
  const r = run(b.write(), { answers: UNFINISHED, cwd: root });
  assert.equal(r.records[0].gate, null);
  assert.equal(r.records[0].batteryRan, true);
  assert.match(r.decision.reason, /^jev-stop-nudge#/);
});

test('a Read after a PASS does not reopen the goal', () => {
  const { root, jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'task', { task: 't', criteria: [{ id: 'a', check: 'exit0', question: 'a?', evidence: 'true' }] });
  const sha = freezeFile(file);
  const b = makeBuilder({ cwd: root });
  b.human('do it with jev');
  const fz = b.toolUse('Bash', { command: `node grade.mjs freeze ${file}` }); b.toolResult(fz, 'frozen');
  const at = '2026-09-19T09:30:00.000Z'; // before the builder's fixed 10:00Z epoch: passed before this prompt chain, so no confirmation demanded
  appendRound(file, { round: 1, at, passed: true });
  const rd = b.toolUse('Read', { file_path: 'src/a.ts' }); b.toolResult(rd);
  b.assistantText('Reviewed the result.');
  const r = run(b.write(), { answers: UNFINISHED, cwd: root });
  assert.equal(r.out, '');
  assert.equal(r.records[0].gate.states['task.json'], 'passed');
  void sha;
});

test('missing gateway key fails open and is logged as no_key', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'jev-log-'));
  const log = join(logDir, 'log.jsonl');
  const input = JSON.stringify({ session_id: 's1', transcript_path: workingTurn().write(), cwd: 'C:\\proj', stop_hook_active: false });
  // An empty value already present in the environment stops dotenv from filling the key in.
  const r = runScript('stop-hook.mjs', [], { input, env: { JEV_STOP_HOOK: 'enforce', JEV_STOP_HOOK_LOG: log, AI_GATEWAY_API_KEY: '' } });
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '');
  const rec = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1));
  assert.equal(rec.error.code, 'no_key');
});

test('stop_hook_active is recorded on the log entry but never gates behaviour', () => {
  const r = run(workingTurn().write(), { answers: UNFINISHED });
  assert.equal(r.records[0].stopHookActive, false);
  // stop_hook_active: true (Claude Code is already re-invoking after a prior block) must not suppress
  // a genuine block: the gate/battery logic pays no attention to it.
  const r2 = run(workingTurn().write(), { answers: UNFINISHED, stopHookActive: true });
  assert.ok(r2.decision, 'block still fires with stop_hook_active: true');
  assert.equal(r2.records[0].stopHookActive, true);
});

test('hook stays silent and exits 0 when a library fails to load', () => {
  // Copy the hook and its libs to an isolated directory, break lib/redact.mjs, and confirm the
  // hook still fails open in both off mode (never even touches the broken file) and shadow mode
  // (touches it, fails open, and logs the exception) rather than crashing with a stack trace.
  const dir = mkdtempSync(join(tmpdir(), 'jev-hook-copy-'));
  cpSync(join(scriptsDir, 'lib'), join(dir, 'lib'), { recursive: true });
  cpSync(join(scriptsDir, 'stop-hook.mjs'), join(dir, 'stop-hook.mjs'));
  // lib/jev.mjs does `import dotenv from 'dotenv'`; give the copy access to the real
  // scripts/node_modules via a directory junction (no admin rights required on Windows).
  try { symlinkSync(join(scriptsDir, 'node_modules'), join(dir, 'node_modules'), 'junction'); } catch { /* best effort */ }
  writeFileSync(join(dir, 'lib', 'redact.mjs'), "throw new Error('boom');\n");
  const copiedScript = join(dir, 'stop-hook.mjs');
  const input = JSON.stringify({ session_id: 's1', transcript_path: workingTurn().write(), cwd: 'C:\\proj', stop_hook_active: false });
  const logDir = mkdtempSync(join(tmpdir(), 'jev-log-'));
  const log = join(logDir, 'log.jsonl');
  delete process.env.JEV_FAKE_ANSWERS; delete process.env.JEV_FAKE_ERROR;

  const offRun = spawnSync(process.execPath, [copiedScript], {
    cwd: dir, encoding: 'utf8', input, env: { ...process.env, JEV_STOP_HOOK: 'off', JEV_STOP_HOOK_LOG: log },
  });
  assert.equal(offRun.status, 0, offRun.stderr);
  assert.equal((offRun.stdout ?? '').trim(), '');
  assert.equal(existsSync(log), false, 'off mode returns before ever importing the broken lib file');

  const shadowRun = spawnSync(process.execPath, [copiedScript], {
    cwd: dir, encoding: 'utf8', input, env: { ...process.env, JEV_STOP_HOOK: 'shadow', JEV_STOP_HOOK_LOG: log },
  });
  assert.equal(shadowRun.status, 0, shadowRun.stderr);
  assert.equal((shadowRun.stdout ?? '').trim(), '');
  const recs = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].error.code, 'exception');
});

test('a segment that dispatched a background subagent is not nudged (skipped: background_wait)', () => {
  const b = workingTurn();
  const id = b.toolUse('Agent', { description: 'review diff', prompt: 'x' });
  b.toolResult(id, 'Async agent launched successfully. (This tool result is internal metadata) agentId: abc123');
  b.assistantText('Review dispatched. I will fold its findings in when it lands.');
  const r = run(b.write(), { answers: UNFINISHED });
  assert.equal(r.out, '');
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].batteryRan, false);
  assert.equal(r.records[0].skipped, 'background_wait');
});

test('a segment with a Bash command run in the background is not nudged (skipped: background_wait)', () => {
  const b = makeBuilder();
  b.human('deploy it and tell me when it is up');
  const id = b.toolUse('Bash', { command: 'npm run deploy', run_in_background: true });
  b.toolResult(id, 'Command running in background with ID: bx1. Output is being written to: x');
  b.assistantText('Deploy started; I will report when it finishes.');
  const r = run(b.write(), { answers: UNFINISHED });
  assert.equal(r.out, '');
  assert.equal(r.records[0].skipped, 'background_wait');
});

test("a segment that follows another hook's feedback is not evaluated (skipped: post_hook_segment)", () => {
  const b = workingTurn();
  b.feedback('End-of-session agent-logs check. Before stopping, decide...');
  const id = b.toolUse('Skill', { skill: 'agent-logs' });
  b.toolResult(id, 'Launching skill: agent-logs');
  b.assistantText('Logged to LEARNINGS.md.');
  const r = run(b.write(), { answers: UNFINISHED });
  assert.equal(r.out, '');
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].batteryRan, false);
  assert.equal(r.records[0].skipped, 'post_hook_segment');
});

test("a segment that follows this hook's own nudge is still evaluated", () => {
  const b = workingTurn();
  b.feedback("End-of-session agent-logs check.\n\njev-stop-nudge#11111111 (1/2): the user's request looks unfinished.\nIf you can advance the request now, do it. If you are genuinely waiting on the user, say so in one sentence and stop.");
  const ed = b.toolUse('Edit', { file_path: 'test/upload.test.ts' }); b.toolResult(ed);
  b.assistantText('Added the test file. I still need to run it.');
  const r = run(b.write(), { answers: { ...UNFINISHED, restatement: 0.1 } });
  assert.match(r.decision.reason, /\(2\/2\)/);
  assert.equal(r.records[0].skipped ?? null, null);
});
