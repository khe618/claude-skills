#!/usr/bin/env node
// jev-goal: pre-registered acceptance criteria graded by TypeSafe AI's Jev
// (an evaluation model on Vercel AI Gateway) from evidence the script gathers itself.
//
//   node grade.mjs freeze <criteria.json>   dry-run every evidence command, then lock the criteria (sha256) before any work starts
//   node grade.mjs grade  <criteria.json>   run evidence commands, ask Jev, print verdict
//   node grade.mjs status <criteria.json>   show lock state and round history
//
// Exit codes: 0 all criteria pass / 1 some fail / 2 usage or lock error / 3 maxRounds reached / 4 grader unavailable
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(here, '.env'), quiet: true, override: false });

const MODEL = 'typesafe-ai/jev';
const OUTPUT_HEAD = 24_000; // chars kept from the start of each command's output
const OUTPUT_TAIL = 8_000; // chars kept from the end
const DEFAULTS = { threshold: 0.8, maxRounds: 10, timeoutMs: 600_000 };
// check modes: "exit0" passes iff every evidence command exits 0 (deterministic, no model call);
// "jev" sends the evidence output to Jev and passes iff P(true) >= threshold.
const CHECKS = ['jev', 'exit0'];
let bashPath; // memoised by findBash(); declared before the top-level await below

const [, , cmd, fileArg] = process.argv;
if (!cmd || !fileArg || !['freeze', 'grade', 'status'].includes(cmd)) usage();

const file = resolve(fileArg);
if (!existsSync(file)) die(2, `criteria file not found: ${file}`);
const lockFile = file + '.lock';
const roundsFile = file.replace(/\.json$/, '') + '.rounds.jsonl';

const spec = loadSpec(file);
// project root: two levels above .claude/jev/<slug>.json, unless "cwd" in the file overrides it
const projectRoot = spec.cwd ? resolve(dirname(file), spec.cwd) : resolve(dirname(file), '..', '..');

if (cmd === 'freeze') freeze();
else if (cmd === 'status') status();
else await grade();

// ---------------------------------------------------------------------------

function freeze() {
  if (existsSync(lockFile)) {
    die(2, `already frozen: ${lockFile}\nCriteria cannot be re-frozen. Start a new criteria file for a new task.`);
  }
  const baseCommit = gitHead();
  dryRun(baseCommit);
  const lock = { sha256: sha256File(file), frozenAt: new Date().toISOString(), baseCommit };
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  localGitExclude();
  console.log(`frozen ${spec.criteria.length} criteria for: ${spec.task}`);
  console.log(`lock: ${lockFile}`);
  if (lock.baseCommit) console.log(`base commit: ${lock.baseCommit} (evidence commands see it as $JEV_BASE)`);
  console.log('Criteria are now immutable. Do the work, then run: grade');
}

// Run every evidence command once before locking the file. The work has not started, so most
// commands are expected to fail or print nothing; the only thing that blocks the freeze is a command
// that cannot run at all (shell syntax error, unknown command, malformed sed/grep/awk expression).
// Such a command would otherwise be frozen into a criterion nothing could ever satisfy.
function dryRun(baseCommit) {
  if (process.env.JEV_SKIP_DRYRUN) {
    console.log('dry run skipped (JEV_SKIP_DRYRUN set)');
    return;
  }
  console.log('dry run: executing each evidence command once (failures are expected before the work exists; only commands that cannot run block the freeze)');
  const results = new Map();
  const problems = [];
  for (const command of [...new Set(spec.criteria.flatMap((c) => c.evidence))]) {
    process.stdout.write(`  $ ${command} ... `);
    const r = runCommand(command, baseCommit);
    results.set(command, r);
    const reason = malformedReason(r);
    console.log(`exit ${r.exitCode}, ${r.length} chars${reason ? '   <- ' + reason : ''}`);
    if (reason) problems.push({ command, reason });
  }
  for (const c of spec.criteria.filter((c) => c.check === 'jev')) {
    if (c.evidence.every((e) => results.get(e).length === 0)) {
      console.log(`  note: ${c.id} (jev) printed nothing. Jev needs text to read; make sure this prints output once the work exists (grep -q and test -z never do).`);
    }
  }
  if (problems.length) {
    const list = problems.map((p) => `  $ ${p.command}\n    ${p.reason}`).join('\n');
    die(2, `freeze refused: ${problems.length} evidence command(s) cannot run:\n${list}\n` +
      'The criteria are NOT frozen yet, so fix the command(s) in the criteria file and freeze again.\n' +
      'Watch for backslashes: writing the JSON through a Bash heredoc strips one level of them. ' +
      'Set JEV_SKIP_DRYRUN=1 to freeze anyway if a command is legitimately unrunnable before the work starts.');
  }
}

// Returns a one-line reason when the command itself is broken (as opposed to running and failing).
function malformedReason(r) {
  if (r.exitCode === 'spawn-failed') return 'could not spawn a shell';
  if (typeof r.exitCode === 'string') return `killed by ${r.exitCode}`;
  const stderr = r.output.includes('[stderr]') ? r.output.slice(r.output.indexOf('[stderr]')) : '';
  const firstErr = stderr.split('\n').find((l) => l.trim() && l.trim() !== '[stderr]')?.trim() ?? '';
  if (r.exitCode === 127) return `command not found: ${firstErr || 'exit 127'}`;
  if (r.exitCode === 126) return `not executable: ${firstErr || 'exit 126'}`;
  const patterns = [
    /\bsyntax error\b/i, // bash, awk, jq, node -e
    /unexpected EOF/i, // bash unterminated quote
    /^sed: -e expression/m, // malformed sed script
    /^sed: (unterminated|unknown|invalid|no previous)/m,
    /^grep: (Unmatched|Invalid|invalid|unrecognized|Trailing|Regular expression too big|missing terminating)/m,
    /^(tr|cut|sort|find|head|tail|wc|awk|jq|xargs): (invalid|unrecognized|unknown|illegal|missing|bad|Unmatched)/m,
    /^\S+: (invalid|unrecognized|illegal) option/m,
    /^usage: /im,
    /is not a git command/,
    /unknown option to `s'/,
  ];
  const hit = patterns.find((p) => p.test(stderr));
  return hit ? `malformed command: ${firstErr}` : null;
}

function status() {
  console.log(`task: ${spec.task}`);
  const frozen = existsSync(lockFile) ? (verifyLock(false) ? 'yes' : 'yes, BUT FILE MODIFIED SINCE FREEZE') : 'no';
  console.log(`frozen: ${frozen}`);
  const rounds = readRounds();
  console.log(`rounds run: ${rounds.length}/${spec.maxRounds}`);
  for (const r of rounds) {
    console.log(`  round ${r.round} ${r.at}: ${r.passed ? 'PASS' : 'FAIL (' + r.failed.join(', ') + ')'}`);
  }
}

async function grade() {
  if (!existsSync(lockFile)) die(2, 'criteria are not frozen. Run `freeze` BEFORE doing any work, then grade.');
  verifyLock(true);
  const round = readRounds().length + 1;
  console.log(`jev-goal round ${round}/${spec.maxRounds}: ${spec.task}`);
  console.log(`project: ${projectRoot}`);

  // Run every distinct evidence command once. The agent never supplies this text itself.
  const commands = [...new Set(spec.criteria.flatMap((c) => c.evidence))];
  const evidence = [];
  for (const command of commands) {
    process.stdout.write(`  $ ${command} ... `);
    const r = runCommand(command);
    console.log(`exit ${r.exitCode}, ${r.length} chars`);
    evidence.push({ command, exitCode: r.exitCode, output: r.output });
  }

  const exitOf = (command) => evidence.find((e) => e.command === command).exitCode;
  const rows = [];

  // Deterministic criteria first: no model call. If any fail, the Jev questions wait for the next round,
  // which keeps the agent fixing concrete failures and saves rate-limited gateway calls.
  for (const c of spec.criteria.filter((c) => c.check === 'exit0')) {
    const exits = c.evidence.map(exitOf);
    rows.push({ id: c.id, check: 'exit0', exits, pass: exits.every((x) => x === 0) });
  }
  const jevCriteria = spec.criteria.filter((c) => c.check === 'jev');
  const deterministicFailed = rows.some((r) => !r.pass);
  let usage = 'no model call';

  if (jevCriteria.length && deterministicFailed) {
    for (const c of jevCriteria) rows.push({ id: c.id, check: 'jev', skipped: true, pass: false });
    console.log('  (deterministic checks failed; Jev questions skipped this round)');
  } else if (jevCriteria.length) {
    const result = await askJev(jevCriteria, evidence);
    for (const c of jevCriteria) {
      const p = result.answers[c.id].probability;
      rows.push({ id: c.id, check: 'jev', p, pass: p >= spec.threshold });
    }
    usage = result.usage ? `${result.usage.inputTokens} in / ${result.usage.outputTokens} out` : 'n/a';
  }

  const failed = rows.filter((r) => !r.pass).map((r) => r.id);
  const passed = failed.length === 0;

  console.log('');
  for (const c of spec.criteria) {
    const r = rows.find((x) => x.id === c.id);
    const detail = r.check === 'exit0' ? `exit=${r.exits.join(',')}` : r.skipped ? 'skipped' : `P(true)=${r.p.toFixed(2)}`;
    const mark = r.pass ? 'PASS' : r.skipped ? 'WAIT' : 'FAIL';
    const tail = r.pass || r.skipped ? '' : '   <- ' + c.question;
    console.log(`  ${mark}  ${c.id.padEnd(28)} ${detail.padEnd(14)}${tail}`);
  }
  console.log('');
  const record = { round, at: new Date().toISOString(), passed, failed, rows, usage };
  appendFileSync(roundsFile, JSON.stringify(record) + '\n');

  if (passed) {
    console.log(`VERDICT: PASS. All ${rows.length} criteria met (threshold ${spec.threshold}, tokens ${usage}).`);
    printConfirmation(rows, round);
    process.exit(0);
  }
  console.log(`VERDICT: FAIL. ${failed.length} of ${rows.length} criteria not met (threshold ${spec.threshold}, tokens ${usage}).`);
  if (round >= spec.maxRounds) {
    console.log(`maxRounds (${spec.maxRounds}) reached. Stop and report the failing criteria to the user.`);
    process.exit(3);
  }
  console.log('Fix the failing criteria, then run grade again. Do not edit the criteria file.');
  process.exit(1);
}

// Printed once on PASS. The agent pastes this block verbatim in its final report so the user
// sees exactly what was promised up front and how each promise was checked.
function printConfirmation(rows, round) {
  const lock = readLock();
  const base = lock.baseCommit ? lock.baseCommit.slice(0, 7) : 'no git base';
  console.log('');
  console.log('--- jev-goal confirmation (paste this in the final report) ---');
  console.log(`Task: ${spec.task}`);
  console.log(`Criteria frozen ${lock.frozenAt} at base ${base}; all met in round ${round}/${spec.maxRounds}.`);
  console.log('');
  console.log('| # | Criterion | Check | Result |');
  console.log('|---|---|---|---|');
  spec.criteria.forEach((c, i) => {
    const r = rows.find((x) => x.id === c.id);
    const result = r.check === 'exit0' ? `exit ${r.exits.join(',')}` : `Jev P(true)=${r.p.toFixed(2)}`;
    console.log(`| ${i + 1} | ${c.question} | ${r.check} | ${result} |`);
  });
  console.log('--- end confirmation ---');
}

async function askJev(criteria, evidence) {
  if (!process.env.AI_GATEWAY_API_KEY) die(2, `AI_GATEWAY_API_KEY missing (set it in ${join(here, '.env')})`);
  const questions = {};
  for (const c of criteria) {
    questions[c.id] = {
      type: 'boolean',
      instructions: {
        question: c.question,
        relevantEvidence: c.evidence,
        rule:
          'Answer true only if the evidence output in state clearly demonstrates it. ' +
          'If the relevant evidence is missing, errored, or ambiguous, answer false.',
      },
    };
  }
  // Only hand Jev the evidence its questions cite.
  const cited = new Set(criteria.flatMap((c) => c.evidence));
  const state = { task: spec.task, evidence: evidence.filter((e) => cited.has(e.command)) };

  const { experimental_evaluate: evaluate } = await import('ai');
  try {
    return await evaluate({ model: MODEL, state, questions });
  } catch (e) {
    // Gateway/provider failure, not a criteria failure: no round is recorded.
    const last = e?.errors?.at(-1) ?? e;
    const status = last?.statusCode ?? last?.cause?.statusCode;
    const msg = (last?.message ?? String(e)).split('\n')[0];
    const hint = status === 429 ? 'Rate limited: wait 60-120s and run grade again.'
      : status === 402 ? 'Out of gateway credits or budget.'
      : status === 401 ? 'AI_GATEWAY_API_KEY rejected.'
      : 'Transient failure: run grade again.';
    die(4, `GRADER UNAVAILABLE (${status ?? 'no status'}): ${msg}\n${hint} This is not a verdict on the criteria.`);
  }
}

// ---------------------------------------------------------------------------

function loadSpec(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    die(2, `cannot parse ${path}: ${e.message}`);
  }
  const s = { ...DEFAULTS, ...raw };
  if (typeof s.task !== 'string' || !s.task.trim()) die(2, '"task" must be a non-empty string');
  if (!Array.isArray(s.criteria) || s.criteria.length === 0) die(2, '"criteria" must be a non-empty array');
  const ids = new Set();
  for (const c of s.criteria) {
    if (!c.id || !/^[a-z0-9_]+$/.test(c.id)) die(2, `criterion id must match [a-z0-9_]+: ${JSON.stringify(c.id)}`);
    if (ids.has(c.id)) die(2, `duplicate criterion id: ${c.id}`);
    ids.add(c.id);
    if (typeof c.question !== 'string' || !c.question.trim()) die(2, `criterion ${c.id}: "question" required`);
    if (typeof c.evidence === 'string') c.evidence = [c.evidence];
    const ok = Array.isArray(c.evidence) && c.evidence.length > 0 && c.evidence.every((e) => typeof e === 'string' && e.trim());
    if (!ok) die(2, `criterion ${c.id}: "evidence" must be a shell command or list of commands`);
    c.check ??= 'jev';
    if (!CHECKS.includes(c.check)) die(2, `criterion ${c.id}: "check" must be one of ${CHECKS.join(', ')}`);
  }
  if (!(s.threshold > 0 && s.threshold <= 1)) die(2, '"threshold" must be in (0, 1]');
  if (!(Number.isInteger(s.maxRounds) && s.maxRounds >= 1)) die(2, '"maxRounds" must be a positive integer');
  return s;
}

function runCommand(command, baseCommit = readLock().baseCommit) {
  const shell = findBash() ?? true;
  const r = spawnSync(command, {
    cwd: projectRoot,
    shell,
    encoding: 'utf8',
    timeout: spec.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', JEV_BASE: baseCommit ?? 'HEAD' },
  });
  let output = (r.stdout ?? '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '');
  if (r.error) output += `\n[spawn error] ${r.error.message}`;
  output = output.replace(/\u001b\[[0-9;]*m/g, '');
  const length = output.length;
  if (length > OUTPUT_HEAD + OUTPUT_TAIL) {
    const omitted = length - OUTPUT_HEAD - OUTPUT_TAIL;
    output = output.slice(0, OUTPUT_HEAD) + `\n...[${omitted} chars omitted]...\n` + output.slice(-OUTPUT_TAIL);
  }
  const exitCode = r.status ?? (r.signal ? `signal ${r.signal}` : 'spawn-failed');
  return { exitCode, output, length };
}

function findBash() {
  if (bashPath !== undefined) return bashPath;
  if (process.platform !== 'win32') {
    bashPath = '/bin/bash';
    return bashPath;
  }
  const candidates = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'];
  bashPath = candidates.find((p) => existsSync(p)) ?? null;
  return bashPath;
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function readLock() {
  return JSON.parse(readFileSync(lockFile, 'utf8'));
}

function gitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function verifyLock(fatal) {
  const lock = readLock();
  const ok = lock.sha256 === sha256File(file);
  if (!ok && fatal) {
    die(2, 'CRITERIA MODIFIED AFTER FREEZE. Grading refused.\n' +
      'Restore the frozen criteria (or start a new criteria file for a genuinely new task) and grade again.');
  }
  return ok;
}

function readRounds() {
  if (!existsSync(roundsFile)) return [];
  return readFileSync(roundsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function localGitExclude() {
  // keep .claude/jev/ out of the project's git status without touching its tracked .gitignore
  const r = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: projectRoot, encoding: 'utf8' });
  if (r.status !== 0) return;
  const exclude = join(resolve(projectRoot, r.stdout.trim()), 'info', 'exclude');
  const line = '.claude/jev/';
  try {
    const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!cur.split('\n').includes(line)) {
      appendFileSync(exclude, (cur.endsWith('\n') || !cur ? '' : '\n') + line + '\n');
    }
  } catch {
    /* best effort */
  }
}

function usage() {
  console.error('usage: node grade.mjs <freeze|grade|status> <path/to/criteria.json>');
  process.exit(2);
}

function die(code, msg) {
  console.error(`jev-goal: ${msg}`);
  process.exit(code);
}
