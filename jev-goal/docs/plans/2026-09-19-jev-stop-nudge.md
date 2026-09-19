# jev-stop-nudge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code Stop hook that (a) blocks a stop while criteria this session froze with `grade.mjs freeze` are unfinished, and (b) on a working turn with no active goal, asks Jev whether the reply leaves the user's request unfinished and nudges if so.

**Architecture:** Pure library modules under `scripts/lib/` (transcript parsing, goal-gate state machine, redaction, Jev client) with a thin `scripts/stop-hook.mjs` entry point that reads the hook JSON from stdin, runs the pipeline, and prints `{"decision":"block","reason":...}` or nothing. `grade.mjs` is refactored to import the shared Jev client and gains a confirmation token and a round ceiling. Everything is tested with `node --test` against synthetic transcripts and temp goal directories; no network in tests.

**Tech Stack:** Node 22 ESM, `ai` ^7 (`experimental_evaluate`), `dotenv`, `node:test`, `node:assert/strict`. Windows host; commands below are Git Bash.

**Spec:** `C:\Users\khe61\.claude\skills\jev-goal\docs\specs\2026-09-19-jev-stop-nudge-design.md` (read it first; section numbers below refer to it).

## Global Constraints

- Repo: `C:\Users\khe61\.claude\skills` (git, branch `main`, remote `origin` = github.com/khe618/claude-skills). All work on branch `jev-stop-nudge`, in place (no worktree: the hook is registered by absolute path into this directory, and the changes are additive).
- The working tree already has unrelated uncommitted changes (`agent-logs/SKILL.md`, `merge-and-ship/SKILL.md`, several untracked skill dirs). **Never `git add -A` or `git add .`; always add explicit paths under `jev-goal/`.**
- Package dir: `C:\Users\khe61\.claude\skills\jev-goal\scripts` (`"type": "module"`, deps `ai`, `dotenv` already installed in `node_modules`). Run tests from there: `node --test "test/*.test.mjs"` (quoted glob; a bare `test/` directory argument would also execute `test/helpers/*.mjs` as test files).
- `.gitignore` at the repo root ignores `test-fixtures/`; fixtures therefore live in `scripts/test/fixtures/` (different name) and helpers in `scripts/test/helpers/`.
- Timestamps are compared with `Date.parse`, never as strings. "After" means strictly greater.
- Every string that goes to Jev, including tool names and summaries, passes through `redact()`. The only test-time escape hatches are `JEV_FAKE_ANSWERS`, `JEV_FAKE_ERROR`, and `JEV_STOP_HOOK_DUMP_STATE` (writes the exact state object to a file), all honoured only by the hook.
- Expected test counts below are the `# tests` line of `node --test` output.
- No new npm dependencies.
- Never exit 2 from the hook. Never print anything from the hook except the block JSON.
- Tests must never call the network: the Jev client honours `JEV_FAKE_ANSWERS` / `JEV_FAKE_ERROR` only when the caller passes `allowFake: true` (the hook does, `grade.mjs` does not).
- Sentinels: battery reasons start with `jev-stop-nudge#<8 hex>`, gate reasons with `jev-goal-gate#<8 hex>`.
- Thresholds (spec §4.6): trigger `>= 0.80`, veto `< 0.50`. Caps: battery 2 per chain, gate 3 per chain.
- Headless detection (resolved at plan time, spec §4.1): any transcript entry with `"entrypoint": "sdk-cli"` means a `claude -p` / SDK run; the hook exits 0. Interactive sessions have `"entrypoint": "cli"`.
- Git may print `LF will be replaced by CRLF` warnings on this machine; they are harmless.

---

### Task 0: Baseline commit, branch, test script

**Files:**
- Modify: `jev-goal/scripts/package.json`
- Commit (already modified on disk, uncommitted): `jev-goal/SKILL.md`, `jev-goal/scripts/grade.mjs`, `jev-goal/docs/specs/2026-09-19-jev-stop-nudge-design.md`, `jev-goal/docs/plans/2026-09-19-jev-stop-nudge.md`

**Interfaces:** none. Produces the branch every later task commits to.

- [ ] **Step 1: Create the working branch first**

`main` stays exactly as the user left it (its HEAD does not move). The branch carries the working-tree changes along.

```bash
cd /c/Users/khe61/.claude/skills
git checkout -b jev-stop-nudge
```

- [ ] **Step 2: Commit the pre-existing jev-goal work as the branch's baseline**

The freeze dry-run change from 2026-09-18 (`grade.mjs`, `SKILL.md`) is on disk but uncommitted; it is already the live behaviour of the skill and Task 1 modifies both files, so it must be committed before the refactor or the diffs become unreadable. Commit only these paths. Do not touch `agent-logs/`, `merge-and-ship/`, or any untracked sibling directory.

```bash
git status --short -- jev-goal/
git add jev-goal/SKILL.md jev-goal/scripts/grade.mjs jev-goal/docs/
git commit -m "jev-goal: baseline of pre-existing uncommitted work (freeze dry-run, 'what Jev cannot grade'), plus stop-nudge spec and plan"
```

Expected: one commit; `git status --short -- jev-goal/` prints nothing afterwards.

- [ ] **Step 3: Add the test script to package.json with a focused edit**

Keep the existing `name` (`gev-gate-scripts`, which the lockfile also carries). Add only the `scripts` block. Use the Edit tool: insert after the `"type": "module",` line:

```json
  "scripts": {
    "test": "node --test \"test/*.test.mjs\""
  },
```

Verify: `node -e "console.log(require('./package.json').scripts.test)"` prints `node --test "test/*.test.mjs"` and `git diff --stat jev-goal/scripts/package.json` shows a 3-line addition only.

- [ ] **Step 4: Verify the runner works with no test files yet**

```bash
cd /c/Users/khe61/.claude/skills/jev-goal/scripts
mkdir -p test/fixtures test/helpers
npm test ; echo "exit $?"
```

Expected: `# tests 0` and exit 0 (or Node's "no test files found" notice with exit 0; either is fine).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/khe61/.claude/skills
git add jev-goal/scripts/package.json
git commit -m "jev-goal: add node --test script"
```

---

### Task 1: Extract the shared Jev client into `lib/jev.mjs`

**Files:**
- Create: `jev-goal/scripts/lib/jev.mjs`
- Modify: `jev-goal/scripts/grade.mjs` (remove `askJev` internals, `findBash`, the truncation block in `runCommand`; import them)
- Test: `jev-goal/scripts/test/jev.test.mjs`, `jev-goal/scripts/test/grade.test.mjs`

**Interfaces:**
- Produces:
  ```js
  export const MODEL = 'typesafe-ai/jev';
  export const RULE = 'Answer true only if the evidence output in state clearly demonstrates it. If the relevant evidence is missing, errored, or ambiguous, answer false.';
  export class JevError extends Error { code: 'no_key'|'grader_unavailable'; status?: number; hint: string }
  export function truncate(text, head = 24000, tail = 8000): string       // inserts "\n...[N chars omitted]...\n"
  export function findBash(): string | null                                 // memoised; '/bin/bash' off Windows
  export function classifyGatewayError(e): { status: number|undefined, message: string, hint: string }
  export async function askJev({ questions, state, timeoutMs = 25000, maxRetries = 2, allowFake = false })
    : Promise<{ answers: Record<string, { probability: number }>, usage: { inputTokens?: number, outputTokens?: number } }>
  ```
  `askJev` throws `JevError('no_key')` when `AI_GATEWAY_API_KEY` is unset, `JevError('grader_unavailable')` on any evaluate failure. With `allowFake: true` and `JEV_FAKE_ANSWERS` set (JSON map id → probability) it returns those without importing `ai`; with `JEV_FAKE_ERROR` set (e.g. `429`) it throws `grader_unavailable` with that status.

- [ ] **Step 1: Write the failing tests for the library**

`test/jev.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate, capList, classifyGatewayError, askJev, JevError, RULE, MODEL } from '../lib/jev.mjs';

test('capList keeps exactly head + marker + tail entries', () => {
  const list = Array.from({ length: 100 }, (_, i) => ({ name: `t${i}` }));
  const out = capList(list, 39, 20);
  assert.equal(out.length, 60);
  assert.equal(out[0].name, 't0'); assert.equal(out[38].name, 't38');
  assert.match(out[39].summary, /41 calls omitted/);
  assert.equal(out[40].name, 't80'); assert.equal(out[59].name, 't99');
  assert.deepEqual(capList(list.slice(0, 59), 39, 20), list.slice(0, 59), 'short lists pass through');
});

test('truncate keeps head and tail with an omitted marker', () => {
  const s = 'a'.repeat(100) + 'b'.repeat(100);
  const out = truncate(s, 50, 20);
  assert.ok(out.startsWith('a'.repeat(50)));
  assert.ok(out.endsWith('b'.repeat(20)));
  assert.match(out, /\.\.\.\[130 chars omitted\]\.\.\./);
  assert.equal(truncate('short', 50, 20), 'short');
  const headOnly = truncate(s, 50, 0);
  assert.ok(headOnly.startsWith('a'.repeat(50)));
  assert.ok(headOnly.endsWith('omitted]...\n'), 'zero tail keeps nothing after the marker');
});

test('classifyGatewayError picks status from nested errors and gives a hint', () => {
  const e = { errors: [{ statusCode: 500 }, { statusCode: 429, message: 'rate_limit_exceeded\nmore' }] };
  const r = classifyGatewayError(e);
  assert.equal(r.status, 429);
  assert.equal(r.message, 'rate_limit_exceeded');
  assert.match(r.hint, /Rate limited/);
  assert.equal(classifyGatewayError(new Error('boom')).status, undefined);
});

test('askJev throws no_key without a key and without fake', async () => {
  const saved = process.env.AI_GATEWAY_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  try {
    await assert.rejects(askJev({ questions: { q: { type: 'boolean', instructions: 'x' } }, state: {} }), (e) => e instanceof JevError && e.code === 'no_key');
  } finally {
    if (saved !== undefined) process.env.AI_GATEWAY_API_KEY = saved;
  }
});

test('askJev fake answers are honoured only with allowFake', async () => {
  process.env.JEV_FAKE_ANSWERS = JSON.stringify({ a: 0.9 });
  const savedKey = process.env.AI_GATEWAY_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  try {
    const r = await askJev({ questions: { a: { type: 'boolean', instructions: 'x' }, b: { type: 'boolean', instructions: 'y' } }, state: {}, allowFake: true });
    assert.equal(r.answers.a.probability, 0.9);
    assert.equal(r.answers.b.probability, 0); // unspecified ids default to 0
    assert.deepEqual(r.usage, { inputTokens: 0, outputTokens: 0 });
    // Without allowFake the fake env is ignored: with no key that means no_key, never a fake answer.
    await assert.rejects(askJev({ questions: { a: { type: 'boolean', instructions: 'x' } }, state: {} }), (e) => e instanceof JevError && e.code === 'no_key');
  } finally {
    delete process.env.JEV_FAKE_ANSWERS;
    if (savedKey !== undefined) process.env.AI_GATEWAY_API_KEY = savedKey;
  }
});

test('askJev fake error is a grader_unavailable JevError with that status', async () => {
  process.env.JEV_FAKE_ERROR = '429';
  try {
    await assert.rejects(askJev({ questions: { a: { type: 'boolean', instructions: 'x' } }, state: {}, allowFake: true }), (e) => e instanceof JevError && e.code === 'grader_unavailable' && e.status === 429);
  } finally {
    delete process.env.JEV_FAKE_ERROR;
  }
});

test('constants are exported', () => {
  assert.equal(MODEL, 'typesafe-ai/jev');
  assert.match(RULE, /Answer true only/);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /c/Users/khe61/.claude/skills/jev-goal/scripts && node --test test/jev.test.mjs
```

Expected: FAIL, cannot find module `../lib/jev.mjs`.

- [ ] **Step 3: Write `lib/jev.mjs`**

```js
// Shared Jev client for grade.mjs and stop-hook.mjs.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: join(scriptsDir, '.env'), quiet: true, override: false });

export const MODEL = 'typesafe-ai/jev';
export const RULE =
  'Answer true only if the evidence output in state clearly demonstrates it. ' +
  'If the relevant evidence is missing, errored, or ambiguous, answer false.';

export class JevError extends Error {
  constructor(code, message, { status, hint } = {}) {
    super(message);
    this.code = code; // 'no_key' | 'grader_unavailable'
    this.status = status;
    this.hint = hint ?? '';
  }
}

export function truncate(text, head = 24000, tail = 8000) {
  const s = text ?? '';
  if (s.length <= head + tail) return s;
  const omitted = s.length - head - tail;
  const tailPart = tail > 0 ? s.slice(-tail) : ''; // s.slice(-0) would return the whole string
  return s.slice(0, head) + `\n...[${omitted} chars omitted]...\n` + tailPart;
}

let bashPath;
export function findBash() {
  if (bashPath !== undefined) return bashPath;
  if (process.platform !== 'win32') return (bashPath = '/bin/bash');
  const candidates = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'];
  return (bashPath = candidates.find((p) => existsSync(p)) ?? null);
}

export function classifyGatewayError(e) {
  const last = e?.errors?.at(-1) ?? e;
  const status = last?.statusCode ?? last?.cause?.statusCode;
  const message = (last?.message ?? String(e)).split('\n')[0];
  const hint =
    status === 429 ? 'Rate limited: wait 60-120s and run grade again.'
    : status === 402 ? 'Out of gateway credits or budget.'
    : status === 401 ? 'AI_GATEWAY_API_KEY rejected.'
    : 'Transient failure: run grade again.';
  return { status, message, hint };
}

export async function askJev({ questions, state, timeoutMs = 25000, maxRetries = 2, allowFake = false }) {
  if (allowFake && process.env.JEV_FAKE_ERROR) {
    const status = Number(process.env.JEV_FAKE_ERROR) || undefined;
    throw new JevError('grader_unavailable', `fake gateway error ${status ?? ''}`.trim(), { status, hint: 'fake' });
  }
  if (allowFake && process.env.JEV_FAKE_ANSWERS) {
    const map = JSON.parse(process.env.JEV_FAKE_ANSWERS);
    const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'boolean', probability: Number(map[id] ?? 0) }]));
    return { answers, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new JevError('no_key', `AI_GATEWAY_API_KEY missing (set it in ${join(scriptsDir, '.env')})`);
  }
  const { experimental_evaluate: evaluate } = await import('ai');
  // timeoutMs 0 means no abort at all (grade.mjs keeps its historical no-timeout behaviour).
  const ac = timeoutMs > 0 ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const r = await evaluate({ model: MODEL, state, questions, maxRetries, ...(ac ? { abortSignal: ac.signal } : {}) });
    return { answers: r.answers, usage: { inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens } };
  } catch (e) {
    const { status, message, hint } = classifyGatewayError(e);
    throw new JevError('grader_unavailable', message, { status, hint });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Keep the first `head` and last `tail` items with one marker item in between: head + 1 + tail total.
export function capList(list, head, tail) {
  if (list.length <= head + tail + 1) return list;
  return [...list.slice(0, head), { name: '...', summary: `${list.length - head - tail} calls omitted`, ok: true }, ...list.slice(-tail)];
}
```

- [ ] **Step 4: Run the library tests**

```bash
node --test test/jev.test.mjs
```

Expected: 7 pass.

- [ ] **Step 5: Write the grade.mjs regression test (before touching grade.mjs)**

`test/helpers/run.mjs` (shared by later tasks):

```js
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
```

`test/helpers/goal-dir.mjs` (used here and in Task 5):

```js
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
```

`test/grade.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runScript } from './helpers/run.mjs';
import { makeProject, writeCriteria } from './helpers/goal-dir.mjs';

const passing = { task: 't', criteria: [{ id: 'ok', check: 'exit0', question: 'ok?', evidence: 'true' }] };
const failing = { task: 't', maxRounds: 1, criteria: [{ id: 'no', check: 'exit0', question: 'no?', evidence: 'false' }] };

test('freeze then grade passes on exit0-only criteria with no gateway call', () => {
  const { jevDir } = makeProject({ git: true });
  const file = writeCriteria(jevDir, 'demo', passing);
  const f = runScript('grade.mjs', ['freeze', file]);
  assert.equal(f.status, 0, f.stderr);
  assert.ok(existsSync(file + '.lock'));
  const g = runScript('grade.mjs', ['grade', file]);
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /VERDICT: PASS/);
  assert.match(g.stdout, /--- jev-goal confirmation/);
  assert.equal(readFileSync(file.replace(/\.json$/, '.rounds.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('status reports frozen state and rounds', () => {
  const { jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'demo', passing);
  runScript('grade.mjs', ['freeze', file]);
  runScript('grade.mjs', ['grade', file]);
  const s = runScript('grade.mjs', ['status', file]);
  assert.match(s.stdout, /frozen: yes/);
  assert.match(s.stdout, /rounds run: 1\/10/);
});

test('grade refuses when criteria are not frozen', () => {
  const { jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'demo', passing);
  const g = runScript('grade.mjs', ['grade', file]);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /not frozen/);
});
```

- [ ] **Step 6: Run the grade tests against the unmodified grade.mjs**

```bash
node --test test/grade.test.mjs
```

Expected: 3 pass. (This proves the fixture approach works before the refactor. If `true`/`false` are not found, `findBash` returned null; check Git is installed at the standard path.)

- [ ] **Step 7: Refactor grade.mjs to import from lib/jev.mjs**

In `grade.mjs`:

1. Replace the imports block's `import dotenv from 'dotenv';` and the `dotenv.config(...)` line with:
   ```js
   import { askJev, findBash, truncate, JevError } from './lib/jev.mjs';
   ```
   (keep `createHash`, fs, path, url, `spawnSync` imports; `here` is still used for the `.env` hint in messages, keep it.)
2. Delete the module-level `const MODEL = ...`, `OUTPUT_HEAD`, `OUTPUT_TAIL`, and `let bashPath;` lines.
3. Replace the body of `askJev(criteria, evidence)` with:
   ```js
   async function askJev(criteria, evidence) {
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
     const cited = new Set(criteria.flatMap((c) => c.evidence));
     const state = { task: spec.task, evidence: evidence.filter((e) => cited.has(e.command)) };
     try {
       return await libAskJev({ questions, state, timeoutMs: 0 }); // 0 = no abort, as before the refactor
     } catch (e) {
       if (e instanceof JevError && e.code === 'no_key') die(2, e.message);
       const status = e.status;
       die(4, `GRADER UNAVAILABLE (${status ?? 'no status'}): ${e.message}\n${e.hint} This is not a verdict on the criteria.`);
     }
   }
   ```
   and change the import line to `import { askJev as libAskJev, findBash, truncate, JevError } from './lib/jev.mjs';`.
4. In `runCommand`, replace the manual head/tail block:
   ```js
   const length = output.length;
   output = truncate(output);
   ```
   (remove the `if (length > OUTPUT_HEAD + OUTPUT_TAIL) {...}` block; `length` must still be computed before truncation.)
5. Delete the local `findBash()` function (the import provides it).

- [ ] **Step 8: Run all tests**

```bash
npm test
```

Expected: 10 pass. Also run the real-world regression by hand (no network needed, exit0-only criteria would pass, but this file has jev criteria so only `status` is exercised):

```bash
node grade.mjs status /c/dev/jev-goal-page/.claude/jev/explainer-page-2.json
```

Expected: `frozen: yes`, `rounds run: 3/10`, three PASS rounds listed.

- [ ] **Step 9: Commit**

```bash
cd /c/Users/khe61/.claude/skills
git add jev-goal/scripts/lib/jev.mjs jev-goal/scripts/grade.mjs jev-goal/scripts/test/jev.test.mjs jev-goal/scripts/test/grade.test.mjs jev-goal/scripts/test/helpers/run.mjs jev-goal/scripts/test/helpers/goal-dir.mjs
git commit -m "jev-goal: extract shared Jev client into lib/jev.mjs with fake-answer support for tests"
```

---

### Task 2: Confirmation token and round ceiling in grade.mjs

**Files:**
- Create: `jev-goal/scripts/lib/token.mjs`
- Modify: `jev-goal/scripts/grade.mjs` (`grade()`, `printConfirmation()`)
- Test: `jev-goal/scripts/test/grade.test.mjs` (append), `jev-goal/scripts/test/token.test.mjs`

**Interfaces:**
- Produces: `export function confirmationToken(slug, lockSha256, round, at): string` → `${slug}:${round}:${12 hex}` where hex = first 12 chars of `sha256(`${lockSha256}:${round}:${at}`)`. The confirmation block gains the line `token: <that>`. Task 5's gate recomputes it.
- `grade` exits 3 with `maxRounds reached` **before** running evidence when the rounds file already has `>= maxRounds` entries.

- [ ] **Step 1: Write the token test**

`test/token.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { confirmationToken } from '../lib/token.mjs';

test('confirmationToken is slug:round:12hex of sha256(lock:round:at)', () => {
  const hex = createHash('sha256').update('abc:2:2026-09-19T00:00:00.000Z').digest('hex').slice(0, 12);
  assert.equal(confirmationToken('task-2', 'abc', 2, '2026-09-19T00:00:00.000Z'), `task-2:2:${hex}`);
});
```

- [ ] **Step 2: Append grade tests for the token line and the ceiling**

Append to `test/grade.test.mjs`:

```js
import { confirmationToken } from '../lib/token.mjs';
import { basename } from 'node:path';

test('confirmation block carries a token that matches the rounds file', () => {
  const { jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'demo', passing);
  runScript('grade.mjs', ['freeze', file]);
  const g = runScript('grade.mjs', ['grade', file]);
  const lock = JSON.parse(readFileSync(file + '.lock', 'utf8'));
  const round = JSON.parse(readFileSync(file.replace(/\.json$/, '.rounds.jsonl'), 'utf8').trim());
  const expected = confirmationToken(basename(file, '.json'), lock.sha256, round.round, round.at);
  assert.match(g.stdout, new RegExp(`^token: ${expected}$`, 'm'));
});

test('grade refuses to run past maxRounds', () => {
  const { jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'demo', failing); // maxRounds: 1
  runScript('grade.mjs', ['freeze', file]);
  const g1 = runScript('grade.mjs', ['grade', file]);
  assert.equal(g1.status, 3, 'first grade hits maxRounds');
  const g2 = runScript('grade.mjs', ['grade', file]);
  assert.equal(g2.status, 3);
  assert.match(g2.stdout + g2.stderr, /maxRounds reached/);
  assert.equal(readFileSync(file.replace(/\.json$/, '.rounds.jsonl'), 'utf8').trim().split('\n').length, 1, 'no round appended');
});
```

- [ ] **Step 3: Run to verify failure**

```bash
node --test test/token.test.mjs test/grade.test.mjs
```

Expected: token test fails (module missing); the two new grade tests fail.

- [ ] **Step 4: Implement `lib/token.mjs`**

```js
import { createHash } from 'node:crypto';

export function confirmationToken(slug, lockSha256, round, at) {
  const hex = createHash('sha256').update(`${lockSha256}:${round}:${at}`).digest('hex').slice(0, 12);
  return `${slug}:${round}:${hex}`;
}
```

- [ ] **Step 5: Update grade.mjs**

Add `import { confirmationToken } from './lib/token.mjs';` and `import { basename } from 'node:path';` (extend the existing `node:path` import).

In `grade()`, right after `verifyLock(true);` add:

```js
  const priorRounds = readRounds();
  if (priorRounds.length >= spec.maxRounds) {
    die(3, `maxRounds reached (${priorRounds.length}/${spec.maxRounds}). Report the failing criteria to the user, or start a new criteria file. No round was run.`);
  }
  const round = priorRounds.length + 1;
```

(and delete the old `const round = readRounds().length + 1;`).

Change `printConfirmation(rows, round)` to receive the round record's `at`: call it as `printConfirmation(rows, round, record.at)` and inside, after the `Criteria frozen ...` line, print:

```js
  console.log(`token: ${confirmationToken(basename(file, '.json'), lock.sha256, round, at)}`);
```

(`lock` is already read at the top of `printConfirmation`.)

- [ ] **Step 6: Run all tests**

```bash
npm test
```

Expected: 13 pass.

- [ ] **Step 7: Commit**

```bash
cd /c/Users/khe61/.claude/skills
git add jev-goal/scripts/lib/token.mjs jev-goal/scripts/grade.mjs jev-goal/scripts/test/token.test.mjs jev-goal/scripts/test/grade.test.mjs
git commit -m "jev-goal: confirmation token line and maxRounds ceiling in grade"
```

---

### Task 3: `lib/redact.mjs`

**Files:**
- Create: `jev-goal/scripts/lib/redact.mjs`
- Test: `jev-goal/scripts/test/redact.test.mjs`

**Interfaces:**
- Produces: `export function redact(text): string` (null/undefined → `''`). Replaces secrets with `[REDACTED]`, keeping the variable name in `NAME=value` forms.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../lib/redact.mjs';

test('redact handles empty input', () => {
  assert.equal(redact(null), '');
  assert.equal(redact(''), '');
});

test('redact masks common key shapes', () => {
  const cases = [
    ['key sk-abcdefghijklmnop1234 here', 'key [REDACTED] here'],
    ['aws AKIAABCDEFGHIJKLMNOP end', 'aws [REDACTED] end'],
    ['gh ghp_abcdefghijklmnopqrstuvwxyz0123 end', 'gh [REDACTED] end'],
    ['slack xoxb-1234567890-abcdef end', 'slack [REDACTED] end'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'Authorization: [REDACTED]'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test('redact keeps the variable name of assignments', () => {
  assert.equal(redact('AI_GATEWAY_API_KEY=vck_1234567890abcdef'), 'AI_GATEWAY_API_KEY=[REDACTED]');
  assert.equal(redact('export DB_PASSWORD="hunter22"'), 'export DB_PASSWORD=[REDACTED]');
  assert.equal(redact('token: abcd1234efgh'), 'token=[REDACTED]');
});

test('redact removes PEM blocks', () => {
  const pem = 'before\n-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\nafter';
  assert.equal(redact(pem), 'before\n[REDACTED]\nafter');
});

test('redact leaves ordinary prose and paths alone', () => {
  const s = 'Edited src/routes/upload.ts and ran npm test; 12 passing. The key idea is caching.';
  assert.equal(redact(s), s);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
node --test test/redact.test.mjs
```

- [ ] **Step 3: Implement**

```js
// Floor, not a guarantee: masks the secret shapes most likely to appear in prompts and replies.
const PATTERNS = [
  /-----BEGIN[\s\S]*?-----END[^\n]*-----/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)\s*[=:]\s*["']?([^\s"']{4,})["']?/gi;

export function redact(text) {
  let s = text ?? '';
  if (!s) return '';
  for (const p of PATTERNS) s = s.replace(p, '[REDACTED]');
  s = s.replace(ASSIGNMENT, (_m, name) => `${name}=[REDACTED]`);
  return s;
}
```

- [ ] **Step 4: Run, then commit**

```bash
node --test test/redact.test.mjs
cd /c/Users/khe61/.claude/skills
git add jev-goal/scripts/lib/redact.mjs jev-goal/scripts/test/redact.test.mjs
git commit -m "jev-goal: redact helper for text sent to the grader"
```

Expected: 5 pass.

---

### Task 4: `lib/transcript.mjs` and the synthetic transcript builder

**Files:**
- Create: `jev-goal/scripts/lib/transcript.mjs`, `jev-goal/scripts/test/helpers/transcript-builder.mjs`
- Test: `jev-goal/scripts/test/transcript.test.mjs`

**Interfaces:**
- Produces (all pure; `entries` are the filtered arrays returned by `parseTranscript`):
  ```js
  export const MUTATING = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'Agent', 'Skill']);
  export const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'ToolSearch', 'ListAgents', 'ReadNotifications', 'WebSearch', 'WebFetch', 'TodoRead', 'AskUserQuestion']);
  export const WAITING_TOOLS = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
  export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
  export function isMutating(name): boolean                  // MUTATING or mcp__*
  export function parseTranscript(path): Entry[]             // user/assistant only, no sidechain, bad lines skipped
  export function isHeadless(entries): boolean               // any entry.entrypoint === 'sdk-cli'
  export function isHumanPrompt(entry): boolean
  export function entryText(entry): string                   // string content, or joined text blocks
  export function lastHumanPromptIndex(entries): number      // -1 if none
  export function chain(entries): Entry[]                    // from last human prompt (inclusive); [] if none
  export function segment(entries): Entry[]                  // after the last user entry with string content
  export function segmentBefore(entries, index): Entry[]     // the segment that ended just before entries[index]
  export function finalAssistantText(entries): string        // joined text blocks of assistant entries
  export function toolCalls(entries): ToolCall[]             // { name, summary, ok, timestamp, index }
  export function summarize(name, input): string
  export function freezeInvocations(entries): string[]       // absolute criteria paths, ok results only; MSYS "/c/x" normalised to "C:/x"
  export function sentinelPositions(entries, kind): number[] // indexes of isMeta user entries containing `${kind}#xxxxxxxx`
  export function extractNudgeReason(text): string | null    // this hook's own nudge block out of a (possibly concatenated) feedback entry
  ```
  `Entry` is the raw JSONL object. `ToolCall.index` is the index within the array passed in. `ToolCall.ok` is `false` only when the first `tool_result` with that id **after** the call has `is_error: true`; a missing result counts as `ok: true`. A result that appears before its call is never matched.
- Builder (test helper):
  ```js
  export function makeBuilder(): { human(text, extra?), feedback(text), assistantText(text), toolUse(name, input, id?), toolResult(id, content?, isError?), meta(text), notification(text), sidechain(entry), entries(), write(): path }
  ```
  Each call appends an entry with a strictly increasing ISO timestamp (1 s steps from a fixed epoch), `type`, `entrypoint: 'cli'`, `cwd`, `isSidechain: false`, `uuid`. `human()` sets `origin: { kind: 'human' }`, `promptSource: 'typed'`; `human(text, { legacy: true })` omits `origin`. `feedback()` writes `isMeta: true` with content `Stop hook feedback:\n<text>`. `notification()` writes `origin: { kind: 'task-notification' }`, string content, no `isMeta`. `meta()` writes `isMeta: true` with arbitrary string content. `toolUse()` returns the id it used.

- [ ] **Step 1: Write the builder**

`test/helpers/transcript-builder.mjs`:

```js
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function makeBuilder({ cwd = 'C:\\proj', entrypoint = 'cli' } = {}) {
  const list = [];
  let t = Date.parse('2026-09-19T10:00:00.000Z');
  let n = 0;
  const base = (type) => ({ type, uuid: randomUUID(), timestamp: new Date((t += 1000)).toISOString(), cwd, entrypoint, isSidechain: false, sessionId: 'sess' });
  const api = {
    human(text, { legacy = false, list: asList = false } = {}) {
      const e = { ...base('user'), message: { role: 'user', content: asList ? [{ type: 'text', text }] : text } };
      if (!legacy) { e.origin = { kind: 'human' }; e.promptSource = 'typed'; }
      list.push(e); return e;
    },
    feedback(text) { list.push({ ...base('user'), isMeta: true, message: { role: 'user', content: `Stop hook feedback:\n${text}` } }); },
    meta(text) { list.push({ ...base('user'), isMeta: true, message: { role: 'user', content: text } }); },
    notification(text) { list.push({ ...base('user'), origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content: text } }); },
    assistantText(text) { list.push({ ...base('assistant'), message: { role: 'assistant', content: [{ type: 'text', text }] } }); },
    toolUse(name, input, id = `toolu_${++n}`) { list.push({ ...base('assistant'), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }); return id; },
    toolResult(id, content = 'ok', isError = false) {
      const block = { type: 'tool_result', tool_use_id: id, content };
      if (isError) block.is_error = true;
      list.push({ ...base('user'), message: { role: 'user', content: [block] } });
    },
    sidechain(entry) { list.push({ ...entry, isSidechain: true }); },
    raw(obj) { list.push(obj); },
    entries() { return list.slice(); },
    write() {
      const dir = mkdtempSync(join(tmpdir(), 'jev-transcript-'));
      const p = join(dir, 'transcript.jsonl');
      writeFileSync(p, list.map((e) => JSON.stringify(e)).join('\n') + '\n');
      return p;
    },
  };
  return api;
}
```

- [ ] **Step 2: Write the failing tests**

`test/transcript.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { makeBuilder } from './helpers/transcript-builder.mjs';
import {
  parseTranscript, isHeadless, isHumanPrompt, entryText, lastHumanPromptIndex, chain, segment, segmentBefore,
  finalAssistantText, toolCalls, summarize, freezeInvocations, sentinelPositions, isMutating, extractNudgeReason,
} from '../lib/transcript.mjs';

test('parseTranscript skips bad lines, sidechain, and non user/assistant types', () => {
  const b = makeBuilder();
  b.human('hi');
  b.raw({ type: 'attachment', message: {} });
  b.sidechain({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } });
  b.assistantText('hello');
  const p = b.write();
  writeFileSync(p, '{not json\n', { flag: 'a' });
  const entries = parseTranscript(p);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.type), ['user', 'assistant']);
});

test('isHeadless is true when any entry has entrypoint sdk-cli', () => {
  const b = makeBuilder({ entrypoint: 'sdk-cli' });
  b.human('x');
  assert.equal(isHeadless(b.entries()), true);
  assert.equal(isHeadless(makeBuilder().entries()), false);
});

test('human prompt detection: origin, legacy fallback, list content, feedback, notifications, tool results', () => {
  const b = makeBuilder();
  const h1 = b.human('typed');
  const h2 = b.human('legacy', { legacy: true });
  const h3 = b.human('multimodal', { list: true });
  b.feedback('nudge');
  b.notification('agent finished');
  b.meta('system note');
  const id = b.toolUse('Read', { file_path: 'a' });
  b.toolResult(id);
  const e = b.entries();
  assert.deepEqual(e.map(isHumanPrompt), [true, true, true, false, false, false, false, false]);
  assert.equal(entryText(h3), 'multimodal');
  assert.equal(lastHumanPromptIndex(e), 2);
  assert.equal(lastHumanPromptIndex([]), -1);
});

test('chain starts at the last human prompt; segment starts after the last string user entry', () => {
  const b = makeBuilder();
  b.human('first');
  b.toolUse('Edit', { file_path: 'x.ts' });
  b.assistantText('done edit');
  b.feedback('agent-logs check');
  b.assistantText('nothing to log');
  const e = b.entries();
  assert.equal(chain(e).length, 5);
  const seg = segment(e);
  assert.equal(seg.length, 1);
  assert.equal(finalAssistantText(seg), 'nothing to log');
  assert.equal(toolCalls(seg).length, 0, 'segment after feedback holds no tools');
  assert.equal(toolCalls(chain(e)).length, 1, 'chain still holds the edit');
});

test('finalAssistantText joins split text blocks and ignores tool blocks', () => {
  const b = makeBuilder();
  b.human('q');
  b.assistantText('part one.');
  b.toolUse('Bash', { command: 'ls' });
  b.assistantText('part two.');
  assert.equal(finalAssistantText(segment(b.entries())), 'part one.\npart two.');
});

test('segmentBefore returns the reply that preceded a given entry', () => {
  const b = makeBuilder();
  b.human('plan?');
  b.assistantText('I propose X. OK?');
  b.human('yes do that');
  b.toolUse('Edit', { file_path: 'x' });
  b.assistantText('did X');
  const e = b.entries();
  assert.equal(finalAssistantText(segmentBefore(e, 2)), 'I propose X. OK?');
  assert.equal(finalAssistantText(segmentBefore(e, 0)), '');
});

test('toolCalls joins results by tool_use_id and summarises per tool', () => {
  const b = makeBuilder();
  b.human('go');
  const a = b.toolUse('Bash', { command: 'npm test -- --watch=false' });
  b.toolResult(a, 'FAIL', true);
  const c = b.toolUse('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' });
  b.toolResult(c);
  b.toolUse('Agent', { description: 'review diff', prompt: 'long' });
  b.toolUse('Skill', { skill: 'commit' });
  b.toolUse('Grep', { pattern: 'foo', path: '.' });
  b.toolUse('mcp__x__do', { anything: 1 });
  const calls = toolCalls(chain(b.entries()));
  assert.deepEqual(calls.map((c) => [c.name, c.summary, c.ok]), [
    ['Bash', 'npm', false],
    ['Edit', 'src/a.ts', true],
    ['Agent', 'review diff', true],
    ['Skill', 'commit', true],
    ['Grep', 'foo', true],
    ['mcp__x__do', 'mcp__x__do', true],
  ]);
  assert.ok(calls.every((c) => typeof c.timestamp === 'string' && Number.isInteger(c.index)));
  assert.equal(summarize('Bash', { command: '  git   status' }), 'git');
  assert.equal(summarize('Bash', {}), 'Bash');
});

test('toolCalls matches only the first result that follows the call, never one before it', () => {
  const b = makeBuilder();
  b.human('go');
  b.toolResult('toolu_dup', 'stale error from earlier', true); // appears BEFORE the call: must be ignored
  b.toolUse('Bash', { command: 'npm test' }, 'toolu_dup');
  b.toolResult('toolu_dup', 'ok');
  b.toolResult('toolu_dup', 'later error', true); // second result with the same id: ignored, first following wins
  const calls = toolCalls(b.entries());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ok, true);
  const c = makeBuilder();
  c.human('go');
  c.toolUse('Bash', { command: 'npm test' }, 'toolu_x');
  c.toolResult('toolu_x', 'FAIL', true);
  assert.equal(toolCalls(c.entries())[0].ok, false);
});

test('extractNudgeReason returns only this hook\'s block from a concatenated feedback entry', () => {
  const ours = 'jev-stop-nudge#0a1b2c3d (1/2): the user\'s request looks unfinished.\n  request_unmet P(true)=0.91: the latest request asks for a deliverable the final message does not report as done.\nIf you can advance the request now, do it. If you are genuinely waiting on the user, say so in one sentence and stop.';
  const entry = `Stop hook feedback:\nEnd-of-session agent-logs check. Before stopping, decide...\n\n${ours}\n\nPost-deploy idea-capture check. Something else.`;
  assert.equal(extractNudgeReason(entry), ours);
  assert.equal(extractNudgeReason('Stop hook feedback:\nnothing of ours here'), null);
  assert.equal(extractNudgeReason(`Stop hook feedback:\n${ours}`), ours);
});

test('isMutating covers the mutating set and mcp tools', () => {
  assert.equal(isMutating('Edit'), true);
  assert.equal(isMutating('mcp__supabase__execute_sql'), true);
  assert.equal(isMutating('Read'), false);
});

test('freezeInvocations resolves paths against entry cwd and ignores failed freezes', () => {
  const b = makeBuilder({ cwd: 'C:\\proj' });
  b.human('go');
  const ok = b.toolUse('Bash', { command: 'node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze .claude/jev/task.json' });
  b.toolResult(ok, 'frozen 3 criteria');
  const bad = b.toolUse('Bash', { command: 'node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze .claude/jev/broken.json' });
  b.toolResult(bad, 'freeze refused', true);
  const abs = b.toolUse('Bash', { command: 'cd /c/proj && node "C:/Users/k/.claude/skills/jev-goal/scripts/grade.mjs" freeze "C:\\proj\\.claude\\jev\\other.json"' });
  b.toolResult(abs, 'frozen');
  const msys = b.toolUse('Bash', { command: 'node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze /c/proj/.claude/jev/msys.json' });
  b.toolResult(msys, 'frozen');
  const msysQuoted = b.toolUse('Bash', { command: "node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze '/d/other proj/.claude/jev/q.json'" });
  b.toolResult(msysQuoted, 'frozen');
  const paths = freezeInvocations(b.entries()).map((p) => p.replace(/\\/g, '/'));
  assert.deepEqual(paths, [
    'C:/proj/.claude/jev/task.json',
    'C:/proj/.claude/jev/other.json',
    'C:/proj/.claude/jev/msys.json',
    'D:/other proj/.claude/jev/q.json',
  ]);
});

test('sentinelPositions finds our sentinel anywhere in a feedback entry', () => {
  const b = makeBuilder();
  b.human('go');
  b.feedback('End-of-session agent-logs check...\n\njev-stop-nudge#0a1b2c3d (1/2): unfinished');
  b.assistantText('ok');
  b.feedback('jev-goal-gate#deadbeef: open criteria');
  const e = b.entries();
  assert.deepEqual(sentinelPositions(e, 'jev-stop-nudge'), [1]);
  assert.deepEqual(sentinelPositions(e, 'jev-goal-gate'), [3]);
  assert.deepEqual(sentinelPositions(e, 'nope'), []);
});
```

- [ ] **Step 3: Run to verify failure**

```bash
node --test test/transcript.test.mjs
```

Expected: FAIL, module not found.

- [ ] **Step 4: Implement `lib/transcript.mjs`**

```js
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const MUTATING = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'Agent', 'Skill']);
export const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'ToolSearch', 'ListAgents', 'ReadNotifications', 'WebSearch', 'WebFetch', 'TodoRead', 'AskUserQuestion']);
export const WAITING_TOOLS = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

export function isMutating(name) {
  return MUTATING.has(name) || (typeof name === 'string' && name.startsWith('mcp__'));
}

export function parseTranscript(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || (e.type !== 'user' && e.type !== 'assistant')) continue;
    if (e.isSidechain === true) continue;
    out.push(e);
  }
  return out;
}

export function isHeadless(entries) {
  return entries.some((e) => e.entrypoint === 'sdk-cli');
}

const content = (e) => e?.message?.content;
const isStringUser = (e) => e.type === 'user' && typeof content(e) === 'string';

export function entryText(e) {
  const c = content(e);
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}

export function isHumanPrompt(e) {
  if (e.type !== 'user') return false;
  if (e.origin && typeof e.origin === 'object') return e.origin.kind === 'human';
  return typeof content(e) === 'string' && e.isMeta !== true;
}

export function lastHumanPromptIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i--) if (isHumanPrompt(entries[i])) return i;
  return -1;
}

export function chain(entries) {
  const i = lastHumanPromptIndex(entries);
  return i < 0 ? [] : entries.slice(i);
}

export function segment(entries) {
  return segmentBefore(entries, entries.length);
}

// Entries strictly between the last string-content user entry before `index` and `index`.
export function segmentBefore(entries, index) {
  let start = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (isStringUser(entries[i])) { start = i; break; }
  }
  return entries.slice(start + 1, index);
}

export function finalAssistantText(entries) {
  return entries.filter((e) => e.type === 'assistant').map(entryText).filter(Boolean).join('\n');
}

export function summarize(name, input) {
  const inp = input ?? {};
  if (name === 'Bash') {
    const first = String(inp.command ?? '').trim().split(/\s+/)[0];
    return first || 'Bash';
  }
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name)) return String(inp.file_path ?? name);
  if (name === 'Agent') return String(inp.description ?? name);
  if (name === 'Skill') return String(inp.skill ?? name);
  if (name === 'Grep' || name === 'Glob') return String(inp.pattern ?? name);
  return name;
}

export function toolCalls(entries) {
  // Results are keyed by id; the first result that appears AFTER the call wins. Earlier or duplicate results are ignored.
  const resultsById = new Map(); // id -> [{ index, block }]
  entries.forEach((e, index) => {
    const c = content(e);
    if (e.type !== 'user' || !Array.isArray(c)) return;
    for (const b of c) {
      if (!b || b.type !== 'tool_result') continue;
      if (!resultsById.has(b.tool_use_id)) resultsById.set(b.tool_use_id, []);
      resultsById.get(b.tool_use_id).push({ index, block: b });
    }
  });
  const calls = [];
  entries.forEach((e, index) => {
    const c = content(e);
    if (e.type !== 'assistant' || !Array.isArray(c)) return;
    for (const b of c) {
      if (!b || b.type !== 'tool_use') continue;
      const r = (resultsById.get(b.id) ?? []).find((x) => x.index > index)?.block;
      calls.push({ name: b.name, summary: summarize(b.name, b.input), ok: !(r && r.is_error === true), timestamp: e.timestamp, index, id: b.id, input: b.input });
    }
  });
  return calls;
}

const FREEZE_RE = /grade\.mjs["']?\s+freeze\s+("([^"]+)"|'([^']+)'|(\S+))/;
const MSYS_DRIVE_RE = /^\/([A-Za-z])(\/|$)/; // "/c/proj/x" as Git Bash wrote it, before MSYS argument conversion

function normaliseShellPath(raw) {
  const m = MSYS_DRIVE_RE.exec(raw);
  return m ? `${m[1].toUpperCase()}:/${raw.slice(m[0].length)}` : raw;
}

export function freezeInvocations(entries) {
  const out = [];
  for (const call of toolCalls(entries)) {
    if (call.name !== 'Bash' || !call.ok) continue;
    const m = FREEZE_RE.exec(String(call.input?.command ?? ''));
    if (!m) continue;
    const raw = normaliseShellPath(m[2] ?? m[3] ?? m[4]);
    const cwd = normaliseShellPath(entries[call.index]?.cwd ?? process.cwd());
    const p = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export function sentinelPositions(entries, kind) {
  const re = new RegExp(`${kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#[0-9a-f]{8}`);
  const out = [];
  entries.forEach((e, i) => {
    if (e.type === 'user' && e.isMeta === true && re.test(entryText(e))) out.push(i);
  });
  return out;
}

// Our nudge block runs from its sentinel through the closing instruction line. Anything else in the entry
// (other hooks' reasons, concatenated by Claude Code) is not ours and must not leave the machine.
const NUDGE_BLOCK_RE = /jev-stop-nudge#[0-9a-f]{8}[\s\S]*?If you can advance the request now, do it\. If you are genuinely waiting on the user, say so in one sentence and stop\./;

export function extractNudgeReason(text) {
  const m = NUDGE_BLOCK_RE.exec(String(text ?? ''));
  return m ? m[0] : null;
}
```

- [ ] **Step 5: Run the tests**

```bash
node --test test/transcript.test.mjs
```

Expected: 12 pass. If the `freezeInvocations` absolute-path case fails on the `cd /c/proj && ...` command, check that `FREEZE_RE` matched the quoted Windows path (`m[2]`), then `isAbsolute('C:\\proj\\...')` is true on Windows. If the `/c/proj/...` case resolves to `C:\c\proj\...`, `normaliseShellPath` did not run before `isAbsolute`.

- [ ] **Step 6: Commit**

```bash
cd /c/Users/khe61/.claude/skills
git add jev-goal/scripts/lib/transcript.mjs jev-goal/scripts/test/transcript.test.mjs jev-goal/scripts/test/helpers/transcript-builder.mjs
git commit -m "jev-goal: transcript parsing library and synthetic transcript builder"
```

---

### Task 5: `lib/goal-gate.mjs`

**Files:**
- Create: `jev-goal/scripts/lib/goal-gate.mjs`
- Modify: `jev-goal/scripts/test/helpers/goal-dir.mjs` (add `freezeFile`, `appendRound`)
- Test: `jev-goal/scripts/test/goal-gate.test.mjs`

**Interfaces:**
- Consumes: `confirmationToken` (Task 2).
- Produces:
  ```js
  export function parseSlug(filePath): { slug: string, base: string, revision: number }   // 'task-2.json' → { slug: 'task-2', base: 'task', revision: 2 }; 'task.json' → revision 1
  export function readRoundsTolerant(roundsPath): { rounds: object[], corrupt: boolean }   // missing file → [], not corrupt; an unparseable LAST line is tolerated only when the file does not end with a newline (a writer mid-append)
  export function goalStates(ownedFiles, { editTimestamps }): GoalState[]
  //   GoalState = { file, slug, base, revision, frozen, state, task, maxRounds, rounds, lastRound, lockSha256, frozenAt, error? }
  //   frozen: the lock file exists and parses (used for supersession even when the file is otherwise invalid)
  //   state ∈ 'superseded' | 'invalid' | 'exhausted' | 'passed' | 'reopened' | 'open'
  export function gateDecision(states, { gateCount, latestPromptIso, finalText }): GateDecision
  //   GateDecision = { yielded: true } | null | { kind: 'invalid'|'open'|'confirmation', files: string[], reason: string }
  ```
  `editTimestamps` is an array of ISO strings of Edit/Write/NotebookEdit calls in the whole transcript. `reason` begins with `jev-goal-gate#<8 hex>`.

- [ ] **Step 1: Extend the goal-dir helper**

Append to `test/helpers/goal-dir.mjs`:

```js
import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';

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
```

(`writeFileSync` is already imported at the top of the helper.)

- [ ] **Step 2: Write the failing tests**

`test/goal-gate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { makeProject, writeCriteria, freezeFile, appendRound } from './helpers/goal-dir.mjs';
import { parseSlug, readRoundsTolerant, goalStates, gateDecision } from '../lib/goal-gate.mjs';
import { confirmationToken } from '../lib/token.mjs';

const spec = (extra = {}) => ({ task: 'demo task', criteria: [{ id: 'a', check: 'exit0', question: 'a?', evidence: 'true' }], ...extra });
const T0 = '2026-09-19T10:00:00.000Z', T1 = '2026-09-19T10:05:00.000Z', T2 = '2026-09-19T10:10:00.000Z', T3 = '2026-09-19T10:15:00.000Z';

test('parseSlug splits base and revision', () => {
  assert.deepEqual(parseSlug('C:\\p\\.claude\\jev\\task-2.json'), { slug: 'task-2', base: 'task', revision: 2 });
  assert.deepEqual(parseSlug('/p/.claude/jev/task.json'), { slug: 'task', base: 'task', revision: 1 });
  assert.deepEqual(parseSlug('/p/x-10.json'), { slug: 'x-10', base: 'x', revision: 10 });
});

test('readRoundsTolerant tolerates a truncated trailing line only', () => {
  const { jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'r', spec());
  assert.deepEqual(readRoundsTolerant(file.replace(/\.json$/, '.rounds.jsonl')), { rounds: [], corrupt: false });
  appendRound(file, { round: 1, at: T1, passed: false, failed: ['a'] });
  appendFileSync(file.replace(/\.json$/, '.rounds.jsonl'), '{"round":2,"at":"2026'); // no trailing newline: a writer mid-append
  const r = readRoundsTolerant(file.replace(/\.json$/, '.rounds.jsonl'));
  assert.equal(r.rounds.length, 1); assert.equal(r.corrupt, false);
  writeFileSync(file.replace(/\.json$/, '.rounds.jsonl'), '{bad}\n{"round":2,"at":"x","passed":true}\n');
  assert.equal(readRoundsTolerant(file.replace(/\.json$/, '.rounds.jsonl')).corrupt, true, 'bad line in the middle');
  writeFileSync(file.replace(/\.json$/, '.rounds.jsonl'), '{"round":1,"at":"x","passed":false}\n{bad}\n');
  assert.equal(readRoundsTolerant(file.replace(/\.json$/, '.rounds.jsonl')).corrupt, true, 'complete but corrupt last line (ends with newline)');
});

test('goalStates: open (no rounds), open (failed), passed, reopened, exhausted, invalid, superseded', () => {
  const { jevDir } = makeProject();
  const noRounds = writeCriteria(jevDir, 'a', spec()); freezeFile(noRounds, { frozenAt: T0 });
  const failed = writeCriteria(jevDir, 'b', spec()); freezeFile(failed, { frozenAt: T0 }); appendRound(failed, { round: 1, at: T1, passed: false, failed: ['a'] });
  const passed = writeCriteria(jevDir, 'c', spec()); freezeFile(passed, { frozenAt: T0 }); appendRound(passed, { round: 1, at: T1, passed: true });
  const reopened = writeCriteria(jevDir, 'd', spec()); freezeFile(reopened, { frozenAt: T0 }); appendRound(reopened, { round: 1, at: T1, passed: true });
  const exhausted = writeCriteria(jevDir, 'e', spec({ maxRounds: 1 })); freezeFile(exhausted, { frozenAt: T0 }); appendRound(exhausted, { round: 1, at: T1, passed: false, failed: ['a'] });
  const invalid = writeCriteria(jevDir, 'f', spec()); freezeFile(invalid, { frozenAt: T0 }); writeFileSync(invalid, JSON.stringify(spec({ task: 'edited' })));
  // revisions: g (rev 1) < g-2 < g-3; g-3 is frozen but its criteria were edited afterwards, so it is invalid
  // AND it still supersedes the lower revisions (supersession keys off "has a parseable lock", not validity).
  const old = writeCriteria(jevDir, 'g', spec()); freezeFile(old, { frozenAt: T0 });
  const newer = writeCriteria(jevDir, 'g-2', spec()); freezeFile(newer, { frozenAt: T1 });
  const newest = writeCriteria(jevDir, 'g-3', spec()); freezeFile(newest, { frozenAt: T2 }); writeFileSync(newest, JSON.stringify(spec({ task: 'tampered' })));
  const unfrozen = writeCriteria(jevDir, 'h', spec());

  // Edit timestamps are global to the transcript. The single edit below is at T2, so d (passed at T1) reopens
  // while c must have passed after T2 to stay 'passed': rewrite c's rounds with a pass at T3.
  writeFileSync(passed.replace(/\.json$/, '.rounds.jsonl'), '');
  appendRound(passed, { round: 1, at: T3, passed: true });

  const states = goalStates([noRounds, failed, passed, reopened, exhausted, invalid, old, newer, newest, unfrozen], { editTimestamps: [T2] });
  const byFile = Object.fromEntries(states.map((s) => [basename(s.file), s.state]));
  assert.deepEqual(byFile, {
    'a.json': 'open', 'b.json': 'open', 'c.json': 'passed', 'd.json': 'reopened', 'e.json': 'exhausted',
    'f.json': 'invalid', 'g.json': 'superseded', 'g-2.json': 'superseded', 'g-3.json': 'invalid', 'h.json': 'invalid',
  });
  assert.equal(states.find((s) => s.file === unfrozen).frozen, false);
  assert.equal(states.find((s) => s.file === newest).frozen, true);
  assert.equal(states.find((s) => s.file === failed).lastRound.failed[0], 'a');
  assert.equal(states.find((s) => s.file === exhausted).maxRounds, 1);
});

test('gateDecision yields at the cap and reports nothing when everything is terminal', () => {
  const { jevDir } = makeProject();
  const p = writeCriteria(jevDir, 'c', spec()); freezeFile(p, { frozenAt: T0 }); appendRound(p, { round: 1, at: T1, passed: true });
  const states = goalStates([p], { editTimestamps: [] });
  assert.deepEqual(gateDecision(states, { gateCount: 3, latestPromptIso: T0, finalText: '' }), { yielded: true });
  // passed before the latest prompt: no confirmation demanded
  assert.equal(gateDecision(states, { gateCount: 0, latestPromptIso: T2, finalText: '' }), null);
});

test('gateDecision blocks invalid before open, names files and failing ids', () => {
  const { jevDir } = makeProject();
  const bad = writeCriteria(jevDir, 'bad', spec()); freezeFile(bad, { frozenAt: T0 }); writeFileSync(bad, '{"task":"x","criteria":[]}');
  const open = writeCriteria(jevDir, 'open', spec()); freezeFile(open, { frozenAt: T0 }); appendRound(open, { round: 2, at: T1, passed: false, failed: ['a'] });
  const states = goalStates([bad, open], { editTimestamps: [] });
  const d = gateDecision(states, { gateCount: 0, latestPromptIso: T0, finalText: '' });
  assert.equal(d.kind, 'invalid');
  assert.match(d.reason, /^jev-goal-gate#[0-9a-f]{8}/);
  assert.match(d.reason, /bad\.json/);
  const d2 = gateDecision(states.filter((s) => s.state !== 'invalid'), { gateCount: 0, latestPromptIso: T0, finalText: '' });
  assert.equal(d2.kind, 'open');
  assert.match(d2.reason, /open\.json .*round 2.*failing: a/);
  assert.match(d2.reason, /yields after three blocks/);
});

test('gateDecision demands the confirmation token for a pass after the latest prompt', () => {
  const { jevDir } = makeProject();
  const p = writeCriteria(jevDir, 'c', spec()); const sha = freezeFile(p, { frozenAt: T0 }); appendRound(p, { round: 1, at: T2, passed: true });
  const states = goalStates([p], { editTimestamps: [] });
  const missing = gateDecision(states, { gateCount: 0, latestPromptIso: T1, finalText: 'all done' });
  assert.equal(missing.kind, 'confirmation');
  const wrong = gateDecision(states, { gateCount: 0, latestPromptIso: T1, finalText: `token: ${confirmationToken('other', sha, 1, T2)}` });
  assert.equal(wrong.kind, 'confirmation');
  const right = gateDecision(states, { gateCount: 0, latestPromptIso: T1, finalText: `--- jev-goal confirmation\ntoken: ${confirmationToken('c', sha, 1, T2)}\n--- end confirmation ---` });
  assert.equal(right, null);
});

test('reopened blocks with an explanation about edits after the pass', () => {
  const { jevDir } = makeProject();
  const p = writeCriteria(jevDir, 'c', spec()); freezeFile(p, { frozenAt: T0 }); appendRound(p, { round: 1, at: T1, passed: true });
  const states = goalStates([p], { editTimestamps: [T2] });
  const d = gateDecision(states, { gateCount: 0, latestPromptIso: T0, finalText: '' });
  assert.equal(d.kind, 'open');
  assert.match(d.reason, /changed after the passing grade/);
});
```

- [ ] **Step 3: Run to verify failure**

```bash
node --test test/goal-gate.test.mjs
```

- [ ] **Step 4: Implement `lib/goal-gate.mjs`**

```js
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { confirmationToken } from './token.mjs';

export function parseSlug(filePath) {
  const slug = basename(filePath).replace(/\.json$/, '');
  const m = /^(.*?)(?:-(\d+))?$/.exec(slug);
  const base = m[1] || slug;
  const revision = m[2] ? Number(m[2]) : 1;
  return { slug, base, revision };
}

export function readRoundsTolerant(roundsPath) {
  if (!existsSync(roundsPath)) return { rounds: [], corrupt: false };
  const raw = readFileSync(roundsPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const writerMidAppend = !raw.endsWith('\n'); // only then may the last line legitimately be incomplete
  const rounds = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      rounds.push(JSON.parse(lines[i]));
    } catch {
      if (i === lines.length - 1 && writerMidAppend) break;
      return { rounds: [], corrupt: true };
    }
  }
  return { rounds, corrupt: false };
}

const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

function readOne(file) {
  const { slug, base, revision } = parseSlug(file);
  const out = { file, slug, base, revision, frozen: false, state: 'open', task: slug, maxRounds: 10, rounds: [], lastRound: null, lockSha256: null, frozenAt: null };
  const lockPath = file + '.lock';
  let lock = null;
  if (existsSync(lockPath)) {
    try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { lock = null; }
  }
  if (lock && typeof lock.sha256 === 'string') { out.frozen = true; out.lockSha256 = lock.sha256; out.frozenAt = lock.frozenAt ?? null; }
  if (!existsSync(file)) return { ...out, state: 'invalid', error: 'criteria file missing' };
  if (!out.frozen) return { ...out, state: 'invalid', error: existsSync(lockPath) ? 'lock file unparseable' : 'lock file missing (freeze did not complete)' };
  let spec;
  try { spec = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { ...out, state: 'invalid', error: `criteria unparseable: ${e.message}` }; }
  out.task = typeof spec.task === 'string' ? spec.task : slug;
  out.maxRounds = Number.isInteger(spec.maxRounds) && spec.maxRounds >= 1 ? spec.maxRounds : 10;
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (sha !== lock.sha256) return { ...out, state: 'invalid', error: 'criteria modified after freeze' };
  const { rounds, corrupt } = readRoundsTolerant(file.replace(/\.json$/, '.rounds.jsonl'));
  if (corrupt) return { ...out, state: 'invalid', error: 'rounds file corrupt' };
  out.rounds = rounds;
  out.lastRound = rounds.at(-1) ?? null;
  return out;
}

export function goalStates(ownedFiles, { editTimestamps = [] } = {}) {
  const states = ownedFiles.map(readOne);
  // Supersession: the highest revision per base that HAS a parseable lock wins, valid or not.
  const newest = new Map();
  for (const s of states) {
    if (!s.frozen) continue;
    const cur = newest.get(s.base);
    if (!cur || s.revision > cur.revision) newest.set(s.base, s);
  }
  const lastEditMs = editTimestamps.map(ms).filter((t) => t !== null).reduce((a, b) => Math.max(a, b), -Infinity);
  for (const s of states) {
    if (s.frozen && newest.get(s.base) !== s) { s.state = 'superseded'; continue; }
    if (s.state === 'invalid') continue;
    const lr = s.lastRound;
    if (!lr) { s.state = 'open'; continue; }
    if (lr.passed) {
      const passMs = ms(lr.at);
      s.state = passMs !== null && lastEditMs > passMs ? 'reopened' : 'passed';
      continue;
    }
    s.state = s.rounds.length >= s.maxRounds ? 'exhausted' : 'open';
  }
  return states;
}

const sentinel = () => `jev-goal-gate#${randomBytes(4).toString('hex')}`;
const GRADE = 'node ~/.claude/skills/jev-goal/scripts/grade.mjs grade';

export function gateDecision(states, { gateCount, latestPromptIso, finalText }) {
  if (gateCount >= 3) return { yielded: true };
  const live = states.filter((s) => s.state !== 'superseded');
  const invalid = live.filter((s) => s.state === 'invalid');
  if (invalid.length) {
    const lines = invalid.map((s) => `  ${basename(s.file)}: ${s.error}`).join('\n');
    return {
      kind: 'invalid', files: invalid.map((s) => s.file),
      reason: `${sentinel()}: frozen criteria are in an invalid state.\n${lines}\nRestore the frozen criteria file exactly, or start <slug>-<n+1>.json for a genuinely new task, freeze it, then grade.`,
    };
  }
  const open = live.filter((s) => s.state === 'open' || s.state === 'reopened');
  if (open.length) {
    const lines = open.map((s) => {
      const n = s.rounds.length;
      const detail = s.state === 'reopened' ? 'files changed after the passing grade'
        : n === 0 ? 'not yet graded' : `round ${n}, failing: ${(s.lastRound.failed ?? []).join(', ') || 'none listed'}`;
      return `  ${basename(s.file)} (${s.task}): ${detail}`;
    }).join('\n');
    return {
      kind: 'open', files: open.map((s) => s.file),
      reason: `${sentinel()}: criteria frozen this session are not passing.\n${lines}\nRun \`${GRADE} <file>\` and keep working until it passes. If the criteria cannot be met, say why in one sentence and stop; the gate yields after three blocks.`,
    };
  }
  const promptMs = ms(latestPromptIso);
  const needConfirm = live.filter((s) => s.state === 'passed' && ms(s.lastRound.at) !== null && promptMs !== null && ms(s.lastRound.at) > promptMs &&
    !String(finalText ?? '').includes(confirmationToken(s.slug, s.lockSha256, s.lastRound.round, s.lastRound.at)));
  if (needConfirm.length) {
    const lines = needConfirm.map((s) => `  ${basename(s.file)} (${s.task})`).join('\n');
    return {
      kind: 'confirmation', files: needConfirm.map((s) => s.file),
      reason: `${sentinel()}: criteria passed this turn but the final message has no confirmation block.\n${lines}\nPaste the block between \`--- jev-goal confirmation\` and \`--- end confirmation ---\` from the grade output (it includes the token line), then summarise the work.`,
    };
  }
  return null;
}
```

- [ ] **Step 5: Run the tests**

```bash
node --test test/goal-gate.test.mjs
```

Expected: 7 pass. If the `goalStates` table test fails on `c.json`, confirm the test rewrote c's rounds file with the T3 pass before calling `goalStates` (edits at T2 must not reopen a pass at T3).

- [ ] **Step 6: Commit**

```bash
cd /c/Users/khe61/.claude/skills
git add jev-goal/scripts/lib/goal-gate.mjs jev-goal/scripts/test/goal-gate.test.mjs jev-goal/scripts/test/helpers/goal-dir.mjs
git commit -m "jev-goal: goal-gate state machine and decisions"
```

---

### Task 6: `stop-hook.mjs` entry point

**Files:**
- Create: `jev-goal/scripts/stop-hook.mjs`
- Test: `jev-goal/scripts/test/stop-hook.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1, 3, 4, 5.
- Environment: `JEV_STOP_HOOK` (`off`|`shadow`|`enforce`, default off), `JEV_STOP_HOOK_LOG` (log path override; default `~/.claude/jev-stop-hook/log.jsonl`), `JEV_FAKE_ANSWERS`, `JEV_FAKE_ERROR` (tests only, via `allowFake: true`).
- Stdin: Claude Code Stop hook JSON (`transcript_path`, `cwd`, `session_id`, `stop_hook_active`).
- Stdout: nothing, or `{"decision":"block","reason":"..."}`. Exit code always 0.
- Produces the log record shape of spec §6 (fields: `at, session, cwd, mode, nudgeCount, gateCount, gate, batteryRan, answers, wouldBlock, blocked, reason, finalMessagePreview, usage, error, label`).

- [ ] **Step 1: Write the failing tests**

`test/stop-hook.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScript } from './helpers/run.mjs';
import { makeBuilder } from './helpers/transcript-builder.mjs';
import { makeProject, writeCriteria, freezeFile, appendRound } from './helpers/goal-dir.mjs';
import { confirmationToken } from '../lib/token.mjs';

function run(transcriptPath, { mode = 'enforce', answers, error, cwd = 'C:\\proj' } = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'jev-log-'));
  const log = join(logDir, 'log.jsonl');
  const env = { JEV_STOP_HOOK: mode, JEV_STOP_HOOK_LOG: log };
  if (answers) env.JEV_FAKE_ANSWERS = JSON.stringify(answers);
  if (error) env.JEV_FAKE_ERROR = String(error);
  delete process.env.JEV_FAKE_ANSWERS; delete process.env.JEV_FAKE_ERROR;
  const input = JSON.stringify({ session_id: 's1', transcript_path: transcriptPath, cwd, stop_hook_active: false, hook_event_name: 'Stop' });
  const r = runScript('stop-hook.mjs', [], { env, input });
  const records = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const out = r.stdout.trim();
  return { ...r, out, decision: out ? JSON.parse(out) : null, records };
}

// A turn where the assistant edited a file and then stopped with a half-finished reply.
function workingTurn(finalText = 'I edited the route. Next I will add the test.') {
  const b = makeBuilder();
  b.human('add rate limiting to POST /upload with a test');
  const id = b.toolUse('Edit', { file_path: 'src/routes/upload.ts' });
  b.toolResult(id);
  b.assistantText(finalText);
  return b;
}

const UNFINISHED = { asks_user: 0.05, blocked_external: 0.05, declined: 0.02, promises_pending: 0.9, request_unmet: 0.9 };

test('off mode prints nothing and logs nothing', () => {
  const r = run(workingTurn().write(), { mode: 'off', answers: UNFINISHED });
  assert.equal(r.status, 0); assert.equal(r.out, ''); assert.equal(r.records.length, 0);
});

test('headless transcript (sdk-cli) is ignored', () => {
  const b = makeBuilder({ entrypoint: 'sdk-cli' });
  b.human('x'); const id = b.toolUse('Edit', { file_path: 'a' }); b.toolResult(id); b.assistantText('will do later');
  const r = run(b.write(), { answers: UNFINISHED });
  assert.equal(r.out, ''); assert.equal(r.records.length, 0);
});

test('conversation-only and research-only segments never nudge', () => {
  const b = makeBuilder(); b.human('what does this do?'); b.assistantText('It does X. I could also refactor it.');
  assert.equal(run(b.write(), { answers: UNFINISHED }).out, '');
  const c = makeBuilder(); c.human('find the bug'); const id = c.toolUse('Grep', { pattern: 'x' }); c.toolResult(id); c.assistantText('Found it in a.ts; I will fix it next.');
  assert.equal(run(c.write(), { answers: UNFINISHED }).out, '');
});

test('AskUserQuestion in the segment suppresses the battery', () => {
  const b = workingTurn(); const id = b.toolUse('AskUserQuestion', { questions: [] }); b.toolResult(id); b.assistantText('Waiting on your answer.');
  assert.equal(run(b.write(), { answers: UNFINISHED }).out, '');
});

test('battery blocks with a nudge in enforce mode and logs it', () => {
  const r = run(workingTurn().write(), { answers: UNFINISHED });
  assert.equal(r.status, 0);
  assert.equal(r.decision.decision, 'block');
  assert.match(r.decision.reason, /^jev-stop-nudge#[0-9a-f]{8} \(1\/2\): the user's request looks unfinished\./);
  assert.match(r.decision.reason, /request_unmet P\(true\)=0\.90/);
  assert.match(r.decision.reason, /promises_pending P\(true\)=0\.90/);
  assert.doesNotMatch(r.decision.reason, /asks_user/);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].blocked, true); assert.equal(r.records[0].wouldBlock, true); assert.equal(r.records[0].batteryRan, true);
  assert.equal(r.records[0].mode, 'enforce');
});

test('shadow mode logs wouldBlock but prints nothing', () => {
  const r = run(workingTurn().write(), { mode: 'shadow', answers: UNFINISHED });
  assert.equal(r.out, '');
  assert.equal(r.records[0].wouldBlock, true); assert.equal(r.records[0].blocked, false);
});

test('decision rule: each veto alone suppresses, each trigger alone fires, thresholds are inclusive/exclusive as specified', () => {
  const base = { asks_user: 0, blocked_external: 0, declined: 0, promises_pending: 0, request_unmet: 0 };
  const cases = [
    [{ ...base, promises_pending: 0.8 }, true],
    [{ ...base, promises_pending: 0.79 }, false],
    [{ ...base, promises_pending: 0.799 }, false], // raw value decides; 0.799 must NOT round up to 0.80 and fire
    [{ ...base, request_unmet: 0.8 }, true],
    [{ ...base, request_unmet: 0.9, asks_user: 0.5 }, false],
    [{ ...base, request_unmet: 0.9, asks_user: 0.49 }, true],
    [{ ...base, request_unmet: 0.9, asks_user: 0.499 }, true], // 0.499 must NOT round up to 0.50 and veto
    [{ ...base, request_unmet: 0.9, blocked_external: 0.6 }, false],
    [{ ...base, request_unmet: 0.9, declined: 0.7 }, false],
  ];
  for (const [answers, expectBlock] of cases) {
    const r = run(workingTurn().write(), { answers });
    assert.equal(!!r.decision, expectBlock, JSON.stringify(answers));
    if (expectBlock) assert.deepEqual(r.records[0].fired.vetoes, []);
  }
  const fired = run(workingTurn().write(), { answers: { ...base, request_unmet: 0.9, declined: 0.7 } }).records[0].fired;
  assert.deepEqual(fired, { triggers: ['request_unmet'], vetoes: ['declined'] });
});

test('nudge cap: second nudge needs mutating progress; third never fires; restatement vetoes', () => {
  // one prior nudge, then only a Read: no second nudge
  const b1 = workingTurn(); b1.feedback('jev-stop-nudge#11111111 (1/2): unfinished'); const rd = b1.toolUse('Read', { file_path: 'a' }); b1.toolResult(rd); b1.assistantText('Still planning to add the test.');
  assert.equal(run(b1.write(), { answers: UNFINISHED }).out, '');
  // one prior nudge, then an Edit: second nudge allowed, counter says 2/2, previousNudge sent
  const b2 = workingTurn(); b2.feedback('jev-stop-nudge#11111111 (1/2): unfinished'); const ed = b2.toolUse('Edit', { file_path: 'test/upload.test.ts' }); b2.toolResult(ed); b2.assistantText('Added the test file. I still need to run it.');
  const r2 = run(b2.write(), { answers: { ...UNFINISHED, restatement: 0.1 } });
  assert.match(r2.decision.reason, /\(2\/2\)/);
  assert.equal(r2.records[0].nudgeCount, 1);
  // same, but Jev says it is a restatement: no nudge
  assert.equal(run(b2.write(), { answers: { ...UNFINISHED, restatement: 0.9 } }).out, '');
  // two prior nudges: nothing, and no battery call
  const b3 = workingTurn(); b3.feedback('jev-stop-nudge#11111111 (1/2): x'); const e1 = b3.toolUse('Edit', { file_path: 'a' }); b3.toolResult(e1); b3.assistantText('more'); b3.feedback('jev-stop-nudge#22222222 (2/2): y'); const e2 = b3.toolUse('Edit', { file_path: 'b' }); b3.toolResult(e2); b3.assistantText('even more, will continue');
  const r3 = run(b3.write(), { answers: UNFINISHED });
  assert.equal(r3.out, '');
  assert.equal(r3.records[0]?.batteryRan ?? false, false);
});

test('a reply to the agent-logs hook (empty segment) does not nudge even though the chain has edits', () => {
  const b = workingTurn(); b.feedback('End-of-session agent-logs check.'); b.assistantText('Nothing worth logging.');
  assert.equal(run(b.write(), { answers: UNFINISHED }).out, '');
});

test('grader failures fail open and are logged', () => {
  const r429 = run(workingTurn().write(), { error: 429 });
  assert.equal(r429.out, ''); assert.equal(r429.records[0].error.code, 'grader_unavailable'); assert.equal(r429.records[0].error.status, 429);
});

test('redaction reaches the log preview', () => {
  const r = run(workingTurn('Set AI_GATEWAY_API_KEY=vck_secret_value_123 in .env, then I will retry.').write(), { mode: 'shadow', answers: UNFINISHED });
  assert.match(r.records[0].finalMessagePreview, /AI_GATEWAY_API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(r.records[0]), /vck_secret/);
});

test('owned open goal: gate blocks and the battery is skipped', () => {
  const { root, jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'task', { task: 'rate limit', criteria: [{ id: 'a', check: 'exit0', question: 'a?', evidence: 'true' }] });
  freezeFile(file);
  const b = makeBuilder({ cwd: root });
  b.human('do the task with jev');
  const fz = b.toolUse('Bash', { command: `node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze "${file}"` }); b.toolResult(fz, 'frozen');
  const ed = b.toolUse('Edit', { file_path: 'src/a.ts' }); b.toolResult(ed);
  b.assistantText('Done, I think.');
  const r = run(b.write(), { answers: UNFINISHED, cwd: root });
  assert.match(r.decision.reason, /^jev-goal-gate#[0-9a-f]{8}/);
  assert.match(r.decision.reason, /task\.json.*not yet graded/);
  assert.equal(r.records[0].batteryRan, false);
  assert.equal(r.records[0].gate.states['task.json'], 'open');
});

test('owned goal passed this turn without the token blocks; with the token passes and battery stays off', () => {
  const { root, jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'task', { task: 'rate limit', criteria: [{ id: 'a', check: 'exit0', question: 'a?', evidence: 'true' }] });
  const sha = freezeFile(file);
  const b = makeBuilder({ cwd: root });
  b.human('do the task with jev');
  const fz = b.toolUse('Bash', { command: `node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze ${file}` }); b.toolResult(fz, 'frozen');
  const ed = b.toolUse('Edit', { file_path: 'src/a.ts' }); b.toolResult(ed);
  const at = new Date(Date.now() + 60_000).toISOString(); // after every transcript timestamp
  appendRound(file, { round: 1, at, passed: true });
  const gr = b.toolUse('Bash', { command: `node ~/.claude/skills/jev-goal/scripts/grade.mjs grade ${file}` }); b.toolResult(gr, 'PASS');
  b.assistantText('All criteria met.');
  const missing = run(b.write(), { answers: UNFINISHED, cwd: root });
  assert.match(missing.decision.reason, /no confirmation block/);
  b.assistantText(`--- jev-goal confirmation\ntoken: ${confirmationToken('task', sha, 1, at)}\n--- end confirmation ---`);
  const ok = run(b.write(), { answers: UNFINISHED, cwd: root });
  assert.equal(ok.out, '');
  assert.equal(ok.records[0].batteryRan, false);
});

test('gate cap: after three gate blocks the gate yields', () => {
  const { root, jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'task', { task: 't', criteria: [{ id: 'a', check: 'exit0', question: 'a?', evidence: 'true' }] });
  freezeFile(file);
  const b = makeBuilder({ cwd: root });
  b.human('go');
  const fz = b.toolUse('Bash', { command: `node grade.mjs freeze ${file}` }); b.toolResult(fz, 'frozen');
  for (const id of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) { b.assistantText('trying'); b.feedback(`jev-goal-gate#${id}: open`); }
  b.assistantText('I cannot satisfy criterion a because the API is down.');
  const r = run(b.write(), { answers: UNFINISHED, cwd: root });
  assert.equal(r.out, '');
  assert.equal(r.records[0].gate.gateYielded, true);
});

test('state sent to the judge: preceding assistant message, redacted summaries, our nudge block only', () => {
  // The fake judge cannot see the state, so the hook dumps the exact object when JEV_STOP_HOOK_DUMP_STATE is set.
  const b = makeBuilder();
  b.human('should I add caching?'); b.assistantText('Yes, I propose an LRU cache in api.ts. Want me to?');
  b.human('yes do that');
  const id = b.toolUse('Bash', { command: 'npm install lru-cache --save' }); b.toolResult(id);
  const ed = b.toolUse('Edit', { file_path: 'C:/proj/config/API_KEY=sk-abcdefghijklmnop1234.ts' }); b.toolResult(ed);
  b.assistantText('Installed. I will wire it in next.');
  b.feedback('End-of-session agent-logs check. blah\n\njev-stop-nudge#0a1b2c3d (1/2): the user\'s request looks unfinished.\n  request_unmet P(true)=0.91: the latest request asks for a deliverable the final message does not report as done.\nIf you can advance the request now, do it. If you are genuinely waiting on the user, say so in one sentence and stop.\n\nPost-deploy idea-capture check.');
  const ed2 = b.toolUse('Edit', { file_path: 'src/api.ts' }); b.toolResult(ed2);
  const ed3 = b.toolUse('Write', { file_path: 'C:/proj/notes/TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123.md', content: 'x' }); b.toolResult(ed3);
  b.assistantText('Wired the cache in. Tests still to run.');
  const dump = join(mkdtempSync(join(tmpdir(), 'jev-dump-')), 'state.json');
  const logDir = mkdtempSync(join(tmpdir(), 'jev-log-'));
  const input = JSON.stringify({ session_id: 's1', transcript_path: b.write(), cwd: 'C:\\proj', stop_hook_active: false });
  const r = runScript('stop-hook.mjs', [], { input, env: { JEV_STOP_HOOK: 'shadow', JEV_STOP_HOOK_LOG: join(logDir, 'log.jsonl'), JEV_STOP_HOOK_DUMP_STATE: dump, JEV_FAKE_ANSWERS: JSON.stringify({ ...UNFINISHED, restatement: 0.1 }) } });
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(readFileSync(dump, 'utf8'));
  assert.equal(state.latestUserRequest, 'yes do that');
  assert.equal(state.assistantMessageBeforeRequest, 'Yes, I propose an LRU cache in api.ts. Want me to?');
  assert.equal(state.finalAssistantMessage, 'Wired the cache in. Tests still to run.');
  assert.equal(state.toolCallsThisSegment.length, 2, 'segment = after our nudge only');
  assert.deepEqual(state.toolCallsThisSegment[0], { name: 'Edit', summary: 'src/api.ts', ok: true });
  assert.equal(state.toolCallsThisSegment[1].name, 'Write');
  assert.match(state.toolCallsThisSegment[1].summary, /\[REDACTED\]/, 'secret-shaped path text is redacted');
  assert.doesNotMatch(JSON.stringify(state), /ghp_abcdefghijklmnopqrstuvwxyz0123|sk-abcdefghijklmnop1234/);
  assert.match(state.previousNudge.reason, /^jev-stop-nudge#0a1b2c3d/);
  assert.doesNotMatch(state.previousNudge.reason, /agent-logs|idea-capture/, 'other hooks\' text never leaves the machine');
  assert.equal(state.previousNudge.assistantMessageBefore, 'Installed. I will wire it in next.');
  assert.equal(state.previousNudge.mutatingCallsAfter, 2);
  const logged = JSON.parse(readFileSync(join(logDir, 'log.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.ok(!('stateDigest' in logged), 'no state digest is logged');
  assert.ok(JSON.stringify(logged).length < 4000, 'log record stays small');
});

test('a frozen file this session did not freeze is not owned: no gate, battery runs', () => {
  const { root, jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'someone-elses', { task: 'other session', criteria: [{ id: 'a', check: 'exit0', question: 'a?', evidence: 'true' }] });
  freezeFile(file);
  const b = makeBuilder({ cwd: root });
  b.human('fix the bug'); const ed = b.toolUse('Edit', { file_path: 'src/a.ts' }); b.toolResult(ed); b.assistantText('Fixed one case; the other still needs a change.');
  const r = run(b.write(), { answers: UNFINISHED, cwd: root });
  assert.equal(r.records[0].gate, null);
  assert.equal(r.records[0].batteryRan, true);
  assert.match(r.decision.reason, /^jev-stop-nudge#/);
});

test('a Read after a PASS does not reopen the goal', () => {
  const { root, jevDir } = makeProject();
  const file = writeCriteria(jevDir, 'task', { task: 't', criteria: [{ id: 'a', check: 'exit0', question: 'a?', evidence: 'true' }] });
  const sha = freezeFile(file);
  const b = makeBuilder({ cwd: root });
  b.human('do it with jev');
  const fz = b.toolUse('Bash', { command: `node grade.mjs freeze ${file}` }); b.toolResult(fz, 'frozen');
  const at = '2026-09-19T09:30:00.000Z'; // before the builder's fixed 10:00Z epoch: passed before this prompt chain, so no confirmation demanded
  appendRound(file, { round: 1, at, passed: true });
  const rd = b.toolUse('Read', { file_path: 'src/a.ts' }); b.toolResult(rd);
  b.assistantText('Reviewed the result.');
  const r = run(b.write(), { answers: UNFINISHED, cwd: root });
  assert.equal(r.out, '');
  assert.equal(r.records[0].gate.states['task.json'], 'passed');
  void sha;
});

test('missing gateway key fails open and is logged as no_key', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'jev-log-'));
  const log = join(logDir, 'log.jsonl');
  const input = JSON.stringify({ session_id: 's1', transcript_path: workingTurn().write(), cwd: 'C:\\proj', stop_hook_active: false });
  // An empty value already present in the environment stops dotenv from filling the key in.
  const r = runScript('stop-hook.mjs', [], { input, env: { JEV_STOP_HOOK: 'enforce', JEV_STOP_HOOK_LOG: log, AI_GATEWAY_API_KEY: '' } });
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '');
  const rec = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1));
  assert.equal(rec.error.code, 'no_key');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
node --test test/stop-hook.test.mjs
```

Expected: all fail (script missing).

- [ ] **Step 3: Implement `stop-hook.mjs`**

```js
#!/usr/bin/env node
// Claude Code Stop hook: goal gate (deterministic) + Jev nudge battery. See docs/specs/2026-09-19-jev-stop-nudge-design.md.
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { askJev, JevError, RULE, truncate, capList } from './lib/jev.mjs';
import { redact } from './lib/redact.mjs';
import {
  parseTranscript, isHeadless, chain, segment, segmentBefore, finalAssistantText, toolCalls, freezeInvocations,
  sentinelPositions, lastHumanPromptIndex, entryText, isMutating, extractNudgeReason, WAITING_TOOLS, EDIT_TOOLS,
} from './lib/transcript.mjs';
import { goalStates, gateDecision } from './lib/goal-gate.mjs';

export const TRIGGER = 0.8; // trigger fires at P(true) >= TRIGGER (raw, unrounded)
export const VETO = 0.5;    // veto holds at P(true) >= VETO (raw, unrounded)
const NUDGE_CAP = 2;
const CAPS = { request: 4000, before: 3000, final: 6000, nudgeBefore: 3000, summary: 200 };
const TRIGGER_IDS = ['promises_pending', 'request_unmet'];
const VETO_IDS = ['asks_user', 'blocked_external', 'declined', 'restatement'];

const mode = (process.env.JEV_STOP_HOOK ?? 'off').toLowerCase();
const logPath = process.env.JEV_STOP_HOOK_LOG ?? join(homedir(), '.claude', 'jev-stop-hook', 'log.jsonl');

main().catch(() => process.exit(0));

async function main() {
  if (mode !== 'shadow' && mode !== 'enforce') return;
  const input = await readStdin();
  const transcriptPath = input.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) return;

  const record = {
    at: new Date().toISOString(), session: input.session_id ?? null, cwd: input.cwd ?? null, mode,
    nudgeCount: 0, gateCount: 0, gate: null, batteryRan: false, answers: null, fired: null, wouldBlock: false, blocked: false,
    reason: null, finalMessagePreview: null, usage: null, error: null, label: null,
  };
  let decision = null;

  try {
    const entries = parseTranscript(transcriptPath);
    if (!entries.length || isHeadless(entries)) return;
    const promptIdx = lastHumanPromptIndex(entries);
    if (promptIdx < 0) return;
    const ch = chain(entries);
    const seg = segment(entries);
    const finalText = finalAssistantText(seg);
    record.finalMessagePreview = redact(finalText).slice(0, 80);
    const nudgePositions = sentinelPositions(ch, 'jev-stop-nudge');
    record.nudgeCount = nudgePositions.length;
    record.gateCount = sentinelPositions(ch, 'jev-goal-gate').length;

    // --- goal gate -------------------------------------------------------
    const owned = freezeInvocations(entries);
    if (owned.length) {
      const editTimestamps = toolCalls(entries).filter((c) => EDIT_TOOLS.has(c.name)).map((c) => c.timestamp);
      const states = goalStates(owned, { editTimestamps });
      const gd = gateDecision(states, { gateCount: record.gateCount, latestPromptIso: entries[promptIdx].timestamp, finalText });
      record.gate = {
        owned: owned.map((f) => basename(f)),
        states: Object.fromEntries(states.map((s) => [basename(s.file), s.state])),
        blockedOn: gd && !gd.yielded ? gd.kind : null,
        gateYielded: !!gd?.yielded,
      };
      if (gd && !gd.yielded) decision = gd.reason;
      // While a goal exists the gate is the authority; the battery never runs.
      return;
    }

    // --- battery eligibility ---------------------------------------------
    const segCalls = toolCalls(seg);
    if (!segCalls.some((c) => isMutating(c.name))) return;
    if (segCalls.some((c) => WAITING_TOOLS.has(c.name))) return;
    if (record.nudgeCount >= NUDGE_CAP) return;
    let previousNudge = null;
    if (record.nudgeCount === 1) {
      const pos = nudgePositions[0];
      const after = toolCalls(ch).filter((c) => c.index > pos && isMutating(c.name));
      if (!after.length) return;
      previousNudge = {
        reason: redact(extractNudgeReason(entryText(ch[pos])) ?? ''), // only OUR block, never other hooks' text
        assistantMessageBefore: truncate(redact(finalAssistantText(segmentBefore(ch, pos))), CAPS.nudgeBefore, 0),
        mutatingCallsAfter: after.length,
      };
    }

    // --- battery ----------------------------------------------------------
    const summarised = segCalls.map((c) => ({ name: redact(c.name), summary: truncate(redact(c.summary), CAPS.summary, 0), ok: c.ok }));
    const state = {
      latestUserRequest: truncate(redact(entryText(entries[promptIdx])), CAPS.request, 0),
      assistantMessageBeforeRequest: promptIdx > 0 ? truncate(redact(finalAssistantText(segmentBefore(entries, promptIdx))), CAPS.before, 0) || null : null,
      finalAssistantMessage: truncate(redact(finalText), CAPS.final, 0),
      toolCallsThisSegment: capList(summarised, 39, 20),
      previousNudge,
    };
    if (process.env.JEV_STOP_HOOK_DUMP_STATE) {
      // Test-only: write the exact object sent to the judge. Never set in a real registration.
      try { writeFileSync(process.env.JEV_STOP_HOOK_DUMP_STATE, JSON.stringify(state, null, 2)); } catch { /* ignore */ }
    }
    const questions = buildQuestions(!!previousNudge);
    record.batteryRan = true;
    const result = await askJev({ questions, state, timeoutMs: 25_000, maxRetries: 0, allowFake: true });
    record.usage = result.usage;
    const raw = Object.fromEntries(Object.keys(questions).map((id) => [id, Number(result.answers[id]?.probability ?? 0)]));
    record.answers = Object.fromEntries(Object.entries(raw).map(([id, p]) => [id, round2(p)])); // rounded for the log only
    const triggers = TRIGGER_IDS.filter((id) => raw[id] >= TRIGGER);
    const vetoes = VETO_IDS.filter((id) => id in raw && raw[id] >= VETO);
    record.fired = { triggers, vetoes };
    if (triggers.length && !vetoes.length) {
      decision = nudgeReason(triggers, raw, record.nudgeCount + 1);
    }
  } catch (e) {
    record.error = e instanceof JevError ? { code: e.code, status: e.status ?? null, message: e.message } : { code: 'exception', message: String(e?.message ?? e) };
    decision = null;
  } finally {
    record.wouldBlock = !!decision;
    record.blocked = !!decision && mode === 'enforce';
    record.reason = decision;
    if (record.blocked) process.stdout.write(JSON.stringify({ decision: 'block', reason: decision }) + '\n');
    if (record.gate || record.batteryRan || record.error) appendLog(record);
  }
}

function buildQuestions(withRestatement) {
  const q = (question) => ({ type: 'boolean', instructions: { question, rule: RULE } });
  const questions = {
    asks_user: q('Does the final assistant message end by asking the user a question, or asking them to choose between options or approve something, such that the assistant needs that answer before it can continue?'),
    blocked_external: q('Does the final assistant message state that further progress needs the user\'s permission, information only the user has, or an event outside the assistant\'s control?'),
    declined: q('Does the final assistant message state that the assistant will not or cannot do the requested work, and give a reason such as safety, scope, or impossibility?'),
    promises_pending: q('Does the final assistant message say the assistant will do, or still needs to do, specific work that the same message does not report as already done?'),
    request_unmet: q('Does the latest user request ask for a concrete deliverable that the final assistant message does not report as done?'),
  };
  if (withRestatement) {
    questions.restatement = q('Compared with the assistant message before the previous nudge, does the final assistant message repeat the same promises or the same blocker without reporting new progress?');
  }
  return questions;
}

const EXPLAIN = {
  request_unmet: 'the latest request asks for a deliverable the final message does not report as done.',
  promises_pending: 'the final message describes work not yet done.',
};

function nudgeReason(triggers, p, n) {
  const id = randomBytes(4).toString('hex');
  const lines = triggers.map((t) => `  ${t} P(true)=${p[t].toFixed(2)}: ${EXPLAIN[t]}`);
  return [
    `jev-stop-nudge#${id} (${n}/${NUDGE_CAP}): the user's request looks unfinished.`,
    ...lines,
    'If you can advance the request now, do it. If you are genuinely waiting on the user, say so in one sentence and stop.',
  ].join('\n');
}

const round2 = (x) => Math.round(Number(x) * 100) / 100;

function appendLog(record) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch { /* best effort */ }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    process.stdin.on('error', () => resolve({}));
  });
}
```

Log fields beyond the spec's §6 list: `fired: { triggers, vetoes }` records which signals crossed their thresholds (the report displays these rather than recomputing them, so tuning the constants never desynchronises the report). `finalMessagePreview` is the redacted 80-character preview. Nothing else from the state is logged; `JEV_STOP_HOOK_DUMP_STATE` exists only so tests can inspect the exact object sent to the judge.

- [ ] **Step 4: Run the tests**

```bash
node --test test/stop-hook.test.mjs
```

Expected: 18 pass. Common failures and what they mean:
- `owned open goal` test: `freezeInvocations` did not match the quoted absolute path — check `FREEZE_RE` in Task 4.
- `confirmation` test: `latestPromptIso` comparison uses ISO strings; the test's `at` is 60 s in the future so it is later than every builder timestamp (builder starts at a fixed 2026-09-19T10:00 epoch; if today is later than that, the comparison still holds because `at` is `Date.now()+60s`).
- `agent-logs reply` test: confirm `segment()` starts after the feedback entry.

- [ ] **Step 5: Run the whole suite**

```bash
npm test
```

Expected: 55 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
cd /c/Users/khe61/.claude/skills
git add jev-goal/scripts/stop-hook.mjs jev-goal/scripts/test/stop-hook.test.mjs
git commit -m "jev-goal: stop-hook entry point (goal gate + Jev nudge battery)"
```

---

### Task 7: Shadow-log report and transcript replay

**Files:**
- Create: `jev-goal/scripts/stop-hook-report.mjs`, `jev-goal/scripts/replay-stop-hook.mjs`
- Test: `jev-goal/scripts/test/report.test.mjs`

**Interfaces:**
- `node stop-hook-report.mjs [--log <path>]` prints one row per record: `#`, date (local, `MM-DD HH:mm`), project (basename of cwd), gate states or `-`, `would` (`Y`/`n`), fired signals, error code or `-`, label, preview. `--label <n> good|bad` rewrites the file with that record's `label` set and prints the row.
- `node replay-stop-hook.mjs <transcript.jsonl> [--max-calls 5] [--max-points 200] [--mode shadow]` finds every stop point (each string-content user entry after the first human prompt, plus end of file), writes a truncated copy of the transcript to a temp file for each, runs `stop-hook.mjs` with `JEV_STOP_HOOK=<mode>` and a temp log, then prints the report for that log. `--max-calls` (default 5) caps how many points may actually call Jev; `--max-points` (default 200) caps how many stop points are processed at all. A point counts as a call only when it appended a new log record with `batteryRan: true` (detected by comparing the log's line count before and after the run, never by re-reading the previous record). The script sleeps 20 s after each real call.

- [ ] **Step 1: Write the report test**

`test/report.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScript } from './helpers/run.mjs';

const rec = (over = {}) => ({ at: '2026-09-19T14:02:11.120Z', session: 's', cwd: 'C:\\dev\\proj', mode: 'shadow', nudgeCount: 0, gateCount: 0, gate: null, batteryRan: true,
  answers: { asks_user: 0.03, blocked_external: 0.05, declined: 0.02, promises_pending: 0.84, request_unmet: 0.91 },
  fired: { triggers: ['promises_pending', 'request_unmet'], vetoes: [] }, wouldBlock: true, blocked: false,
  reason: 'jev-stop-nudge#abcd1234 (1/2): x', finalMessagePreview: 'I edited the route. Next I will', usage: null, error: null, label: null, ...over });

test('report prints a row per record with fired signals and gate states', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-rep-'));
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, [JSON.stringify(rec()), JSON.stringify(rec({ batteryRan: false, wouldBlock: false, gate: { owned: ['t.json'], states: { 't.json': 'open' }, blockedOn: 'open', gateYielded: false } }))].join('\n') + '\n');
  const r = runScript('stop-hook-report.mjs', ['--log', log]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3, 'header + 2 rows');
  assert.match(lines[1], /proj/); assert.match(lines[1], /Y/); assert.match(lines[1], /promises_pending,request_unmet/); assert.match(lines[1], /I edited the route/);
  assert.match(lines[2], /t\.json=open/);
});

test('--label rewrites the record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-rep-'));
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, JSON.stringify(rec()) + '\n' + JSON.stringify(rec()) + '\n');
  const r = runScript('stop-hook-report.mjs', ['--log', log, '--label', '2', 'bad']);
  assert.equal(r.status, 0, r.stderr);
  const recs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(recs[0].label, null); assert.equal(recs[1].label, 'bad');
});
```

- [ ] **Step 2: Run to verify failure, then implement the report**

```bash
node --test test/report.test.mjs
```

`stop-hook-report.mjs`:

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
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
```

- [ ] **Step 3: Run the report tests**

```bash
node --test test/report.test.mjs
```

Expected: 2 pass.

- [ ] **Step 4: Write the replay script (manual tool, smoke-tested by hand)**

`replay-stop-hook.mjs`:

```js
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
```

- [ ] **Step 5: Smoke-test the replay against this session's own transcript with the fake judge (no network)**

```bash
cd /c/Users/khe61/.claude/skills/jev-goal/scripts
T=$(cygpath -m "$(ls -t /c/Users/khe61/.claude/projects/C--dev-jev-goal-page/*.jsonl | head -1)")   # Node on Windows cannot open /c/... paths
JEV_FAKE_ANSWERS='{"promises_pending":0.9,"request_unmet":0.9}' node replay-stop-hook.mjs "$T" --max-calls 3 --max-points 40
```

Expected: `stop point ... pass|BLOCK` lines on stderr (most will say `(no record)` because a reply to a hook prompt has an empty segment), a report table on stdout, and a final `processed N stop point(s), M Jev call(s)` line. The fake answers make every eligible working segment a `would=Y` row; the point is that the script runs end to end and the sleep only follows lines marked `[jev call]`.

- [ ] **Step 6: Commit**

```bash
cd /c/Users/khe61/.claude/skills
git add jev-goal/scripts/stop-hook-report.mjs jev-goal/scripts/replay-stop-hook.mjs jev-goal/scripts/test/report.test.mjs
git commit -m "jev-goal: shadow-log report and transcript replay tools"
```

---

### Task 8: SKILL.md section, final suite, merge, then registration and live shadow verification

**Files:**
- Modify: `jev-goal/SKILL.md` (new section before "Rationalizations that mean STOP")
- Modify: `C:\Users\khe61\.claude\settings.json` (not in the repo; add `env` and the third Stop hook) **only after** the suite is green and the branch is merged, with a dated backup taken first

**Interfaces:** none new.

Order matters in this task: nothing is registered globally until the code that will run in every future session is complete, tested, and on `main`.

- [ ] **Step 1: Add the SKILL.md section**

Insert before `## Rationalizations that mean STOP`:

```markdown
## The Stop hook (goal gate + nudge)

A Stop hook (`scripts/stop-hook.mjs`, registered in `~/.claude/settings.json`) backs this skill:

- **Goal gate.** Criteria you froze in this session (the hook finds your `grade.mjs freeze` command in the transcript) hold the session until they pass, hit `maxRounds`, or the gate has blocked three times. Editing a file after a PASS reopens the goal; grade again. A PASS in the current turn must be followed by the confirmation block, token line included, in the final message. If the criteria cannot be met, say why in one sentence and stop; the gate yields after three blocks and Claude Code itself stops honouring blocks after eight.
- **Nudge.** With no goal active, after a turn that used a mutating tool, the hook asks Jev whether the final message leaves the latest request unfinished (no question to the user, no external blocker, no refusal, but promised or missing work). If so it blocks once, or twice when real progress followed the first nudge. A conversation-only or research-only turn is never nudged.
- **Modes.** `JEV_STOP_HOOK` is `off`, `shadow` (log only, no blocking), or `enforce`. Set `off` in a project's `.claude/settings.json` `env` to exclude that repository. Headless `claude -p` and SDK runs are detected from the transcript (`entrypoint: sdk-cli`) and ignored; `--safe-mode` disables hooks entirely as well.
- **Data.** When the nudge runs, the redacted latest prompt, the redacted preceding assistant reply, the redacted final message, and tool names with file paths or the first word of a shell command go to Vercel AI Gateway and TypeSafe AI. Full commands, tool outputs, file contents, and earlier prompts never leave the machine. Redaction is a floor, not a guarantee.
- **Log and tuning.** Every evaluation appends to `~/.claude/jev-stop-hook/log.jsonl`. `node scripts/stop-hook-report.mjs` prints it; `--label <n> good|bad` records your verdict. Run in `shadow` for about a week, label, adjust the thresholds at the top of `stop-hook.mjs`, then switch to `enforce`. The hook fails open on any grader error, including the free-tier rate limit of roughly eight calls per five minutes.
```

- [ ] **Step 2: Full suite, green before anything ships**

```bash
cd /c/Users/khe61/.claude/skills/jev-goal/scripts
npm test
```

Expected: 57 pass, 0 fail. Do not continue with a red suite.

- [ ] **Step 3: Commit, merge to main, leave push to the user**

```bash
cd /c/Users/khe61/.claude/skills
git add jev-goal/SKILL.md
git commit -m "jev-goal: document the Stop hook (goal gate + nudge), modes, data boundary"
git checkout main
git merge --no-ff jev-stop-nudge -m "Merge jev-stop-nudge: Stop hook with goal gate and Jev nudge battery"
git branch -d jev-stop-nudge
git log --oneline -12
```

Do **not** push. `main` is now ahead of `origin/main`; the final report says so.

- [ ] **Step 4: Back up settings.json, then register the hook and the env var**

```bash
cp /c/Users/khe61/.claude/settings.json "/c/Users/khe61/.claude/settings.json.bak-$(date +%Y%m%d-%H%M%S)"
ls -1 /c/Users/khe61/.claude/settings.json.bak-*
```

Then read `C:\Users\khe61\.claude\settings.json`. Using the Edit tool (not a heredoc), make two changes:

1. Add a top-level `"env"` key (the file has none today) right after the `"permissions"` block:
   ```json
   "env": { "JEV_STOP_HOOK": "shadow" },
   ```
2. In `hooks.Stop[0].hooks`, append after the `stop-idea-capture.py` entry:
   ```json
   ,
   {
     "type": "command",
     "command": "node ~/.claude/skills/jev-goal/scripts/stop-hook.mjs",
     "timeout": 45
   }
   ```

Validate:

```bash
python -c "import json;d=json.load(open(r'C:\Users\khe61\.claude\settings.json'));print(d['env']);print([h['command'] for h in d['hooks']['Stop'][0]['hooks']])"
```

Expected: `{'JEV_STOP_HOOK': 'shadow'}` and three commands, the new one last.

- [ ] **Step 5: Live shadow verification against the current session transcript**

```bash
cd /c/Users/khe61/.claude/skills/jev-goal/scripts
T=$(cygpath -m "$(ls -t /c/Users/khe61/.claude/projects/C--dev-jev-goal-page/*.jsonl | head -1)")   # forward-slash Windows path Node can open
printf '{"session_id":"manual","transcript_path":"%s","cwd":"C:/dev/jev-goal-page","stop_hook_active":false,"hook_event_name":"Stop"}' "$T" | JEV_STOP_HOOK=shadow node stop-hook.mjs; echo "exit $?"
node stop-hook-report.mjs | tail -3
```

Expected: exit 0, no stdout from the hook. The report shows a new row. This session has no `freeze` invocation, so `gate` is `-`; whether `would` is `Y` or `n` depends on the last segment (a segment with only file writes and a reply that promises more work should be `Y`). If the row shows `err=grader_unavailable`, wait two minutes (rate limit) and run once more. If `err=no_key`, `scripts/.env` is missing `AI_GATEWAY_API_KEY`. Record the row in the task report.

- [ ] **Step 6: Start the calibration set with two real transcripts from other projects (real Jev calls, shadow mode)**

Pick the two most recently modified transcripts from two different project directories other than `jev-goal-page` (for example under `~/.claude/projects/C--dev-traderprep/` and `~/.claude/projects/C--dev-travel-app/`; use `ls -t` to choose). For each:

```bash
cd /c/Users/khe61/.claude/skills/jev-goal/scripts
T=$(cygpath -m "$(ls -t /c/Users/khe61/.claude/projects/<project-dir>/*.jsonl | head -1)")
node replay-stop-hook.mjs "$T" --max-calls 3 --max-points 60
```

Each run makes at most three Jev calls with 20 s gaps, so two runs stay inside the free-tier limit. Wait two minutes between the two runs. Paste both report tables into the task report and add one line per `would=Y` row saying whether a human would have nudged there. This is the first entry in the calibration log the spec asks for before enforce mode; the rest accumulates during the shadow week. If a row shows `err=grader_unavailable`, note it and move on (fail-open is the specified behaviour).

- [ ] **Step 7: Record the rollback in the task report**

The report must state, verbatim, how to disable the hook: set `"JEV_STOP_HOOK": "off"` in the `env` block of `~/.claude/settings.json` (no restart needed for new sessions), or restore the backup file created in Step 4 to remove the registration entirely. The final message to the user repeats this, together with: `main` is ahead of `origin/main` and unpushed; the hook is live in `shadow` mode for every new interactive session; nothing blocks until the mode is changed to `enforce`.
