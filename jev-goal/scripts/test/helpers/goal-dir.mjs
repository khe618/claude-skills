import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';

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

// Writes a lock file for a criteria file exactly as grade.mjs freeze would.
export function freezeFile(criteriaPath, { frozenAt = new Date().toISOString(), baseCommit = null } = {}) {
  const sha256 = createHash('sha256').update(readFileSync(criteriaPath)).digest('hex');
  writeFileSync(criteriaPath + '.lock', JSON.stringify({ sha256, frozenAt, baseCommit }, null, 2) + '\n');
  return sha256;
}

// Appends a round record like grade.mjs does. `failed` is a list of criterion ids.
export function appendRound(criteriaPath, { round, at, passed, failed = [] }) {
  const rec = { round, at, passed, failed, rows: failed.map((id) => ({ id, check: 'exit0', pass: false })), usage: 'no model call' };
  appendFileSync(criteriaPath.replace(/\.json$/, '.rounds.jsonl'), JSON.stringify(rec) + '\n');
  return rec;
}
