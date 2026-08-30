---
name: implement-task
description: Autonomously implement a repository task from the factory queue (queues/<project>.md in C:\dev\factory, for factory-managed projects) or a local TASKS.md, using the Superpowers workflow. Use when the user asks to implement a task, pick up the next queued item, run an implementation workflow from a task queue, or carry a task through claim, worktree, subagents, review, verification, and a pull request. This is the local twin of the future cloud worker (spec §4.4/§5.1) — every exit path (success, failure, blocked, abandoned) must leave the queue in a terminal, non-`[in progress]`-without-a-claim state.
---

# Implement Task

## Purpose

Take a task from the queue through implementation, review, verification, and PR
creation with minimal user interruption.

This skill is the **consumer** of the task queue; the `task-manage` skill is the
producer that curates it. **Read the shared contract first** —
`~/.claude/skills/task-manage/references/tasks-md-contract.md` — for the queue
format and the state model (`[open]` / `[in progress]`, plus `[blocked]` and
`Attempts:` on the canonical factory queue), so status edits stay consistent
with what `task-manage` expects.

**Factory-managed projects** (present in `C:\dev\factory\config\factory.json`)
use the canonical queue `C:\dev\factory\queues\<project>.md` and the claim
protocol below (spec §4.4) — this is the default path and the one the "Exit
paths" section covers in full. **Non-factory projects** fall back to the
legacy behavior: edit the project-local `TASKS.md` directly, no commit, no
ledger events (see the inline notes marked *legacy* below).

Default to autonomous execution. When a normal Superpowers workflow would ask the
user to choose between reasonable high-level options, make the best decision from
repo context, record the decision and uncertainty, and surface it in the PR
summary.

## Relationship to the documented workflow

This skill **defers to the user's global "Superpowers workflow preferences"**
(in `~/.claude/CLAUDE.md`). The key reconciliation: in that flow the **spec is
the only review gate**, and here the **curated queued task is the
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
     package manifests, `LEARNINGS.md`.
   - Check `C:\dev\factory\config\factory.json` for this project's entry.
     Present → factory-managed: read the queue at
     `C:\dev\factory\queues\<project>.md` (after a `git -C /c/dev/factory
     pull`), plus `attemptCap`, `verify` commands, and the repo slug (read
     it from config — **don't assume dir name == GitHub slug**; e.g.
     `travel_app`'s repo is `khe618/travel_blog`). Absent → legacy: read the
     project-local `TASKS.md`.
   - Identify the target task. If the user did not specify one, choose the
     highest-priority `[open]` task (list order = priority per the contract).
     Skip `[blocked]` tasks.
   - Inspect git state. Do not overwrite unrelated user changes.

2. **Start / claim the task (factory claim protocol, spec §4.4)**

   *Factory-managed:*
   - Generate a run id once for this run: `local:<6-char [a-z0-9] session-short-id>`
     (reuse the same 6-char suffix in the ledger event filename this run
     writes). Record the claim timestamp in ISO 8601 UTC (`date -u
     +%Y-%m-%dT%H:%M:%SZ`). **`actor` is `local:<project>` — stable per
     project, never a per-session/per-run value** (the dashboard groups its
     routines/health map by `actor`, so a unique actor per run would fragment
     that view). `run` stays the unique-per-run id above; don't conflate the
     two.
   - `git -C /c/dev/factory pull`.
   - Build **one commit** containing exactly two changes: (a) the queue flip
     `[open] → [in progress]` for the chosen task, then append the lease to the existing `- Evidence:` line as `claimed <ISO ts> by local:<session-short-id>` (separated by `; `) — never add a second `- Evidence:` bullet; the parser keeps only the last one. (b) Add
     a new ledger event file
     `ledger/events/<YYYYMMDDTHHMMSSZ>-<6-char [a-z0-9]>-claimed.json`
     (schema per spec §4.3: `v:1`, `ts`, `actor: "local:<project>"`,
     `run: "local:<session-short-id>"`, `event: "claimed"`, `project`,
     `task: "<id>"`).
   - `git -C /c/dev/factory push`.
   - **On rejection:** discard the claim commit entirely — `git -C
     /c/dev/factory fetch && git -C /c/dev/factory reset --hard
     origin/main`. **Never rebase-replay it** (a stale claim rebased on top
     of someone else's edit can silently claim a task that just changed, or
     leave two claimed tasks). Re-read the queue at the new head, re-pick
     (the same task if still `[open]`, else the next `[open]` task), build a
     **fresh** claim commit, push again. Bounded at **3 tries**; on the 3rd
     failure, log nothing further, stop, and tell the user ("claim
     contention on `<project>` after 3 tries — try again shortly").
   - **After a successful claim push, verify exactly one task in the queue
     carries this run's lease** (`grep` the queue for the session-short-id).
     Only then does implementation begin. If verification fails (e.g. two
     tasks show the lease, or none do), stop and tell the user rather than
     proceeding on an unverified claim.

   *Legacy (non-factory):* determine the primary branch (prefer `main`,
   fall back to `master`), checkout and update it from the remote when safe.
   Edit only the selected entry in `TASKS.md`: flip `[open] → [in progress]`
   per the contract (the smallest compatible edit), and record the working
   branch in its `Evidence` line. Do **not** commit or push this update —
   `TASKS.md` is gitignored machine-wide (`~/.gitignore_global`), untracked
   in every repo, and the local file in the primary checkout IS the source
   of truth; edit it in place and move on.

3. **Create an implementation worktree**
   - Use the `superpowers:using-git-worktrees` skill.
   - Create a new branch from the updated primary branch in a separate
     worktree, named `claude/<task-id>-<slug>` (e.g. `claude/tp-014-firm-
     comparison-table`) for a factory-managed task, or `task/<short-slug>`
     for a legacy task with no ID.
   - Known traps (details in `~/.claude/agent-logs/`):
     - The native `EnterWorktree` tool fails `EEXIST mkdir '.claude/worktrees'`
       whenever that dir already exists (i.e. on the 2nd+ worktree in a repo).
       Don't retry — fall back to `git worktree add <path> -b <branch> <base>`
       (use the project's convention or a sibling `<repo>-worktrees/` dir),
       then use absolute paths / `git -C <worktree>` for follow-up commands.
     - A fresh worktree has no `node_modules`. Seed it by cd'ing in and running
       plain `npm install` — never `npm install --prefix <dir>`, which silently
       injects a bogus self-referential `file:` dependency into `package.json`.
       For read-only tooling (lint/tests) a junction to the primary checkout's
       node_modules works
       (`cmd //c "mklink /J node_modules ..\\..\\<primary>\\node_modules"` from
       inside the worktree), but remove it with `cmd //c "rmdir node_modules"`
       BEFORE any `git worktree remove` — `remove --force` recurses through the
       junction and wipes the PRIMARY checkout's node_modules. Anything that
       runs Metro/`expo start` needs a real install, not a junction.
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
   - In each subagent dispatch prompt, say explicitly: "synthesize and return
     the full report yourself as your final message; do NOT delegate to or
     wait on sub-agents." A parent agent that spawns its own children can
     complete with a "waiting…" placeholder instead of its report; recover by
     `SendMessage` to that agentId: "produce your final synthesized report
     NOW, directly."
   - Follow repository conventions and existing architecture. Prefer focused
     edits over broad refactors.
   - For bugs or unexpected failures, use `superpowers:systematic-debugging`
     before changing direction.
   - For tests, use judgment: apply `superpowers:test-driven-development` when the
     task is behaviorally risky or the repo expects it; for small low-risk copy,
     styling, or asset swaps, make the focused edit and verify afterward.

7. **Verify before review**
   - Use the `superpowers:verification-before-completion` skill. Run the most
     relevant checks from the project manifests/docs (factory-managed: the
     `verify` commands in `config/factory.json`) — targeted tests first, then
     broader checks for shared or user-facing impact.
   - **Stop-and-fix, bounded:** at most 3 repair cycles. Still failing after
     that → this is the **Failure** exit path (see "Exit paths" below) —
     stop implementing and go make the terminal transition rather than
     continuing to iterate.
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
     Factory-managed: use the repo slug from `config/factory.json`, not the
     local directory name (`travel_app`'s repo is `khe618/travel_blog`).
   - In the PR description include: the task (ID + text); what was
     implemented; verification performed and results; key design choices; any
     high-level decisions made without user input (especially uncertain ones with
     reasonable alternatives); and follow-ups or known limitations. If the
     verification loop hit repair cycles but ultimately passed, note that.

10. **Update task status after PR creation — the Success exit path**
    - See "Exit paths → Success" below for the full factory-managed
      procedure (factory commit with the PR link + `pr_opened` event, pushed
      with the discard-and-rebuild rule).
    - *Legacy (non-factory):* keep the task `[in progress]` and append the PR
      link to its `Evidence` line per the contract — do **not** invent an "in
      review" state. Make this update by editing the local `TASKS.md` in the
      **primary checkout** only (gitignored/untracked, see step 2) — no
      commit is involved. The task is removed by `task-manage` once the work
      merges to the default branch.

11. **Capture deferred ideas**
    - Per the global preferences, run the `idea-capture` check after a larger
      feature so any "we could also… / later" items land in
      `ideas/<project>.md` (factory-managed) or `IDEAS.md` (legacy).

## Exit paths

**Every claimed task must reach exactly one of these four terminal outcomes
before the run ends — never leave a factory-managed task `[in progress]`
without either a live PR link in `Evidence` or an in-flight claim that a
later reconcile pass can still validate.** This table is the local twin of
the cloud worker's exit contract (spec §5.1 step 8, §4.1 Attempts/lease
rules); each row below applies to **factory-managed** projects. Legacy
projects have no ledger and no terminal-state requirement beyond the
existing two-state contract.

| Exit | When | Factory commit | Ledger event | Queue end state |
| --- | --- | --- | --- | --- |
| **Success** | PR exists (step 9 completed) | `Evidence` gets the PR link appended (task text unchanged otherwise) | `pr_opened` | stays `[in progress]` |
| **Failure** | Verification still fails after the 3-cycle repair bound (step 7), and it's not a genuine blocker | increment `Attempts` with a one-line note of what failed | `failed` | `[open]` if `Attempts` < `attemptCap` (config, default 2); else `[blocked]` with the accumulated `Attempts` notes as the `Blocked:` reason |
| **Blocked** | A genuine blocker: missing credential, ambiguity that materially forks the design, or human action needed mid-run | flip to `[blocked]` with a precise `Blocked:` line (date, reason, exact human action needed) | `blocked` | `[blocked]` |
| **Abandon** | The user interrupts mid-run | if no PR was opened yet: apply the **Failure** transition above before stopping. If a PR already exists: apply the **Success** transition (the work isn't lost, just paused) | `failed` or `pr_opened` per which transition applied | per whichever transition applied — never left `[in progress]` with a dangling claim |

**Every exit writes exactly one factory commit + one ledger event file, then
pushes with the same discard-and-rebuild rule as the claim (spec §4.4): on
rejection, `git -C /c/dev/factory fetch && git -C /c/dev/factory reset --hard
origin/main`, re-read the current queue state, rebuild the same terminal
edit fresh against the new head (never rebase-replay), and retry. This is
not bounded at 3 tries like the claim — a terminal transition must land, so
keep retrying with backoff; if it truly cannot land after several tries,
leave the transition committed locally and tell the user exactly what to
push and why (never silently drop a terminal transition).**

Ledger event detail: each event file needs `v:1`, `ts` (ISO UTC),
`actor: "local:<project>"` (stable per project — never per-session; the
dashboard's routines/health map groups by `actor`, so it must not fragment
across runs), `run: "local:<session-short-id>"` (the same id used at claim
time, unique to this run), `event` (`pr_opened` / `failed` / `blocked` per
the table), `project`, `task` (`<id>`), `detail` (one line — the PR link for
`pr_opened`, the failure/block reason otherwise), and `pr` (the PR URL, when
one exists).

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
  require user action — and when blocked or abandoned, always apply the
  matching **Exit paths** transition above so a factory-managed task never
  exits a run still `[in progress]` without a terminal event or a live PR.
