import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { makeBuilder } from './helpers/transcript-builder.mjs';
import {
  parseTranscript, isHeadless, isHumanPrompt, entryText, lastHumanPromptIndex, chain, segment, segmentBefore,
  finalAssistantText, toolCalls, summarize, freezeInvocations, sentinelPositions, isMutating, extractNudgeReason,
} from '../lib/transcript.mjs';

test('parseTranscript skips bad lines, sidechain, and non user/assistant types', () => {
  const b = makeBuilder();
  b.human('hi');
  b.raw({ type: 'attachment', message: {} });
  b.sidechain({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } });
  b.assistantText('hello');
  const p = b.write();
  writeFileSync(p, '{not json\n', { flag: 'a' });
  const entries = parseTranscript(p);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.type), ['user', 'assistant']);
});

test('isHeadless is true when any entry has entrypoint sdk-cli', () => {
  const b = makeBuilder({ entrypoint: 'sdk-cli' });
  b.human('x');
  assert.equal(isHeadless(b.entries()), true);
  assert.equal(isHeadless(makeBuilder().entries()), false);
});

test('human prompt detection: origin, legacy fallback, list content, feedback, notifications, tool results', () => {
  const b = makeBuilder();
  const h1 = b.human('typed');
  const h2 = b.human('legacy', { legacy: true });
  const h3 = b.human('multimodal', { list: true });
  b.feedback('nudge');
  b.notification('agent finished');
  b.meta('system note');
  const id = b.toolUse('Read', { file_path: 'a' });
  b.toolResult(id);
  const e = b.entries();
  assert.deepEqual(e.map(isHumanPrompt), [true, true, true, false, false, false, false, false]);
  assert.equal(entryText(h3), 'multimodal');
  assert.equal(lastHumanPromptIndex(e), 2);
  assert.equal(lastHumanPromptIndex([]), -1);
});

test('chain starts at the last human prompt; segment starts after the last string user entry', () => {
  const b = makeBuilder();
  b.human('first');
  b.toolUse('Edit', { file_path: 'x.ts' });
  b.assistantText('done edit');
  b.feedback('agent-logs check');
  b.assistantText('nothing to log');
  const e = b.entries();
  assert.equal(chain(e).length, 5);
  const seg = segment(e);
  assert.equal(seg.length, 1);
  assert.equal(finalAssistantText(seg), 'nothing to log');
  assert.equal(toolCalls(seg).length, 0, 'segment after feedback holds no tools');
  assert.equal(toolCalls(chain(e)).length, 1, 'chain still holds the edit');
});

test('finalAssistantText joins split text blocks and ignores tool blocks', () => {
  const b = makeBuilder();
  b.human('q');
  b.assistantText('part one.');
  b.toolUse('Bash', { command: 'ls' });
  b.assistantText('part two.');
  assert.equal(finalAssistantText(segment(b.entries())), 'part one.\npart two.');
});

test('segmentBefore returns the reply that preceded a given entry', () => {
  const b = makeBuilder();
  b.human('plan?');
  b.assistantText('I propose X. OK?');
  b.human('yes do that');
  b.toolUse('Edit', { file_path: 'x' });
  b.assistantText('did X');
  const e = b.entries();
  assert.equal(finalAssistantText(segmentBefore(e, 2)), 'I propose X. OK?');
  assert.equal(finalAssistantText(segmentBefore(e, 0)), '');
});

test('toolCalls joins results by tool_use_id and summarises per tool', () => {
  const b = makeBuilder();
  b.human('go');
  const a = b.toolUse('Bash', { command: 'npm test -- --watch=false' });
  b.toolResult(a, 'FAIL', true);
  const c = b.toolUse('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' });
  b.toolResult(c);
  b.toolUse('Agent', { description: 'review diff', prompt: 'long' });
  b.toolUse('Skill', { skill: 'commit' });
  b.toolUse('Grep', { pattern: 'foo', path: '.' });
  b.toolUse('mcp__x__do', { anything: 1 });
  const calls = toolCalls(chain(b.entries()));
  assert.deepEqual(calls.map((c) => [c.name, c.summary, c.ok]), [
    ['Bash', 'npm', false],
    ['Edit', 'src/a.ts', true],
    ['Agent', 'review diff', true],
    ['Skill', 'commit', true],
    ['Grep', 'foo', true],
    ['mcp__x__do', 'mcp__x__do', true],
  ]);
  assert.ok(calls.every((c) => typeof c.timestamp === 'string' && Number.isInteger(c.index)));
  assert.equal(summarize('Bash', { command: '  git   status' }), 'git');
  assert.equal(summarize('Bash', {}), 'Bash');
});

test('toolCalls matches only the first result that follows the call, never one before it', () => {
  const b = makeBuilder();
  b.human('go');
  b.toolResult('toolu_dup', 'stale error from earlier', true); // appears BEFORE the call: must be ignored
  b.toolUse('Bash', { command: 'npm test' }, 'toolu_dup');
  b.toolResult('toolu_dup', 'ok');
  b.toolResult('toolu_dup', 'later error', true); // second result with the same id: ignored, first following wins
  const calls = toolCalls(b.entries());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ok, true);
  const c = makeBuilder();
  c.human('go');
  c.toolUse('Bash', { command: 'npm test' }, 'toolu_x');
  c.toolResult('toolu_x', 'FAIL', true);
  assert.equal(toolCalls(c.entries())[0].ok, false);
});

test('extractNudgeReason returns only this hook\'s block from a concatenated feedback entry', () => {
  const ours = 'jev-stop-nudge#0a1b2c3d (1/2): the user\'s request looks unfinished.\n  request_unmet P(true)=0.91: the latest request asks for a deliverable the final message does not report as done.\nIf you can advance the request now, do it. If you are genuinely waiting on the user, say so in one sentence and stop.';
  const entry = `Stop hook feedback:\nEnd-of-session agent-logs check. Before stopping, decide...\n\n${ours}\n\nPost-deploy idea-capture check. Something else.`;
  assert.equal(extractNudgeReason(entry), ours);
  assert.equal(extractNudgeReason('Stop hook feedback:\nnothing of ours here'), null);
  assert.equal(extractNudgeReason(`Stop hook feedback:\n${ours}`), ours);
});

test('isMutating covers the mutating set and mcp tools', () => {
  assert.equal(isMutating('Edit'), true);
  assert.equal(isMutating('mcp__supabase__execute_sql'), true);
  assert.equal(isMutating('Read'), false);
});

test('freezeInvocations resolves paths against entry cwd and ignores failed freezes', () => {
  const b = makeBuilder({ cwd: 'C:\\proj' });
  b.human('go');
  const ok = b.toolUse('Bash', { command: 'node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze .claude/jev/task.json' });
  b.toolResult(ok, 'frozen 3 criteria');
  const bad = b.toolUse('Bash', { command: 'node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze .claude/jev/broken.json' });
  b.toolResult(bad, 'freeze refused', true);
  const abs = b.toolUse('Bash', { command: 'cd /c/proj && node "C:/Users/k/.claude/skills/jev-goal/scripts/grade.mjs" freeze "C:\\proj\\.claude\\jev\\other.json"' });
  b.toolResult(abs, 'frozen');
  const msys = b.toolUse('Bash', { command: 'node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze /c/proj/.claude/jev/msys.json' });
  b.toolResult(msys, 'frozen');
  const msysQuoted = b.toolUse('Bash', { command: "node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze '/d/other proj/.claude/jev/q.json'" });
  b.toolResult(msysQuoted, 'frozen');
  const paths = freezeInvocations(b.entries()).map((p) => p.replace(/\\/g, '/'));
  assert.deepEqual(paths, [
    'C:/proj/.claude/jev/task.json',
    'C:/proj/.claude/jev/other.json',
    'C:/proj/.claude/jev/msys.json',
    'D:/other proj/.claude/jev/q.json',
  ]);
});

test('sentinelPositions finds our sentinel anywhere in a feedback entry', () => {
  const b = makeBuilder();
  b.human('go');
  b.feedback('End-of-session agent-logs check...\n\njev-stop-nudge#0a1b2c3d (1/2): unfinished');
  b.assistantText('ok');
  b.feedback('jev-goal-gate#deadbeef: open criteria');
  const e = b.entries();
  assert.deepEqual(sentinelPositions(e, 'jev-stop-nudge'), [1]);
  assert.deepEqual(sentinelPositions(e, 'jev-goal-gate'), [3]);
  assert.deepEqual(sentinelPositions(e, 'nope'), []);
});
