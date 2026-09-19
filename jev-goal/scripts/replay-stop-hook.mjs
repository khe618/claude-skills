#!/usr/bin/env node
// Replay stop-hook.mjs over every stop point of a real transcript, in shadow mode by default.
// usage: node replay-stop-hook.mjs <transcript.jsonl> [--max-calls 5] [--max-points 200] [--mode shadow|enforce]
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isHumanPrompt } from './lib/transcript.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args[0];
if (!file || file.startsWith('--')) { console.error('usage: node replay-stop-hook.mjs <transcript.jsonl> [--max-calls N] [--max-points N] [--mode shadow|enforce]'); process.exit(2); }
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const maxCalls = Number(opt('--max-calls', 5));
const maxPoints = Number(opt('--max-points', 200));
const mode = opt('--mode', 'shadow');

const raw = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()); // raw lines kept so slices are byte-faithful
const entries = raw.map((l) => { try { return JSON.parse(l); } catch { return null; } });
// stop points: the line index of every string-content user entry after the first human prompt, plus EOF
const firstHuman = entries.findIndex((e) => e && e.type === 'user' && isHumanPrompt(e));
const points = [];
entries.forEach((e, i) => { if (i > firstHuman && e && e.type === 'user' && typeof e.message?.content === 'string' && !e.isSidechain) points.push(i); });
points.push(raw.length);

const dir = mkdtempSync(join(tmpdir(), 'jev-replay-'));
const log = join(dir, 'log.jsonl');
let calls = 0;
let processed = 0;
for (const p of points) {
  if (processed >= maxPoints || calls >= maxCalls) break;
  processed++;
  const slice = join(dir, `t-${p}.jsonl`);
  writeFileSync(slice, raw.slice(0, p).join('\n') + '\n');
  const cwd = [...entries.slice(0, p)].reverse().find((e) => e?.cwd)?.cwd ?? process.cwd();
  const input = JSON.stringify({ session_id: 'replay', transcript_path: slice, cwd, stop_hook_active: false, hook_event_name: 'Stop' });
  const before = logLineCount(log);
  const r = spawnSync(process.execPath, [join(here, 'stop-hook.mjs')], { input, encoding: 'utf8', env: { ...process.env, JEV_STOP_HOOK: mode, JEV_STOP_HOOK_LOG: log } });
  const appended = logLineCount(log) > before ? lastRecord(log) : null; // only a record THIS run appended counts
  const ranBattery = !!appended?.batteryRan;
  process.stderr.write(`stop point at line ${p}: ${r.stdout.trim() ? 'BLOCK' : 'pass'}${appended ? '' : ' (no record)'}${ranBattery ? ' [jev call]' : ''}\n`);
  if (ranBattery) { calls++; if (calls < maxCalls) sleepSync(20_000); }
}
const rep = spawnSync(process.execPath, [join(here, 'stop-hook-report.mjs'), '--log', log], { encoding: 'utf8' });
process.stdout.write(rep.stdout);
console.log(`\nprocessed ${processed} stop point(s), ${calls} Jev call(s); log: ${log}`);

function logLineCount(p) { return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).length : 0; }
function lastRecord(p) { try { const ls = readFileSync(p, 'utf8').trim().split('\n'); return JSON.parse(ls.at(-1)); } catch { return null; } }
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
