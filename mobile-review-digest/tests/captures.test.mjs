import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDir, findCapture, saveCapture } from '../scripts/captures.mjs';

test('captureDir sanitizes the branch', () => {
  const d = captureDir('khe618/x', 'feat/a', '/base');
  assert.match(d.replace(/\\/g, '/'), /\/base\/khe618\/x\/feat__a$/);
});

test('findCapture returns nulls when missing', () => {
  const base = mkdtempSync(join(tmpdir(), 'cap-'));
  assert.deepEqual(findCapture('khe618/x', 'main', base), { image: null, summary: null, capturedAt: null });
});

test('saveCapture then findCapture round-trips', () => {
  const base = mkdtempSync(join(tmpdir(), 'cap-'));
  const img = join(base, 'src.png');
  writeFileSync(img, 'PNGDATA');
  saveCapture({ slug: 'khe618/x', branch: 'feat/b', imagePath: img, summary: 'does a thing', baseDir: base });
  const found = findCapture('khe618/x', 'feat/b', base);
  assert.ok(found.image && existsSync(found.image));
  assert.equal(found.summary, 'does a thing');
  assert.ok(found.capturedAt);
});
