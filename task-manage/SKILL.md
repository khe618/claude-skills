---
name: task-manage
description: Curate a project-local TASKS.md into an ordered queue of self-contained, agent-ready tasks. Use when the user asks to create, update, prune, prioritize, or manage TASKS.md; asks to turn IDEAS.md, recent session logs, or git history into actionable tasks; or wants in-progress tasks removed after they have merged into master/main.
---

# Task Manage

## Overview

Maintain a project's `TASKS.md` as a concise ordered list of tasks another agent
can pick up without extra back-and-forth. Promote only straightforward work with
limited design space; leave vague, strategic, or highly exploratory ideas in
`IDEAS.md`.

This skill is the **producer** for `TASKS.md`. The **consumer** is the
`implement-task` skill, which executes an item and updates its status. Both
follow one shared format — read it before editing the file:

**Read `references/tasks-md-contract.md`** (in this skill) for the exact
`TASKS.md` format, the two-state model (`[open]` / `[in progress]`), the field
rules, and the status transitions. Everything below is the *curation* workflow;
the contract is the *format*.

## Workflow

1. Locate the target project and read its instructions (`CLAUDE.md` /
   `AGENTS.md`) before editing. `TASKS.md` belongs at the project root, not the
   workspace root.
2. Inspect current state:
   - Existing `TASKS.md`, if present.
   - `IDEAS.md`, if present.
   - Recent session evidence available in context or local files — agent logs,
     `LEARNINGS.md`, durable memories, project notes, recent session summaries.
   - Git status and recent history, when the project is a git repository.
3. Determine whether any `[in progress]` tasks have merged into `master` or
   `main`.
   - Compare the task branch, commit subjects, PR references, or files mentioned
     by the task against the default branch history.
   - If the evidence shows the work landed on `master`/`main`, **remove** the
     task (the contract uses removal, not a "done" state).
   - If evidence is unclear, keep the task and add/update its `Evidence` note
     rather than guessing.
4. Promote ideas into `TASKS.md` only when they are agent-ready:
   - The desired outcome is concrete.
   - The scope is small to medium.
   - The agent can verify completion locally.
   - The task does not require major product/design decisions or repeated user
     input.
5. Reorder tasks by practical execution value (list order = priority):
   - Unblockers and correctness fixes first.
   - Small, well-specified improvements next.
   - Larger but still well-contained tasks after that.
   - Keep noisy, speculative, or low-confidence items out of the list.
6. **Adversarial self-review of the proposed changes** — before writing, turn a
   skeptical eye on your own removals and promotions. See "Adversarial
   self-review" below. This is the gate that matters most when this skill runs
   autonomously, because there is no human checking the result.
7. Write or update `TASKS.md` following the contract format exactly.

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
    in `IDEAS.md`, not `TASKS.md`.
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
- Preserve useful context from `IDEAS.md` but rewrite it into an executable task.
- Do not promote ideas that require choosing among many product directions,
  visual concepts, vendors, architectures, or policy decisions.
- Split compound ideas into separate tasks only when each split task is
  independently useful and verifiable.
- If `TASKS.md` does not exist, create it per the contract (a short ordered list
  of the best available tasks, or a one-line note if no agent-ready tasks were
  found).
