import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugFromRemote } from '../scripts/discover.mjs';

test('parses https remote', () => {
  assert.equal(slugFromRemote('https://github.com/khe618/traderprep.git'), 'khe618/traderprep');
});

test('parses ssh remote without .git', () => {
  assert.equal(slugFromRemote('git@github.com:khe618/travel_blog'), 'khe618/travel_blog');
});

test('returns null for a non-github url', () => {
  assert.equal(slugFromRemote('https://example.com/x/y.git'), null);
});
