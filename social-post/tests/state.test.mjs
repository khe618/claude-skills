import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PLATFORMS, plan, mark, loadState, queueLow } from '../scripts/state.mjs';

async function fixture({ decks = [], state = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'social-post-'));
  const decksDir = path.join(root, 'decks');
  await mkdir(decksDir, { recursive: true });
  for (const slug of decks) await writeFile(path.join(decksDir, `${slug}.json`), JSON.stringify({ slug }));
  const stateFile = path.join(root, 'state.json');
  await writeFile(stateFile, JSON.stringify(state));
  return { decksDir, stateFile };
}

test('PLATFORMS is ig, tiktok, x', () => {
  assert.deepEqual(PLATFORMS, ['ig', 'tiktok', 'x']);
});

test('plan: nothing posted yet -> post the first deck by slug order, nothing to finish', async () => {
  const { decksDir, stateFile } = await fixture({ decks: ['b-deck', 'a-deck'] });
  const p = await plan({ decksDir, stateFile });
  assert.deepEqual(p, { finish: [], post: 'a-deck', remaining: 1 });
});

test('plan: a partially posted deck is finished before a new deck is posted', async () => {
  const { decksDir, stateFile } = await fixture({
    decks: ['a-deck', 'b-deck'],
    state: { decks: { 'a-deck': { ig: { status: 'posted' }, tiktok: { status: 'posted' } } } },
  });
  const p = await plan({ decksDir, stateFile });
  assert.deepEqual(p.finish, [{ slug: 'a-deck', platforms: ['x'] }]);
  assert.equal(p.post, 'b-deck');
});

test('plan: a failed platform counts as missing and is retried', async () => {
  const { decksDir, stateFile } = await fixture({
    decks: ['a-deck'],
    state: { decks: { 'a-deck': { ig: { status: 'posted' }, tiktok: { status: 'failed' }, x: { status: 'posted' } } } },
  });
  const p = await plan({ decksDir, stateFile });
  assert.deepEqual(p.finish, [{ slug: 'a-deck', platforms: ['tiktok'] }]);
  assert.equal(p.post, null);
});

test('plan: fully posted decks are skipped; post is null when the queue is empty', async () => {
  const { decksDir, stateFile } = await fixture({
    decks: ['a-deck'],
    state: { decks: { 'a-deck': { ig: { status: 'posted' }, tiktok: { status: 'posted' }, x: { status: 'posted' } } } },
  });
  const p = await plan({ decksDir, stateFile });
  assert.deepEqual(p, { finish: [], post: null, remaining: 0 });
});

test('mark records status, timestamp and url per platform without clobbering siblings', async () => {
  const { stateFile } = await fixture({ state: { decks: { 'a-deck': { ig: { status: 'posted', url: 'https://ig/1' } } } } });
  await mark({ stateFile, slug: 'a-deck', platform: 'x', status: 'posted', url: 'https://x/1' });
  const s = await loadState(stateFile);
  assert.equal(s.decks['a-deck'].ig.url, 'https://ig/1');
  assert.equal(s.decks['a-deck'].x.status, 'posted');
  assert.equal(s.decks['a-deck'].x.url, 'https://x/1');
  assert.match(s.decks['a-deck'].x.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('mark rejects unknown platforms and statuses', async () => {
  const { stateFile } = await fixture();
  await assert.rejects(mark({ stateFile, slug: 'a', platform: 'threads', status: 'posted' }), /platform/);
  await assert.rejects(mark({ stateFile, slug: 'a', platform: 'x', status: 'done' }), /status/);
});

test('queueLow is true when fewer than two decks are fully unposted', async () => {
  const one = await fixture({ decks: ['a-deck', 'b-deck'], state: { decks: { 'a-deck': { ig: { status: 'posted' } } } } });
  assert.equal(await queueLow(one), true);
  const two = await fixture({ decks: ['a-deck', 'b-deck', 'c-deck'], state: { decks: { 'a-deck': { ig: { status: 'posted' } } } } });
  assert.equal(await queueLow(two), false);
});

test('loadState tolerates a missing file', async () => {
  const s = await loadState(path.join(tmpdir(), 'does-not-exist-' + Date.now(), 'state.json'));
  assert.deepEqual(s, { decks: {}, runs: [] });
});
