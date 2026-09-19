import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from './helpers/run.mjs';
import { makeBuilder } from './helpers/transcript-builder.mjs';

test('--max-calls given as a trailing bare flag falls back to the default instead of uncapping calls', () => {
  const b = makeBuilder();
  b.human('do the thing');
  b.assistantText('done');
  const transcript = b.write();
  const r = runScript('replay-stop-hook.mjs', [transcript, '--max-calls'], { env: { JEV_FAKE_ANSWERS: '{}' } });
  assert.equal(r.status, 0, r.stderr);
  const m = r.stdout.match(/processed \d+ stop point\(s\), (\d+) Jev call\(s\)/);
  assert.ok(m, r.stdout);
  assert.ok(Number(m[1]) <= 5, `expected at most 5 Jev calls, got ${m[1]}`);
  assert.doesNotMatch(r.stderr, /NaN/);
});
