import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fillTemplate } from '../scripts/render-card.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tpl = readFileSync(join(here, '../templates/pr-card.html'), 'utf8');

const base = { title: 'Gate <room> entry', repo: 'khe618/traderprep', branch: 'gate-room',
  number: 6, state: 'open', whatItDoes: 'Blocks logged-out users.', chips: ['checks: passing', 'mergeable'] };

test('escapes text and injects fields', () => {
  const html = fillTemplate(tpl, base);
  assert.match(html, /Gate &lt;room&gt; entry/);
  assert.match(html, /khe618\/traderprep · #6/);
  assert.match(html, /checks: passing/);
});

test('uses img when imagePath present', () => {
  const html = fillTemplate(tpl, { ...base, imagePath: 'C:/tmp/shot.png' });
  assert.match(html, /<img src="file:/);
  assert.doesNotMatch(html, /class="example"/);
});

test('uses example block when no image', () => {
  const html = fillTemplate(tpl, { ...base, exampleHtml: '<div class="example">before/after</div>' });
  assert.match(html, /class="example"/);
});
