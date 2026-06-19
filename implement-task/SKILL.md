---
name: implement-task
description: Autonomously implement a repository task from TASKS.md using the Superpowers workflow. Use when the user asks to implement a task, pick up the next TASKS.md item, run an implementation workflow from a task queue, or carry a task through worktree, subagents, review, verification, and a pull request.
---

# Implement Task

## Purpose

Take a task from `TASKS.md` through implementation, review, verification, and PR
creation with minimal user interruption.

This skill is the **consumer** of `TASKS.md`; the `task-manage` skill is the
producer that curates it. **Read the shared contract first** —
`~/.claude/skills/task-manage/references/tasks-md-contract.md` — for the
`TASKS.md` format and the two-state model (`[open]` / `[in progress]`), so status
edits stay consistent with what `task-manage` expects.

Default to autonomous execution. When a normal Superpowers workflow would ask the
user to choose between reasonable high-level options, make the best decision from
repo context, record the decision and uncertainty, and surface it in the PR
summary.

## Relationship to the documented workflow

This skill **defers to the user's global "Superpowers workflow preferences"**
(in `~/.claude/CLAUDE.md`). The key reconciliation: in that flow the **spec is
the only review gate**, and here the **curated `TASKS.md` task is the
spec-equivalent** — it was already reviewed and approved when `task-manage`
promoted it. So implement-task runs autonomously from an approved task: it does
not reopen a spec-approval gate, and per the documented preference it moves
straight into execution without pausing for plan-level approval.

Adversarial review uses **`codex:rescue`** (the user's documented review engine)
at the plan and final-diff gates, matching how specs/plans are reviewed
elsewhere. If Codex is unavailable, fall back to an independent Claude subagent
for the same review.

## Workflow

1. **Orient in the repository**
   - Confirm the current directory is the intended project repository, not a
     parent workspace.
   - Read project instructions first: `CLAUDE.md` / `AGENTS.md`, `README.md`,
     package manifests, `LEARNINGS.md`, and the relevant portion of `TASKS.md`.
   - Identify the target task. If the user did not specify one, choose the
     highest-priority `[open]` task (list order = priority per the contract).
   - Inspect git state. Do not overwrite unrelated user changes.

2. **Mark the task in progress on `main` or `master`**
   - Determine the primary branch: prefer `main`, fall back to `master`.
   - Checkout the primary branch and update it from the remote when safe and
     available.
   - Edit only the selected entry in `TASKS.md`: flip `[open] → [in progress]`
     per the contract (the smallest compatible edit; no invented states), and
     record the working branch in its `Evidence` line.
   - Commit the `TASKS.md` status update on the primary branch when the
     repository workflow permits direct primary-branch commits, with a narrow
     message such as `Mark task in progress`. If direct commits are
     inappropriate, leave the status update in the working tree and continue.

3. **Create an implementation worktree**
   - Use the `superpowers:using-git-worktrees` skill.
   - Create a new branch from the updated primary branch in a separate worktree,
     named for the task, e.g. `task/<short-slug>`.
   - Do all implementation work in the worktree. Keep the primary checkout
     reserved for the task-status update.

4. **Resolve task ambiguities**
   - Treat the curated task as the approved spec. Identify ambiguities, likely
     edge cases, constraints, and acceptance criteria from the task text +
     repo context.
   - Do not ask the user to resolve ambiguities unless continuing would risk
     destructive work, data loss, credential exposure, or production impact.
   - Convert unresolved questions into explicit assumptions and decision notes.

5. **Write the plan and review it**
   - Use the `superpowers:writing-plans` skill. The plan includes assumptions,
     affected files, verification steps, and any design choices made without
     user input.
   - Run the plan through **`codex:rescue`** for adversarial review (missing
     steps, risky assumptions, overreach, test gaps). Incorporate valid feedback.
   - Per the documented preferences, do **not** stop for user plan approval —
     move straight into execution.

6. **Implement with subagent-driven development**
   - Use the `superpowers:subagent-driven-development` skill. Split the plan into
     independent subtasks and dispatch subagents (the Agent tool); keep one
     coordination thread responsible for integration, consistency, and final
     judgment. See `superpowers:dispatching-parallel-agents` when work fans out.
   - Follow repository conventions and existing architecture. Prefer focused
     edits over broad refactors.
   - For bugs or unexpected failures, use `superpowers:systematic-debugging`
     before changing direction.
   - For tests, use judgment: apply `superpowers:test-driven-development` when the
     task is behaviorally risky or the repo expects it; for small low-risk copy,
     styling, or asset swaps, make the focused edit and verify afterward.

7. **Verify before review**
   - Use the `superpowers:verification-before-completion` skill. Run the most
     relevant checks from the project manifests/docs — targeted tests first, then
     broader checks for shared or user-facing impact.
   - For any non-trivial UI change, drive the app end-to-end (the `run` / `verify`
     skills) and confirm the change behaves as intended — type checks are not a
     substitute.
   - **Capture a review screenshot for the mobile digest (best-effort, never
     blocks the task):** after verifying a non-trivial **UI** change, with the app
     on the screen that shows the new behavior, take a screenshot (or a short GIF
     via the claude-in-chrome gif tool) to a temp file (e.g. `./.review-shot.png`),
     write a one-paragraph plain-language "what changed for the user" to
     `./.review-summary.md`, then run (swallow any error — do **not** fail the task):
     `node ~/.claude/skills/mobile-review-digest/scripts/save-capture-cli.mjs <owner/repo> <branch> ./.review-shot.png ./.review-summary.md`
     where `<owner/repo>` is the PR's repo slug and `<branch>` is the current head
     branch. Skip entirely for logic-only changes (no screen to show). This is what
     makes the PR show up with a real screenshot in the `mobile-review-digest` skill.
   - If a check cannot be run, record the exact reason and what was verified
     instead.

8. **Final implementation review**
   - Run the final diff through **`codex:rescue`** against the task and
     acceptance criteria, focusing on bugs, regressions, missing tests, and
     unclear design choices. (Fall back to an independent Claude subagent if
     Codex is unavailable.)
   - Incorporate valid feedback; if rejecting feedback, record the reason. Treat
     review as advisory — do not make churn-only changes.
   - Re-run affected verification after any changes from this review.

9. **Prepare and create the PR**
   - Ensure the worktree branch contains only intended changes. Commit with a
     task-focused message.
   - Push the branch and open the PR with the `pr` skill (`gh` under the hood).
   - In the PR description include: the task from `TASKS.md`; what was
     implemented; verification performed and results; key design choices; any
     high-level decisions made without user input (especially uncertain ones with
     reasonable alternatives); and follow-ups or known limitations.

10. **Update task status after PR creation**
    - Keep the task `[in progress]` and append the PR link to its `Evidence`
      line per the contract — do **not** invent an "in review" state. The task is
      removed by `task-manage` once the work merges to the default branch.
    - Make this update according to the repository's normal workflow: if it
      belongs on the implementation branch, include it in the PR; if status is
      tracked only on the primary branch, commit it there after the PR exists.

11. **Capture deferred ideas**
    - Per the global preferences, run the `idea-capture` check after a larger
      feature so any "we could also… / later" items land in `IDEAS.md`.

## Autonomy rules

- Make reasonable product, architecture, and UX decisions from repository context
  instead of asking the user.
- Pause for user input only when a decision would be destructive,
  security-sensitive, irreversible, dependent on private credentials, or likely
  to affect production systems.
- Keep an assumption log while working. Use it in the plan, review prompts,
  commit/PR notes, and the final response.
- Do not leave work half-integrated. Carry the task through PR creation unless
  blocked by permissions, authentication, missing tools, or failing checks that
  require user action.
