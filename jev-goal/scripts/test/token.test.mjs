import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { confirmationToken } from '../lib/token.mjs';

test('confirmationToken is slug:round:12hex of sha256(lock:round:at)', () => {
  const hex = createHash('sha256').update('abc:2:2026-09-19T00:00:00.000Z').digest('hex').slice(0, 12);
  assert.equal(confirmationToken('task-2', 'abc', 2, '2026-09-19T00:00:00.000Z'), `task-2:2:${hex}`);
});
