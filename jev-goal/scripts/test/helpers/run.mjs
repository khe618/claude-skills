import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scriptsDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Run one of the scripts as a child process. Returns { status, stdout, stderr }.
export function runScript(script, args = [], { cwd = scriptsDir, env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [join(scriptsDir, script), ...args], {
    cwd,
    encoding: 'utf8',
    input,
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
