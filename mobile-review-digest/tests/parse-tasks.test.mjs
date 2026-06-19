import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTasks } from '../scripts/parse-tasks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(here, '../fixtures/sample-tasks.md'), 'utf8');

test('parses tasks with numbers and titles', () => {
  const tasks = parseTasks(md);
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].num, 1);
  assert.equal(tasks[0].title, 'Continue Stripe subscriptions implementation plan');
  assert.equal(tasks[1].num, 2);
});

test('raw captures the verbatim body incl. unknown fields and checkboxes', () => {
  const t = parseTasks(md).find((x) => x.num === 3);
  assert.match(t.raw, /Owner: codex/);
  assert.match(t.raw, /\[x\] add the endpoint/);
  assert.match(t.raw, /\[ \] add the button/);
  assert.doesNotMatch(t.raw, /Wire up the export button/); // header excluded
});

test('reads state markers', () => {
  const tasks = parseTasks(md);
  assert.equal(tasks[0].state, 'in progress');
  assert.equal(tasks[1].state, 'open');
});

test('captures the Objective field', () => {
  const tasks = parseTasks(md);
  assert.match(tasks[1].fields.objective, /Rename MAX_INTERVAL_RATIO/);
});

test('flags a dependency task as blocked with a reason', () => {
  const tasks = parseTasks(md);
  assert.equal(tasks[0].blocked, true);
  assert.match(tasks[0].blockReason, /continue the existing/i);
});

test('a rename task is ready and small effort', () => {
  const tasks = parseTasks(md);
  assert.equal(tasks[1].blocked, false);
  assert.equal(tasks[1].effort, 'S');
});
