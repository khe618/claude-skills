# TASKS.md contract

The shared format for a project-local `TASKS.md`. Both the producer
(`task-manage`, which curates the file) and the consumer (`implement-task`,
which executes items and updates their status) follow this contract, so the file
stays consistent no matter which skill touched it last. This contract is
runtime-agnostic — it describes the file, not Claude or Codex.

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

## State model — exactly two states

Each task is either:

- **`[open]`** — not started; available to pick up.
- **`[in progress]`** — actively being worked, or landed on a branch/PR but not
  yet merged to the default branch.

Do **not** invent other states (`[done]`, `[blocked]`, `[in review]`, etc.) and
do **not** use unchecked task-list checkboxes (`[ ]`) as the primary state
marker. A finished task is not represented by a "done" state — it is **removed**
(see transitions). PR/review status is recorded in the task's `Evidence` line,
not as a new state.

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

## Status transitions (who changes what)

- **Promote** (`task-manage`): a qualifying `IDEAS.md` item / log / git finding
  becomes a new `[open]` task in priority order.
- **Start** (`implement-task`): flip the selected task `[open] → [in progress]`
  in the smallest edit, preserving the format. Record the working branch in
  `Evidence`.
- **PR opened** (`implement-task`): keep the task `[in progress]` and append the
  PR link to `Evidence`. Do not introduce an "in review" state.
- **Remove** (`task-manage`): once the work has merged to `main`/`master`
  (verified against default-branch history, not just a clean working tree),
  delete the task entirely. If merge evidence is unclear, keep the task and
  update its `Evidence` note instead of guessing.

## When the file doesn't exist yet

Create it with the `# Tasks` heading and a short ordered list of the best
available agent-ready tasks. If there is no reliable evidence for any task,
create it with `# Tasks` and a one-line note that no agent-ready tasks were
found.
