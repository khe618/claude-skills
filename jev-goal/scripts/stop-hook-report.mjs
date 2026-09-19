#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); const v = i >= 0 ? args[i + 1] : undefined; return v === undefined || v.startsWith('--') ? undefined : v; };
const logPath = opt('--log') ?? join(homedir(), '.claude', 'jev-stop-hook', 'log.jsonl');
if (!existsSync(logPath)) { console.log(`no log at ${logPath}`); process.exit(0); }
const records = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const labelIdx = args.indexOf('--label');
if (labelIdx >= 0) {
  const n = Number(args[labelIdx + 1]); const label = args[labelIdx + 2];
  if (!(n >= 1 && n <= records.length) || !['good', 'bad'].includes(label)) { console.error('usage: --label <n> good|bad'); process.exit(2); }
  records[n - 1].label = label;
  writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(row(n, records[n - 1]));
  process.exit(0);
}

console.log(['#', 'when', 'project', 'gate', 'would', 'signals', 'err', 'label', 'preview'].join('\t'));
records.forEach((r, i) => console.log(row(i + 1, r)));

function row(n, r) {
  const d = new Date(r.at);
  const when = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const gate = r.gate ? Object.entries(r.gate.states).map(([f, s]) => `${f}=${s}`).join(',') + (r.gate.gateYielded ? ',yielded' : '') : '-';
  // Display what the hook recorded as fired; never recompute from thresholds here (they live in stop-hook.mjs and get tuned).
  const signals = r.fired ? [...(r.fired.triggers ?? []), ...(r.fired.vetoes ?? [])].join(',') || '-' : '-';
  return [n, when, basename(String(r.cwd ?? '')), gate, r.wouldBlock ? 'Y' : 'n', signals, r.error?.code ?? '-', r.label ?? '-', (r.finalMessagePreview ?? '').replace(/\s+/g, ' ')].join('\t');
}
