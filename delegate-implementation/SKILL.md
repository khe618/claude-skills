---
name: delegate-implementation
description: Delegate token-heavy, mechanically-verifiable implementation work to an external coding agent (Codex preferred, opencode on quota exhaustion) to conserve the main session's context. Use when the approach is already decided and the work is bulk — many files receiving the same transformation, a large test suite, a migration, a codemod — and success is checkable by tests, a build, or a greppable invariant. Also use when the user says "delegate this", "hand this to Codex", "offload this", or "run this on opencode". Do NOT use for work under ~3 files or ~100 lines, for anything needing mid-flight conversation, for design decisions, or for diagnosis and debugging handoffs — those go to /codex:rescue.
---

# Delegating implementation work

Hand token-heavy, low-judgment work to an external coding agent with its own context
window, so this session spends its context on judgment rather than bulk execution.

**The value is context conservation, not speed.** A 1,200-line mechanical refactor costs
most of a context window to write and re-read. Delegated, it costs a prompt and a summary.

## What this skill does not claim

**Git is a recovery mechanism, not a containment boundary.** It restores tracked files in
one repository. It cannot undo writes outside the repo, changes to gitignored files,
network calls, global installs, package-manager cache mutations, spawned background
processes, or edits to user configuration. `opencode --auto` bypasses *approval prompts*,
not the OS. `codex --sandbox workspace-write` is narrower but still permits temp-dir writes.

A skill is instructions to an agent, not a supervisor process — it cannot enforce an OS
sandbox or reliably manage a Windows process tree. So this skill **fails closed** wherever
it cannot guarantee safety. Never tell the user a run is contained or reversible beyond
what the Recovery section actually delivers.

## When to delegate

All of these must hold:

- The approach is already decided — the delegate executes, it does not choose.
- The work is bulk: many files receiving the same transformation, or one large
  well-specified artifact.
- Output is plausibly several hundred lines or more.
- Success is *mechanically checkable* — tests, a build, a type-check, a greppable invariant.

Do not delegate when any of these hold:

- Fewer than ~3 files or ~100 lines — handoff overhead exceeds the work.
- Each file needs a judgment call the prompt cannot pre-specify.
- Verification would require reading everything anyway.
- The task touches secrets, credentials, or CI/deploy configuration.

**The honest test:** if writing a prompt complete enough for the delegate takes as long as
doing the work, do the work.

**Not an orchestrator: one task, one delegate, one verification pass.** No fan-out. Not a
replacement for `/codex:rescue`, which handles diagnosis and "I'm stuck" handoffs.

## Prompt anatomy

The delegate has no conversation history. The prompt is the entire brief. A prompt missing
any of these five parts is a **pre-flight failure** — do not launch.

1. **Task** — what to build, specifically.
2. **Context** — repo root, relevant paths, and the *literal inlined contents* of the
   project's `AGENTS.md` / `CLAUDE.md`. Do not merely reference them by path; delegates
   read referenced files unreliably.
3. **Constraints** — invariants that must survive, each phrased so a `grep` can confirm it.
4. **Definition of done** — the exact pre-flight-anchored commands, quoted literally.
5. **Out of scope** — files and areas to leave alone, explicitly.

Write the prompt to `<run-dir>/prompt.md` and record its SHA-256. Pass it by **stdin**.
Never `"$(cat …)"` argv interpolation — that reintroduces the Windows quoting and
command-length failure the file was meant to avoid. On fallback, reuse the identical file
and verify the hash matches.

## Pre-flight gate

All seven are mandatory. Each names what stops the run.

1. **Inside a git repository.** No repo ⇒ stop. There is no checkpoint without one.
2. **Clean tree** — `git status --porcelain=v2 -z --untracked-files=all` must be empty.
   If dirty ⇒ **stop and offer to stash.** Never delegate on top of uncommitted work; a
   truncated run makes the two sets of changes indistinguishable.
3. **Not detached, not unborn HEAD** ⇒ either stops the run.
4. **Resolve the default branch** from `git symbolic-ref refs/remotes/origin/HEAD`.
   **If that resolution fails, stop** — do not guess `main`. If HEAD is the default branch,
   create a collision-safe `delegate/<slug>` branch first.
5. **Record the recovery manifest:** canonical repo root, symbolic ref, HEAD SHA,
   recursive submodule HEADs, and a SHA-256 inventory of protected ignored files.
6. **Anchor the verification commands now** — the manifest path, package manager, and the
   *literal text* of the script definitions, captured before the delegate can edit them.
7. **Claim the workspace.** Tell the user the tree is under delegation and must not be
   edited until it returns.

### Protected ignored files

`git clean -fd` preserves ignored files; `git clean -fdx` deletes them. Neither is right,
because gitignored does not mean disposable. Concretely on this machine: **`IDEAS.md` and
`TASKS.md` are globally gitignored and are the canonical local copies** — `-fdx` destroys
real work.

Hash-inventory `.env*`, `IDEAS.md`, `TASKS.md`, and local config before the run; verify
unchanged after. **Never run `git clean -fdx`.** Report drift as a verification failure.

## Adapter contract

Adapters implement four parts — `preflight`, `invoke`, `terminate`, `parse` — and contain
no routing. `parse` returns `{terminalState, failureClass, sessionId, model, usage,
finalMessage}`.

- `terminalState ∈ {completed, failed, truncated, unknown}`
- `failureClass ∈ {none, quota, auth, task, transport, unknown}`

Load `references/codex.md` when routing selects Codex, `references/opencode.md` for
opencode. A normal run loads one adapter; a fallback run loads both — that is expected.

Each adapter carries exactly one runnable `canonical-parse` block implementing the
precedence-ordered truth table. Its two backend-specific success predicates:

- **Codex:** exactly one *top-level* `turn.completed`, no `turn.failed`, exit 0.
- **opencode:** completed assistant message, final `step_finish` reason `stop`, no session
  error, no pending tool parts.

## Routing

1. **Codex first**, unless the user names a backend.
2. Fall back to opencode **only** when `failureClass == quota`.
3. `task`, `auth`, `transport` ⇒ stop and report. Never fall back on a task failure — that
   runs a broken prompt twice on a weaker model.
4. `unknown` ⇒ **STOP_AND_ASK**. Never auto-fall back.
5. At most one fallback per delegation.

### State transitions

| State | Permitted next |
|---|---|
| `completed` | VERIFY |
| `failed` + `quota` | FALLBACK, only if `fallback_used == false`; else STOP_AND_REPORT |
| `failed` + `auth`/`task`/`transport` | STOP_AND_REPORT |
| `truncated` | STOP_AND_REPORT (recovery offered) |
| `unknown` (any class) | **STOP_AND_ASK** |
| VERIFY fails | REPAIR once, else STOP_AND_REPORT |

No path proceeds silently. If a run's state is not in this table, treat it as `unknown`.

### Quota detection

Precision-biased: a false positive discards good work and re-runs on a weaker model; a
false negative merely withholds fallback and reports honestly.

- **Parse only the terminal failure object.** Never scan the whole stream or stderr — the
  delegate's own prose, a test asserting on HTTP 429, or a fixture containing
  `insufficient_quota` would all read as quota errors.
- Match **verified** signatures only. Unrecognized ⇒ `unknown` ⇒ stop and ask. Do not
  invent message text to make fallback fire.
- A quota error arriving **after file writes began** is suspicious ⇒ `unknown`.
- `codex doctor` is an auth pre-flight only. Auth failure is not quota: stop and tell the
  user to re-authenticate.

### Before falling back

1. Terminate the first backend's process tree.
2. **Confirm exit.** If exit cannot be confirmed ⇒ `unknown` ⇒ stop. Never reset while a
   delegate may still be writing.
3. **Re-run the full pre-flight safety audit** — not a partial re-check.
4. Reset to the checkpoint, so opencode starts from the same state Codex did rather than
   on top of Codex's partial edits.
5. Re-invoke with the **byte-identical** prompt, SHA-256 verified.

## Verification contract

**A delegate's report of success is evidence of nothing.** Prose is advisory; gating is
mechanical. Run all five. Any failure ⇒ the report does not claim success.

**1. Transport (mechanical).** Use the adapter's `canonical-parse` result.
- *Codex:* `item.completed` events carrying `item.type: "error"` are benign advisories
  (hook-timeout clamps, skill-description truncation) and appear on fully successful runs.
  **They are not failures.** Verified 2026-08-23 — a naive error-scan fails every run.
- *opencode:* exit status is authoritative in **neither** direction. Verified 2026-08-22
  that opencode exits 0 when a provider 503 truncates a run mid-task. Do not infer success
  from exit 0, nor failure from a missing final event; query the persisted session by id.

**2. Scope of change (mechanical).** `git diff --stat` alone is wrong — it misses staged
changes, commits, and untracked files, so a delegate that runs `git add` or commits
produces an empty diff and an invisible implementation. Verify HEAD and the symbolic ref
are unchanged, then review `git diff --no-ext-diff <checkpoint> --` plus explicit staged,
untracked, protected-ignored, and recursive-submodule inventories.

**3. Diff review (judgment).** Read it. Files the prompt forbade, secrets, debug
leftovers, deletions nobody asked for.

**4. Project checks (mechanical).** Run the commands **anchored at pre-flight**, never the
ones in the post-run manifest — otherwise a delegate that rewrites `"test"` to a no-op
passes its own verification. Any change to those script definitions is itself a
verification failure. Record each command and its actual result.

**5. Constraint audit (mechanical where possible).** Re-verify every stated invariant,
`grep -c` style.

### Repair

A repair cannot start from a dirty tree without contradicting the pre-flight gate. So after
transport and safety pass but verification finds a defect: commit the first pass as a
**candidate commit** on the delegate branch. That becomes the new checkpoint. **One** repair
attempt from there, then hand back to the user. Report both SHAs and state which one
recovery targets.

## Recovery

There is no universal one-command undo, and the report must never imply one. Generate
recovery only after a fresh audit:

1. Confirm no delegate process is alive.
2. Re-run `git status` and diff against the recorded manifest.
3. If anything changed the delegate cannot account for — **a concurrent user edit** — stop
   and show it. Never auto-reset over it.
4. Present a dry-run inventory of what recovery would discard, then wait for confirmation.

Recovery restores tracked files in the superproject. **Submodules, ignored files, and
out-of-repo writes are reported, not restored.**

## Execution lifecycle

Runs are long — a 2026-08-22 benchmark took 33 minutes. Launch in the background,
capturing the PID/handle, run directory, and start time. Use a **unique per-run scratch
directory**. Enforce a wall-clock cap and an inactivity cap measured by output-file mtime.
Bound output size. Define cancellation as: terminate tree, confirm exit, then treat as
`unknown` if unconfirmed. Treat JSONL and stderr as **sensitive** — they contain source and
command output — and delete them on success, retaining only on failure for the report.

## Report

```
Backend:      <backend> (<actual model>)   [+ "after Codex quota exhaustion" if fallback]
Checkpoint:   <sha> on <ref>               (evidence — recovery steps generated on request, after audit)
Duration:     <wall clock>    Tokens: <in/out/reasoning>
Changed:      <files; tracked / staged / untracked / submodules>
Verification: transport <r> · scope <r> · diff <r> · checks <cmd → actual result> · constraints <r>
Protected:    <ignored-file inventory: unchanged / DRIFT>
Flagged:      <what the delegate skipped, assumed, or left undone>
```

Backend first: after an automatic fallback, which model touched the code is the most
surprising fact. The checkpoint is **evidence, not a copy-pasteable undo** — printing
`git reset --hard` invites the user to run it after doing their own work on top.

## Residual risk — accepted, not solved

1. **No OS containment.** Out-of-repo writes, network calls, and global installs are
   narrowed by `--dir`/`-C` and denial settings, not prevented.
2. **No enforced process-tree control.** Mitigated by confirming exit before reset and
   refusing to auto-reset when state is unexplained.
3. **Concurrent user edits.** Mitigated by claiming the workspace and refusing to
   auto-reset over unexplained changes — not prevented.
4. **Quota misclassification.** Biased to false negatives; a residual false positive costs
   one wasted run.

If any of these is unacceptable for a given task, the right answer is a worktree or not
delegating — not trusting this skill harder than it deserves.
