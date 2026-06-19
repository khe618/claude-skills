import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBranch } from '../scripts/sanitize.mjs';

test('replaces slashes with double underscore', () => {
  assert.equal(sanitizeBranch('task/invite-sheet-header-roles'), 'task__invite-sheet-header-roles');
});

test('handles nested slashes and backslashes', () => {
  assert.equal(sanitizeBranch('feat/story/book\\viewer'), 'feat__story__book__viewer');
});

test('strips unsafe characters', () => {
  assert.equal(sanitizeBranch('fix/avatar:picker?race'), 'fix__avatarpickerrace');
});

test('keeps a plain branch unchanged', () => {
  assert.equal(sanitizeBranch('main'), 'main');
});

test('collapses repeated separators and trims', () => {
  assert.equal(sanitizeBranch('  a//b  '), 'a__b');
});
