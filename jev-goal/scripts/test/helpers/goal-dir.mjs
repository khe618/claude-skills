import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Creates <tmp>/proj/.claude/jev/ and returns { root, jevDir }. With git: true the project is a git repo with one commit.
export function makeProject({ git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jev-proj-'));
  const jevDir = join(root, '.claude', 'jev');
  mkdirSync(jevDir, { recursive: true });
  if (git) {
    for (const args of [['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['commit', '-q', '--allow-empty', '-m', 'init']]) {
      spawnSync('git', args, { cwd: root });
    }
  }
  return { root, jevDir };
}

// Writes a criteria file and returns its path.
export function writeCriteria(jevDir, slug, spec) {
  const p = join(jevDir, `${slug}.json`);
  writeFileSync(p, JSON.stringify(spec, null, 2) + '\n');
  return p;
}
