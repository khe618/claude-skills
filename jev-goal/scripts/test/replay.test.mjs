import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from './helpers/run.mjs';
import { makeBuilder } from './helpers/transcript-builder.mjs';

test('--max-calls given as a trailing bare flag falls back to the default (5) instead of uncapping calls', () => {
  // Build a transcript with more than 5 battery-eligible stop points: a human prompt followed by 7
  // repetitions of an Edit (mutating tool) + a working reply + Stop-hook feedback. Each repetition's
  // feedback marks the end of one battery-eligible segment (a mutating tool call, no waiting tool,
  // nudgeCount always 0), so there are 7 eligible stop points, well over the default cap of 5. This
  // depends on F10 (replay skips its 20s inter-call sleep under JEV_FAKE_ANSWERS) so the test runs fast.
  const b = makeBuilder();
  b.human('do the thing');
  for (let i = 0; i < 7; i++) {
    const id = b.toolUse('Edit', { file_path: `src/file${i}.ts` });
    b.toolResult(id);
    b.assistantText('working...');
    b.feedback('agent-logs check');
  }
  const transcript = b.write();
  const r = runScript('replay-stop-hook.mjs', [transcript, '--max-calls'], {
    env: { JEV_FAKE_ANSWERS: '{"promises_pending":0.9,"request_unmet":0.9}' },
  });
  assert.equal(r.status, 0, r.stderr);
  const m = r.stdout.match(/processed \d+ stop point\(s\), (\d+) Jev call\(s\)/);
  assert.ok(m, r.stdout);
  assert.equal(m[1], '5', `expected exactly 5 Jev calls (the default cap), got ${m[1]}`);
  assert.doesNotMatch(r.stderr, /NaN/);
});
