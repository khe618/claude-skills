import { execFileSync } from 'node:child_process';
import { normalizePr } from './pr-data.mjs';

export function linkTaskToPr(task, repoSlug) {
  const text = `${task.raw || ''}\n${(task.fields && task.fields.evidence) || ''}`;
  const esc = repoSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`github\\.com/${esc}/pull/(\\d+)`, 'g');
  const nums = new Set();
  let m;
  while ((m = re.exec(text)) !== null) nums.add(Number(m[1]));
  if (nums.size === 1) return { prNumber: [...nums][0] };
  if (nums.size > 1) return null; // ambiguous — never guess
  const b = text.match(/branch[:\s]+([\w./-]+)/i);
  return b ? { branch: b[1] } : null;
}

export function stallTrigger(pr) {
  if (!pr) return null;
  if (pr.prState === 'MERGED') return 'merged-open';
  if (pr.prState === 'CLOSED') return 'closed';
  if (pr.prState === 'OPEN') {
    if (pr.mergeable === 'CONFLICTING') return 'conflicts';
    if (pr.checks === 'failing') return 'ci';
    if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes';
  }
  return null;
}

export function findStalledTasks(repos, ghView) {
  const out = [];
  for (const r of repos) {
    for (const t of (r.tasks || [])) {
      if (t.state !== 'in progress') continue;
      const ref = linkTaskToPr(t, r.slug);
      if (!ref) continue;
      const pr = ghView(r.slug, ref);
      const trigger = stallTrigger(pr);
      if (!trigger) continue;
      out.push({ repo: r.slug, taskNum: t.num, taskTitle: t.title,
        prNumber: (pr && pr.number) ?? ref.prNumber ?? null, prUrl: (pr && pr.url) ?? null, trigger });
    }
  }
  return out;
}

// Real gh fetch (impure; injected as `ghView` in Job B). Not unit-tested.
export function ghView(repoSlug, ref) {
  const J = 'state,mergeable,statusCheckRollup,reviewDecision,url,number,title';
  try {
    if (ref.prNumber != null) {
      const raw = JSON.parse(execFileSync('gh', ['pr', 'view', String(ref.prNumber), '-R', repoSlug, '--json', J], { encoding: 'utf8' }));
      return normalizePr(raw, null);
    }
    const list = JSON.parse(execFileSync('gh', ['pr', 'list', '-R', repoSlug, '--head', ref.branch, '--state', 'all', '--json', J], { encoding: 'utf8' }));
    return list.length === 1 ? normalizePr(list[0], null) : null; // ambiguous/none → null
  } catch { return null; }
}
