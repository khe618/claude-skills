import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gather } from './gather.mjs';
import { publish } from './publish.mjs';

const SITE_DIR = 'C:/Users/khe61/OneDrive/Documents/CS Programs/review-digest';

function priorScheduledAt() {
  try { return JSON.parse(readFileSync(join(SITE_DIR, 'last-run.json'), 'utf8')).lastScheduledRunAt ?? null; }
  catch { return null; }
}

const scheduled = process.argv.includes('--scheduled');
const g = gather(SITE_DIR);
const date = new Date().toISOString().slice(0, 10);
const res = publish({
  siteDir: SITE_DIR, date, generatedAt: g.generatedAt, since: g.since, repos: g.repos, now: g.now,
  mode: scheduled ? 'scheduled-core' : 'on-demand', priorScheduledAt: priorScheduledAt(),
  allReposOk: g.allReposOk, nowISO: g.nowISO,
});
console.log(JSON.stringify(res));
if (!res.ok) process.exitCode = 1;
