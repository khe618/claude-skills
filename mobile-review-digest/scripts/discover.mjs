import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_ROOT = 'C:/Users/khe61/OneDrive/Documents/CS Programs';

export function slugFromRemote(url) {
  if (!url) return null;
  const m = String(url).match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/);
  return m ? m[1] : null;
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function discoverRepos(root = DEFAULT_ROOT) {
  const repos = [];
  walk(root, 0, 3, repos);
  return repos;
}

function walk(dir, depth, maxDepth, out) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const tasksPath = join(dir, 'TASKS.md');
  if (existsSync(tasksPath) && statSync(tasksPath).isFile()) {
    out.push({
      dir,
      tasksPath,
      slug: slugFromRemote(git(dir, ['remote', 'get-url', 'origin'])),
      branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    });
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
      walk(join(dir, e.name), depth + 1, maxDepth, out);
    }
  }
}
