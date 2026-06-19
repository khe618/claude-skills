import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Default runner. shell:true because on Windows `vercel` is a .cmd shim that Node
// will not spawn via execFile without a shell. timeout so a stalled CLI never hangs.
export function defaultRun(args, { cwd }) {
  return execFileSync('vercel', args, {
    cwd,
    encoding: 'utf8',
    shell: true,
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
}

function errText(e) {
  return [e.message, e.stderr && e.stderr.toString(), e.stdout && e.stdout.toString()]
    .filter(Boolean).join(' | ');
}

function parseDeployUrl(stdout) {
  // Non-TTY `vercel --prod` prints a JSON object with deployment.url on stdout.
  try {
    const j = JSON.parse(stdout);
    if (j && j.deployment && typeof j.deployment.url === 'string') return j.deployment.url;
  } catch { /* not JSON — fall through to regex */ }
  // Fallback: first *.vercel.app URL (excludes the vercel.com / api.vercel.com hosts).
  const m = String(stdout).match(/https:\/\/[a-z0-9-]+\.vercel\.app[^\s"']*/i);
  return m ? m[0] : null;
}

export function deploy({ siteDir, token = process.env.VERCEL_TOKEN, run = defaultRun } = {}) {
  if (!token) return { ok: false, url: null, error: 'VERCEL_TOKEN is not set' };
  if (!existsSync(join(siteDir, '.vercel', 'project.json'))) {
    return { ok: false, url: null, error: 'missing .vercel/project.json — run `vercel link` first' };
  }
  try {
    run(['whoami', '--token', token], { cwd: siteDir });
  } catch (e) {
    return { ok: false, url: null, error: 'vercel whoami failed: ' + errText(e) };
  }
  let out;
  try {
    out = run(['--prod', '--yes', '--token', token], { cwd: siteDir });
  } catch (e) {
    return { ok: false, url: null, error: 'vercel deploy failed: ' + errText(e) };
  }
  const url = parseDeployUrl(out);
  if (!url) return { ok: false, url: null, error: 'no deployment URL in vercel output' };
  return { ok: true, url, error: null };
}
