import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverRepos } from './discover.mjs';
import { parseTasks } from './parse-tasks.mjs';
import { gatherPrs, newOpenPrs, prSummary } from './pr-data.mjs';

const SITE_DIR = 'C:/Users/khe61/OneDrive/Documents/CS Programs/review-digest';

function priorCutoff(siteDir) {
  try {
    const lr = JSON.parse(readFileSync(join(siteDir, 'last-run.json'), 'utf8'));
    const t = Date.parse(lr.lastScheduledRunAt);
    if (Number.isFinite(t)) return { cutoffMs: t, fallback: false };
  } catch { /* fall through */ }
  return { cutoffMs: Date.now() - 24 * 3600 * 1000, fallback: true };
}

const FRIENDLY = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };

export function gather(siteDir = SITE_DIR) {
  const now = Date.now();
  const { cutoffMs, fallback } = priorCutoff(siteDir);
  const since = fallback ? 'New in the last 24h'
    : 'New since ' + new Date(cutoffMs).toLocaleString('en-US', FRIENDLY);
  const repos = [];
  let allReposOk = true;
  for (const r of discoverRepos()) {
    let tasks = [];
    try { tasks = r.tasksPath ? parseTasks(readFileSync(r.tasksPath, 'utf8')) : []; } catch { /* skip */ }
    const pr = r.slug ? gatherPrs(r.slug) : { open: [], merged: [], error: 'no slug' };
    const prError = Boolean(pr.error);
    if (prError) allReposOk = false;
    const newPrs = newOpenPrs(pr.open, cutoffMs).map((p) => ({
      number: p.number, title: p.title, url: p.url, createdAt: p.createdAt, summary: prSummary(p),
    }));
    // No `prs` field: attention (Job B) self-fetches each linked PR's CURRENT state via
    // ghView (so it can see merged/closed too) — the open-only list here can't.
    repos.push({ slug: r.slug, dir: r.dir, tasks, newPrs, prError });
  }
  return {
    generatedAt: new Date(now).toLocaleString('en-US', FRIENDLY),
    since, now, nowISO: new Date(now).toISOString(), allReposOk, repos,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(gather(), null, 2));
}
