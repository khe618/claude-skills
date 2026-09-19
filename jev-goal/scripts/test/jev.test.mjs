import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate, capList, classifyGatewayError, askJev, JevError, RULE, MODEL } from '../lib/jev.mjs';

test('capList keeps exactly head + marker + tail entries', () => {
  const list = Array.from({ length: 100 }, (_, i) => ({ name: `t${i}` }));
  const out = capList(list, 39, 20);
  assert.equal(out.length, 60);
  assert.equal(out[0].name, 't0'); assert.equal(out[38].name, 't38');
  assert.match(out[39].summary, /41 calls omitted/);
  assert.equal(out[40].name, 't80'); assert.equal(out[59].name, 't99');
  assert.deepEqual(capList(list.slice(0, 59), 39, 20), list.slice(0, 59), 'short lists pass through');
});

test('truncate keeps head and tail with an omitted marker', () => {
  const s = 'a'.repeat(100) + 'b'.repeat(100);
  const out = truncate(s, 50, 20);
  assert.ok(out.startsWith('a'.repeat(50)));
  assert.ok(out.endsWith('b'.repeat(20)));
  assert.match(out, /\.\.\.\[130 chars omitted\]\.\.\./);
  assert.equal(truncate('short', 50, 20), 'short');
  const headOnly = truncate(s, 50, 0);
  assert.ok(headOnly.startsWith('a'.repeat(50)));
  assert.ok(headOnly.endsWith('omitted]...\n'), 'zero tail keeps nothing after the marker');
});

test('classifyGatewayError picks status from nested errors and gives a hint', () => {
  const e = { errors: [{ statusCode: 500 }, { statusCode: 429, message: 'rate_limit_exceeded\nmore' }] };
  const r = classifyGatewayError(e);
  assert.equal(r.status, 429);
  assert.equal(r.message, 'rate_limit_exceeded');
  assert.match(r.hint, /Rate limited/);
  assert.equal(classifyGatewayError(new Error('boom')).status, undefined);
});

test('askJev throws no_key without a key and without fake', async () => {
  const saved = process.env.AI_GATEWAY_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  try {
    await assert.rejects(askJev({ questions: { q: { type: 'boolean', instructions: 'x' } }, state: {} }), (e) => e instanceof JevError && e.code === 'no_key');
  } finally {
    if (saved !== undefined) process.env.AI_GATEWAY_API_KEY = saved;
  }
});

test('askJev fake answers are honoured only with allowFake', async () => {
  process.env.JEV_FAKE_ANSWERS = JSON.stringify({ a: 0.9 });
  const savedKey = process.env.AI_GATEWAY_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  try {
    const r = await askJev({ questions: { a: { type: 'boolean', instructions: 'x' }, b: { type: 'boolean', instructions: 'y' } }, state: {}, allowFake: true });
    assert.equal(r.answers.a.probability, 0.9);
    assert.equal(r.answers.b.probability, 0); // unspecified ids default to 0
    assert.deepEqual(r.usage, { inputTokens: 0, outputTokens: 0 });
    // Without allowFake the fake env is ignored: with no key that means no_key, never a fake answer.
    await assert.rejects(askJev({ questions: { a: { type: 'boolean', instructions: 'x' } }, state: {} }), (e) => e instanceof JevError && e.code === 'no_key');
  } finally {
    delete process.env.JEV_FAKE_ANSWERS;
    if (savedKey !== undefined) process.env.AI_GATEWAY_API_KEY = savedKey;
  }
});

test('askJev fake error is a grader_unavailable JevError with that status', async () => {
  process.env.JEV_FAKE_ERROR = '429';
  try {
    await assert.rejects(askJev({ questions: { a: { type: 'boolean', instructions: 'x' } }, state: {}, allowFake: true }), (e) => e instanceof JevError && e.code === 'grader_unavailable' && e.status === 429);
  } finally {
    delete process.env.JEV_FAKE_ERROR;
  }
});

test('constants are exported', () => {
  assert.equal(MODEL, 'typesafe-ai/jev');
  assert.match(RULE, /Answer true only/);
});
