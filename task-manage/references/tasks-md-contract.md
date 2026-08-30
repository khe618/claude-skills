# TASKS.md contract

The shared format for a project-local `TASKS.md`. Both the producer
(`task-manage`, which curates the file) and the consumer (`implement-task`,
which executes items and updates their status) follow this contract, so the file
stays consistent no matter which skill touched it last. This contract is
runtime-agnostic — it describes the file, not Claude or Codex.

**The canonical queue for factory-managed projects is
`C:\dev\factory\queues\<project>.md` (repo khe618/factory); per-project
`TASKS.md` files are legacy stubs.** The extensions below (immutable IDs,
`[blocked]`, `Attempts:` + lease semantics) apply to that canonical queue.

## Purpose and location

`TASKS.md` lives at the **root of a single project** (next to its manifest), not
at the workspace root. It is a concise, ordered queue of self-contained tasks
another agent can pick up and finish without extra back-and-forth. It is the
*actionable* sibling of `IDEAS.md`: vague, strategic, or exploratory items stay
in `IDEAS.md`; only agent-ready work is promoted into `TASKS.md`.

## Structure

One top-level **ordered** Markdown list under a `# Tasks` heading. List order is
meaningful — it is the execution priority (highest-value first). Each item has
exactly one state marker and a fixed set of sub-fields.

```markdown
# Tasks

1. [open] Short imperative task title
   - Context: What exists now and why this task matters.
   - Objective: The concrete change to make.
   - Scope: Files, areas, or constraints the agent should respect.
   - Evidence: Source of the task — IDEAS.md, recent logs, or git history.
   - Done when: Local checks or observable behavior proving completion.

2. [in progress] Short imperative task title
   - Context: What was started and the current known state.
   - Objective: The concrete change still needed.
   - Scope: Files, areas, or constraints the agent should respect.
   - Evidence: Branch, commits, PR link, session notes, or files showing progress.
   - Done when: Local checks or the merge condition proving completion.
```

## State model — base two states, extended to three on the canonical queue

Base contract, each task is either:

- **`[open]`** — not started; available to pick up.
- **`[in progress]`** — actively being worked, or landed on a branch/PR but not
  yet merged to the default branch.

Do **not** invent other states (`[done]`, `[in review]`, etc.) and do **not**
use unchecked task-list checkboxes (`[ ]`) as the primary state marker. A
finished task is not represented by a "done" state — it is **removed** (see
transitions). PR/review status is recorded in the task's `Evidence` line, not
as a new state.

### Factory extension (spec §4.1): the `[blocked]` state

On the canonical factory queue (`C:\dev\factory\queues\<project>.md`), the
state model gains a third state alongside `[open]` and `[in progress]`:

- **`[blocked]`.** A blocked task MUST carry a `Blocked:` field: one line with
  the date, the reason, and the specific human action needed (e.g. `Blocked:
  2026-09-02 — needs SUPABASE_SERVICE_KEY in cloud env credentials; add at
  claude.ai settings, then flip to [open]`). Workers skip `[blocked]` tasks.
  Only a human (or a human-instructed session) flips a task back to `[open]`.

### Factory extension (spec §4.1): immutable task IDs

Every task on the canonical queue gets a permanent project-scoped ID at
creation (`tp-014`, `ta-003`), rendered in the title line:
`3. [open] tp-014 — Add firm comparison table`. The header line must match
`^(\d+)\.\s*\[(open|in progress|blocked)\]\s+([a-z]{2,3}-\d{3})\s+—\s+(.+)$`
(note the em dash, U+2014, between the ID and the title — a plain hyphen
fails validation). The ID never changes across reorders or retitles and is
used in branch names (`claude/tp-014-<slug>`), ledger events, and PR
titles/bodies — it is the join key for all reconciliation.

**ID allocation rule.** IDs are assigned by whoever creates the task (curator,
`task-manage`, or a human) as **1 + the maximum numeric suffix for that
project's prefix found across `queues/*.md`, `proposals/*.md`, AND every
`ledger/events/**/*.json` (including archives)** — not just the current
queue file. Never reuse an ID, even one belonging to a task that was later
pruned/removed: IDs are permanent join keys, and a naive "max existing in the
queue" scan would reuse an ID that a `pruned`/`blocked`/other ledger event
still references. Scan the ledger before assigning.

### Factory extension (spec §4.1): `Attempts:` and the terminal transition

New optional field **`Attempts:`** — a count plus one-line notes per failed
attempt. **A failed attempt is a terminal transition, applied atomically in
the worker's final state commit:** increment `Attempts`, then flip the task
**back to `[open]`** if under the per-project `attemptCap` (config default
**2**), or to `[blocked]` (with the accumulated notes) at the cap. A task
never exits a run still `[in progress]` without a live PR in `Evidence`.

**Claims carry a lease.** Claiming writes `Evidence: claimed <ISO ts> by <run
id>`. A task `[in progress]` with **no PR link** whose claim is older than
**24h** is stale: any worker's or curator's reconcile pass reopens it — flip
to `[open]`, count one failed attempt, log the event. The lease plus attempt
cap means a dead run costs at most one attempt, and a zombie run resuming
late will fail its next state push (the claim it rebased on is gone) and
must abandon.

**`Done when` is write-protected from workers.** The worker may never edit a
task's `Done when` (or weaken `Objective`/`Scope`). If the criteria are
wrong, that is a blocked-with-reason outcome, not an edit. Curator and
humans may edit criteria.

## Field rules

- **`Objective` is required and must be non-empty on every task.** It states the
  concrete change to make and is the one field the review digest surfaces, so a
  task without a real objective is not agent-ready — leave such an item in
  `IDEAS.md` rather than promoting it. The other four fields (`Context`, `Scope`,
  `Evidence`, `Done when`) should also be present. Keep each task
  **self-contained** — never write "do the above" or "same as the previous task."
- `Evidence` is the audit trail: where the task came from and, once work starts,
  the branch / commit / PR that carries it. The consumer updates `Evidence`
  rather than adding a new state.
- On the canonical queue: `Blocked:` is required when `state` is `[blocked]`;
  `Attempts:` is optional and only present once a failed attempt has been
  recorded.

## Status transitions (who changes what)

- **Promote** (`task-manage`): a qualifying `IDEAS.md`/`ideas/<project>.md`
  item / log / git finding becomes a new `[open]` task in priority order,
  with a freshly allocated ID (see the allocation rule above).
- **Start / claim** (`implement-task`): flip the selected task
  `[open] → [in progress]` in the smallest edit, preserving the format.
  Record the lease (`claimed <ISO ts> by <run id>`) in `Evidence`. On the
  canonical queue this follows the claim protocol (spec §4.4) — see
  `implement-task/SKILL.md`.
- **PR opened** (`implement-task`): keep the task `[in progress]` and append the
  PR link to `Evidence`. Do not introduce an "in review" state.
- **Failed attempt** (`implement-task`, canonical queue only): the terminal
  transition above — increment `Attempts`, flip to `[open]` (under cap) or
  `[blocked]` (at cap).
- **Blocked** (`implement-task`, canonical queue only): flip to `[blocked]`
  with a precise `Blocked:` line when a genuine blocker is hit (missing
  credential, ambiguity that materially forks the design, or the attempt
  cap).
- **Reopen a stale lease** (any worker's or curator's reconcile pass,
  canonical queue only): a `[in progress]` task with no PR link whose claim
  is >24h old flips back to `[open]`, counts one failed attempt, and logs
  the event.
- **Remove** (`task-manage`): once the work has merged to `main`/`master`
  (verified against default-branch history, not just a clean working tree),
  delete the task entirely. If merge evidence is unclear, keep the task and
  update its `Evidence` note instead of guessing. On the canonical queue this
  also writes a `pruned` ledger event.

## When the file doesn't exist yet

Create it with the `# Tasks` heading and a short ordered list of the best
available agent-ready tasks. If there is no reliable evidence for any task,
create it with `# Tasks` and a one-line note that no agent-ready tasks were
found.
