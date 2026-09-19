import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../lib/redact.mjs';

test('redact handles empty input', () => {
  assert.equal(redact(null), '');
  assert.equal(redact(''), '');
});

test('redact masks common key shapes', () => {
  const cases = [
    ['key sk-abcdefghijklmnop1234 here', 'key [REDACTED] here'],
    ['aws AKIAABCDEFGHIJKLMNOP end', 'aws [REDACTED] end'],
    ['gh ghp_abcdefghijklmnopqrstuvwxyz0123 end', 'gh [REDACTED] end'],
    ['slack xoxb-1234567890-abcdef end', 'slack [REDACTED] end'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'Authorization: [REDACTED]'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test('redact keeps the variable name of assignments', () => {
  assert.equal(redact('AI_GATEWAY_API_KEY=vck_1234567890abcdef'), 'AI_GATEWAY_API_KEY=[REDACTED]');
  assert.equal(redact('export DB_PASSWORD="hunter22"'), 'export DB_PASSWORD=[REDACTED]');
  assert.equal(redact('token: abcd1234efgh'), 'token=[REDACTED]');
});

test('redact removes PEM blocks', () => {
  const pem = 'before\n-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\nafter';
  assert.equal(redact(pem), 'before\n[REDACTED]\nafter');
});

test('redact leaves ordinary prose and paths alone', () => {
  const s = 'Edited src/routes/upload.ts and ran npm test; 12 passing. The key idea is caching.';
  assert.equal(redact(s), s);
});
