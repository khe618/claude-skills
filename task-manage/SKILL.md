---
name: task-manage
description: Curate a project's task queue (the factory checkout's queues/<project>.md for factory-managed projects, else a project-local TASKS.md) into an ordered queue of self-contained, agent-ready tasks. Use when the user asks to create, update, prune, prioritize, or manage TASKS.md or the factory queue; asks to turn IDEAS.md/ideas/<project>.md, recent session logs, or git history into actionable tasks; or wants in-progress tasks removed after they have merged into master/main.
---

# Task Manage

## Overview

Maintain a project's task queue as a concise ordered list of tasks another agent
can pick up without extra back-and-forth. Promote only straightforward work with
limited design space; leave vague, strategic, or highly exploratory ideas in
`ideas/<project>.md` (or `IDEAS.md` for non-factory projects).

**For factory-managed projects (present in `C:\dev\factory\config\factory.json`),
this skill operates on the factory checkout, not a local file:**
`C:\dev\factory\queues\<project>.md` (the queue), `proposals/<project>.md`
(human-gated proposals), and `ideas/<project>.md` (curation source material) —
all in the `C:\dev\factory` checkout (repo `khe618/factory`). Always
`git -C /c/dev/factory pull` before reading state and `git -C /c/dev/factory
push` after writing it. For any other project, this skill falls back to the
legacy local `TASKS.md`/`IDEAS.md` behavior described below.

This skill is the **producer** for the task queue. The **consumer** is the
`implement-task` skill, which executes an item and updates its status. Both
follow one shared format — read it before editing the file:

**Read `references/tasks-md-contract.md`** (in this skill) for the exact
queue format, the state model (`[open]` / `[in progress]`, plus `[blocked]` on
the canonical factory queue), the field rules, the immutable-ID allocation
rule, and the status transitions. Everything below is the *curation* workflow;
the contract is the *format*.

## Workflow

1. Locate the target project. If it's factory-managed, that means the factory
   checkout (`git -C /c/dev/factory pull` first) — read `config/factory.json`
   for its `prefix`, `attemptCap`, and `minOpenTasks`. Otherwise locate the
   project root and read its instructions (`CLAUDE.md` / `AGENTS.md`) before
   editing; `TASKS.md` belongs at the project root, not the workspace root.
2. Inspect current state:
   - Factory-managed: `queues/<project>.md`, `proposals/<project>.md`,
     `ideas/<project>.md`, and recent `ledger/events/*.json` for this project.
   - Non-factory: existing `TASKS.md` and `IDEAS.md`, if present.
   - Recent session evidence available in context or local files — agent logs,
     `LEARNINGS.md`, durable memories, project notes, recent session summaries.
   - Git status and recent history, when the project is a git repository.
3. Determine whether any `[in progress]` tasks have merged into `master` or
   `main`.
   - Compare the task branch, commit subjects, PR references, or files mentioned
     by the task against the default branch history.
   - If the evidence shows the work landed on `master`/`main`, **remove** the
     task (the contract uses removal, not a "done" state). Factory-managed:
     removal also writes a `pruned` ledger event file (schema + filename per
     the contract) recording the task ID and PR.
   - If evidence is unclear, keep the task and add/update its `Evidence` note
     rather than guessing.
4. Promote ideas into the queue only when they are agent-ready:
   - The desired outcome is concrete.
   - The scope is small to medium.
   - The agent can verify completion locally.
   - The task does not require major product/design decisions or repeated user
     input.
   - Factory-managed: assign the new task's ID by the contract's allocation
     rule — 1 + the max numeric suffix for this project's prefix found across
     `queues/*.md`, `proposals/*.md`, AND every `ledger/events/**/*.json`
     (including archives). Never reuse an ID, even one belonging to a pruned
     task.
5. Reorder tasks by practical execution value (list order = priority):
   - Unblockers and correctness fixes first.
   - Small, well-specified improvements next.
   - Larger but still well-contained tasks after that.
   - Keep noisy, speculative, or low-confidence items out of the list.
6. **Adversarial self-review of the proposed changes** — before writing, turn a
   skeptical eye on your own removals and promotions. See "Adversarial
   self-review" below. This is the gate that matters most when this skill runs
   autonomously, because there is no human checking the result.
7. Write or update the queue following the contract format exactly. Whenever tasks are added, removed, or reordered, renumber headers strictly 1..N; never change a task's ID. Before
   writing, verify every task carries a non-empty `Objective:` line stating the
   concrete change — it's the one required field and the line the review digest
   surfaces. If you can't articulate the objective, the item isn't agent-ready;
   leave it in `ideas/<project>.md`/`IDEAS.md` rather than promoting a task with
   an empty objective.
8. **Factory-managed only — commit and push.** One commit covering every
   queue/proposals/ideas edit made this run, plus one `pruned` ledger event
   file per task removed this run (filename
   `<YYYYMMDDTHHMMSSZ>-<6-char [a-z0-9]>-pruned.json`, schema per the ledger
   contract, spec §4.3, with `actor: "local:<project>"`). Commit message: `state: curate <project> (promote N,
   remove M, reorder)` (omit clauses that don't apply). Push with the
   discard-and-rebuild rule (spec §4.4): if the push is rejected, `git -C
   /c/dev/factory fetch && git -C /c/dev/factory reset --hard origin/main`,
   re-read the current state, rebuild the edit fresh (never rebase-replay the
   old commit), and retry. On repeated contention, stop and tell the user
   rather than looping indefinitely.

## Git guidance

When inside a git repository, gather evidence with focused commands:

```bash
git status --short --branch
git branch --show-current
git log --oneline --decorate --max-count=20
git log --oneline master..HEAD
git log --oneline main..HEAD
```

Use `master` or `main` according to the repository. If neither exists locally,
inspect branches/remotes before concluding a task has merged. Never remove an
`[in progress]` task solely because the working tree is clean; require evidence
that the relevant work is now on the default branch.

For factory-managed projects, also pull the factory checkout before reading
and cross-check against recent ledger events for this project:

```bash
git -C /c/dev/factory pull
ls /c/dev/factory/ledger/events | tail -20
```

## Adversarial self-review

This skill often runs without a human reviewing its output, so the curation
*itself* is the thing that needs an adversarial pass — there is no later gate to
catch a bad call. The three curation actions are not equally risky, so concentrate
scrutiny where a mistake is expensive:

- **Removal is the dangerous one.** The contract has no "done" state; a finished
  task is *deleted*. So a wrong removal silently loses tracked work with nothing
  to recover it from. Before removing any `[in progress]` task, argue the
  opposite case and require it to survive:
  - Name the concrete merge evidence — the commit(s) or merged PR that carry the
    work onto `main`/`master`. "Working tree is clean" is not evidence.
  - Rule out the look-alikes: a same-named branch, a PR that was *closed* rather
    than merged, or a partial landing where only some of the task's scope merged.
  - If you cannot prove the *full* scope merged to the default branch, do **not**
    remove it — keep the task and update its `Evidence` line instead.
- **Promotion compounds.** The consumer (`implement-task`) also runs
  autonomously, so an under-specified task isn't caught by a human either — it
  becomes a confident, wrong PR. Before promoting, pressure-test readiness:
  - Is the task genuinely self-contained, or am I leaning on conversation
    context the next agent won't have?
  - Is there a `Done when` an agent can actually check locally?
  - Does it still need a product/design/architecture decision? If so it belongs
    in `ideas/<project>.md`/`IDEAS.md`, not the task queue.
- **Reordering is cheap** — a wrong priority is fixed on the next run, so it
  doesn't need this scrutiny.

**Escalation.** When running autonomously *and* about to remove a task, hand that
specific judgment to an independent reviewer rather than trusting your own read:
run the removal evidence through **`codex:rescue`** (the same review engine
`implement-task` uses, so reviews stay consistent), falling back to an independent
Claude subagent if Codex is unavailable. Ask it the narrow question "does this
evidence prove the full task merged to the default branch?" Promotions and
reordering do not need the round-trip — the self-review above is enough.

## Curation rules

- Prefer fewer, clearer tasks over a large backlog.
- Preserve useful context from `ideas/<project>.md`/`IDEAS.md` but rewrite it
  into an executable task.
- Do not promote ideas that require choosing among many product directions,
  visual concepts, vendors, architectures, or policy decisions.
- Split compound ideas into separate tasks only when each split task is
  independently useful and verifiable.
- If the queue file does not exist, create it per the contract (a short
  ordered list of the best available tasks, or a one-line note if no
  agent-ready tasks were found).
- Factory-managed: never promote directly from `ideas/<project>.md` into
  `queues/<project>.md` when acting as the curator role — draft into
  `proposals/<project>.md` with a `[proposed]` state and a `Rationale:` line
  instead, and leave promotion to the human's `[proposed]` → `[approved]`
  edit (spec §4.2). This skill may still promote straight to `[open]` in the
  queue when the user directly asks it to add/curate a specific task in this
  conversation — the proposals gate is for the unattended curator flow, not
  every invocation.
