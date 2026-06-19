import { renderDigest } from './render-digest.mjs';
import { writeDigest } from './write-digest.mjs';
import { deploy as realDeploy } from './deploy.mjs';

export function publish({ siteDir, date, generatedAt, since, repos = [], now = Date.now(),
  mode = 'on-demand', priorScheduledAt = null, allReposOk = true, nowISO = new Date().toISOString(),
  deployFn = realDeploy }) {
  const cutoff = (mode === 'scheduled-core' && allReposOk) ? nowISO : priorScheduledAt;
  const html = renderDigest({ generatedAt, since, repos, now });
  // 'pending' pre-deploy so a crash mid-publish never looks enrichable.
  writeDigest({ siteDir, date, generatedAt, html, status: 'pending', lastScheduledRunAt: cutoff });
  const res = deployFn({ siteDir });
  writeDigest({ siteDir, date, generatedAt, html, status: res.ok ? 'core' : 'deploy-failed',
    url: res.url, error: res.error, lastScheduledRunAt: cutoff });
  return res;
}
