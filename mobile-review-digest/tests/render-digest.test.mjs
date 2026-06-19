import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDigest, renderAttention, relTime, escapeHtml, renderArchiveIndex } from '../scripts/render-digest.mjs';

test('renderArchiveIndex stays exported (write-digest imports it)', () => {
  assert.equal(typeof renderArchiveIndex, 'function');
  assert.match(renderArchiveIndex(['2026-06-19']), /2026-06-19/);
});

const NOW = Date.parse('2026-06-19T10:30:00Z');
const sample = {
  generatedAt: 'Fri, Jun 19, 6:30 AM',
  since: 'New since Thu, Jun 18, 6:30 AM',
  now: NOW,
  repos: [{
    slug: 'khe618/traderprep',
    newPrs: [{ number: 8, title: 'Stripe <Pro>', url: 'https://github.com/khe618/traderprep/pull/8',
      createdAt: '2026-06-19T06:30:00Z', summary: 'Adds paid Pro via `Stripe`.' }],
    tasks: [{ num: 1, state: 'in progress', title: 'Finish billing',
      fields: { objective: 'Ship the billing surface and merge PR #8 to main. More detail here.' },
      raw: '   - Objective: ship it\n   - Evidence: <x>' }],
    prError: false,
  }],
};

test('relTime formats minutes/hours/days', () => {
  assert.equal(relTime('2026-06-19T10:00:00Z', NOW), '30m ago');
  assert.equal(relTime('2026-06-19T06:30:00Z', NOW), '4h ago');
  assert.equal(relTime('2026-06-17T10:30:00Z', NOW), '2d ago');
});

test('renderDigest has the empty attention slot, header, new-PR link, and window', () => {
  const html = renderDigest(sample);
  assert.match(html, /<!--ATTENTION-SLOT-->/);
  assert.match(html, /Generated Fri, Jun 19, 6:30 AM/);
  assert.match(html, /New since Thu, Jun 18, 6:30 AM/);
  assert.match(html, /href="https:\/\/github\.com\/khe618\/traderprep\/pull\/8"/);
  assert.match(html, /Stripe &lt;Pro&gt;/);            // escaped
  assert.match(html, /<code>Stripe<\/code>/);          // richText summary
  assert.match(html, /opened 4h ago/);
});

test('renderDigest renders tasks as collapsible raw blocks (escaped) with an Objective line', () => {
  const html = renderDigest(sample);
  assert.match(html, /<details>/);
  assert.match(html, /<span class="thead">#1 &middot; in progress &middot; Finish billing<\/span>/);
  assert.match(html, /<span class="taskobj">Ship the billing surface and merge PR #8 to main\.<\/span>/); // first sentence only
  assert.match(html, /Evidence: &lt;x&gt;/);           // full raw still behind expand, escaped
  assert.match(html, /class="taskbody"/);
});

test('renderDigest empty states + no removed v1 artifacts', () => {
  const html = renderDigest({ generatedAt: 'now', since: 'New in the last 24h', now: NOW,
    repos: [{ slug: 'r', newPrs: [], tasks: [], prError: false }] });
  assert.match(html, /No new PRs/);
  assert.match(html, /No tasks/);
  assert.doesNotMatch(html, /<img /);
  assert.doesNotMatch(html, /Do next/);
});

test('renderDigest shows per-repo PRs-unavailable on prError', () => {
  const html = renderDigest({ generatedAt: 'now', since: 's', now: NOW,
    repos: [{ slug: 'khe618/x', newPrs: [], tasks: [], prError: true }] });
  assert.match(html, /khe618\/x: PRs unavailable/);
});

test('renderDigest is self-contained (no external asset loads) and keeps PTR', () => {
  const html = renderDigest(sample);
  assert.doesNotMatch(html, /src="https?:/);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<script[^>]*\bsrc=/i);
  assert.match(html, /id="ptr"/);
});

test('renderAttention renders rows with diagnosis + PR link; empty -> all-clear note', () => {
  assert.match(renderAttention([]), /Nothing needs your attention/);
  const html = renderAttention([{ repo: 'khe618/x', taskNum: 3, taskTitle: 'Export <btn>',
    prNumber: 9, prUrl: 'https://github.com/khe618/x/pull/9', diagnosis: 'PR #9 has merge conflicts — rebase' }]);
  assert.match(html, /Needs your attention/i);
  assert.match(html, /Export &lt;btn&gt;/);
  assert.match(html, /href="https:\/\/github\.com\/khe618\/x\/pull\/9"/);
  assert.match(html, /merge conflicts/);
});
