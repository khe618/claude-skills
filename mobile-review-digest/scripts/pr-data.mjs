import { execFileSync } from 'node:child_process';

export function normalizePr(raw, state) {
  return {
    number: raw.number,
    title: raw.title,
    branch: raw.headRefName,
    isDraft: Boolean(raw.isDraft),
    state,
    prState: raw.state ?? (state ? state.toUpperCase() : null),
    checks: deriveChecks(raw.statusCheckRollup),
    mergeable: raw.mergeable ?? null,
    mergedAt: raw.mergedAt ?? null,
    reviewDecision: raw.reviewDecision ?? null,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    url: raw.url ?? null,
    body: raw.body ?? '',
    files: Array.isArray(raw.files) ? raw.files.map((f) => f.path ?? f) : [],
  };
}

export function newOpenPrs(prs, cutoffMs) {
  return prs.filter((p) => p.prState === 'OPEN'
    && Number.isFinite(Date.parse(p.createdAt)) && Date.parse(p.createdAt) > cutoffMs);
}

export function prSummary(pr) {
  const lines = String(pr.body || '').split(/\r?\n/);
  for (const ln of lines) {
    if (/^\s*#{1,6}\s/.test(ln)) continue;             // skip markdown headings entirely
    const t = ln.replace(/^\s*[>*\-]+\s*/, '').trim();  // strip bullet/quote markers (not #)
    if (t) return t.replace(/\s+/g, ' ').slice(0, 140);
  }
  return pr.title || '';
}

function deriveChecks(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  const states = rollup.map((c) => c.conclusion || c.status || '');
  if (states.some((s) => /FAIL|ERROR|CANCEL/i.test(s))) return 'failing';
  if (states.some((s) => /PENDING|PROGRESS|QUEUED/i.test(s))) return 'pending';
  if (states.every((s) => /SUCCESS|COMPLETED/i.test(s))) return 'passing';
  return 'pending';
}

export function recentMerged(prs, days = 7, now = Date.now()) {
  const cutoff = now - days * 86400000;
  return prs.filter((p) => p.mergedAt && Date.parse(p.mergedAt) >= cutoff);
}

const VIEW_FIELDS = 'number,title,headRefName,isDraft,mergeable,mergedAt,body,files,statusCheckRollup,createdAt,updatedAt,url,reviewDecision,state';

export function gatherPrs(slug) {
  try {
    const open = listAndView(slug, 'open');
    const mergedAll = listAndView(slug, 'merged', 20);
    return { open, merged: recentMerged(mergedAll), error: null };
  } catch (e) {
    return { open: [], merged: [], error: String(e.message || e) };
  }
}

function listAndView(slug, state, limit = 30) {
  const list = JSON.parse(execFileSync('gh',
    ['pr', 'list', '-R', slug, '--state', state, '--limit', String(limit), '--json', 'number'],
    { encoding: 'utf8' }));
  return list.map(({ number }) => {
    const raw = JSON.parse(execFileSync('gh',
      ['pr', 'view', String(number), '-R', slug, '--json', VIEW_FIELDS],
      { encoding: 'utf8' }));
    return normalizePr(raw, state);
  });
}
