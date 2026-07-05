---
name: merge-and-ship
description: >-
  Merge a GitHub pull request, get the result shipped to production, and clean
  up after — as one workflow, for Vercel-deployed projects. Use this WHENEVER
  the user wants to land a PR: "merge PR #9", "merge this PR", "ship PR 12",
  "merge and deploy", "land my branch", "merge it", or types /merge-and-ship.
  Treat merging and deploying as inseparable here — a merge that doesn't reach
  production isn't done. Also use it when a merge has already happened and the
  user wants the deploy + cleanup that should have followed. Do NOT use it to
  *open/create* a PR (that's the `pr` skill) or to just commit (that's
  `commit`).
---

# Merge and ship

Landing a PR in these projects is three steps that belong together: **merge →
ship to production → clean up.** People remember the merge and forget the other
two, so changes sit unshipped or worktrees/branches pile up. This skill keeps
them attached and, just as importantly, **verifies each step actually
happened** instead of assuming it did.

It is written for the user's Vercel-deployed apps (travel_app, traderprep, and
siblings). They live under a OneDrive path with a space in it
(`CS Programs`) — quote paths — and OneDrive introduces a few specific
failure modes this skill is built to absorb (see [Failure modes](#failure-modes-fold-these-in)).

## The one rule that makes this safe

**Never destroy the user's uncommitted work to unblock a step.** No
`git checkout -- <file>`, `git reset --hard`, `git stash`, or `git clean` on
files you didn't create, just to make a fast-forward or a deploy go through. If
the working tree is in the way, work *around* it (deploy from a throwaway
worktree — see step 3). Discarding their changes is almost never what they
want and is hard to undo.

## Before you start

Confirm you're in the project's git repo (the one whose PR this is), not the
workspace root.

**You usually don't need a PR number — resolve it yourself and only ask when
it's genuinely ambiguous.** "Merge my PR" / "merge it" / "ship it" with no
number is the common case, not an error. Resolve in this order:

1. **Number given** → use it.
2. **The current branch's PR** → `gh pr view --json number,state,title,headRefName`
   (with no number, `gh pr view` targets the PR for the checked-out branch). If
   it exists and is `OPEN`, that's the target — this is the most common case
   and needs no prompt.
3. **Exactly one open PR in the repo** → `gh pr list --state open --json
   number,title,headRefName`; if the list has one entry, that's it.
4. **Only ask when truly ambiguous** — several unrelated open PRs and the
   current branch isn't one of them. Show the short list and let the user pick.

Always narrate which PR you resolved before acting ("merging the open PR for
this branch — #9, 'Size album cover preview…'") so a wrong guess is caught
before the merge, not after.

## Step 1 — Pre-merge checks

Verify the PR is actually ready. Don't merge on faith.

```bash
gh pr view <N> --json state,mergeable,mergeStateStatus,baseRefName,headRefName
gh pr checks <N>          # CI status — don't merge over red checks
```

- `state` is `OPEN`, `mergeable` is `MERGEABLE`, `mergeStateStatus` is `CLEAN`
  (or `UNSTABLE` only if the failing checks are non-blocking and the user is
  aware).
- `baseRefName` is the intended base (usually `main`). A PR accidentally based
  on the wrong branch is a common foot-gun — surface it, don't merge.
- If CI is red or pending, say so and stop. Ask before merging anyway.

If the user invoked the skill with a PR number, that *is* the go-ahead to
merge — once the checks pass, proceed without a second "shall I merge?" gate.
Just narrate a one-line plan ("PR #9 is clean, base main — squashing, then
deploying").

## Step 2 — Merge

Match the repo's existing merge convention rather than imposing one. Look at
recent history:

```bash
git log --oneline -8 origin/<base>
```

If each past PR is a single commit titled `… (#N)`, the repo squash-merges —
use `--squash`. If you see merge commits, use `--merge`. When in doubt,
`--squash` is the safe default for these projects.

```bash
gh pr merge <N> --squash --delete-branch
```

**Gotcha — `--delete-branch` fails when the branch is checked out in a
worktree.** These projects use git worktrees heavily (`.worktrees/…`,
`.claude/worktrees/…`, Codex worktrees). If the PR's head branch is checked out
in one, `--delete-branch` errors with *"cannot delete branch … used by
worktree at …"*. **This does not mean the merge failed** — the squash-merge on
the remote succeeds. But the failed local delete also aborts the REMOTE branch
deletion (gh runs both as one post-merge step), so the branch survives on
origin too — clean up both sides in step 4. Confirm the merge with:

```bash
gh pr view <N> --json state,mergeCommit    # expect state MERGED + a commit sha
```

Note the merge commit SHA — step 3 deploys exactly that. Defer the leftover
branch/worktree to step 4.

## Step 3 — Ship to production

The merge put the code on the remote `main`, but **that does not always mean
it's deployed.** Decide the deploy mode by reading the project's own deploy
docs first — they record per-project quirks you can't infer:

```bash
# look for a "## Deploy" section and any deploy script
grep -iA6 "deploy" AGENTS.md CLAUDE.md README.md 2>/dev/null
cat vercel.json package.json 2>/dev/null | grep -i deploy
ls .vercel 2>/dev/null
```

Two modes:

- **Auto-deploy mode** (e.g. traderprep — Vercel's Git integration ships on
  merge to the production branch): the merge already triggered the deploy. Your
  job is to **verify it landed**, not to deploy again. Check
  `npx vercel ls` (or `vercel inspect`) for a new Production deployment that
  reaches READY. Only fall back to a manual deploy if no new deployment appears
  within a few minutes.
- **Manual mode** (e.g. travel_app — AGENTS.md states pushes don't auto-deploy
  because the Git integration isn't firing; the user has standing authorization
  to deploy, no need to re-ask): you must run the deploy yourself.

### Manual deploy — and why the working tree matters

`npx vercel --prod` (or `vercel deploy --prod`) uploads **the current working
directory's files, not a git commit.** This is the trap: if you run it from a
repo whose working tree has uncommitted WIP — or is still on the pre-merge
commit — you'll ship the wrong bytes (WIP code, or code missing the PR you just
merged). So you must deploy from a tree that *is* the merged commit.

```bash
git fetch origin
```

**If the working tree is clean and local `<base>` fast-forwards cleanly:**

```bash
git merge --ff-only origin/<base>      # safely aborts if it can't; never forced
npx vercel --prod --yes                # from the repo root
```

**If the fast-forward is blocked** (`"Your local changes … would be
overwritten"`) **or the tree has uncommitted WIP** — deploy the exact merged
commit from a *throwaway detached worktree*, leaving the user's tree untouched:

```bash
git worktree add --detach .worktrees/deploy-prod-tmp <merge-sha>
cp -r .vercel ".worktrees/deploy-prod-tmp/.vercel"   # carry the project link
cd .worktrees/deploy-prod-tmp && npx vercel --prod --yes
```

If `.vercel/` has only `repo.json` (repo-level linking) and **no
`project.json`**, the CLI may not target the project non-interactively — write
one from the ids in `repo.json`:

```bash
# project.json:  {"projectId":"<id from repo.json>","orgId":"<orgId from repo.json>"}
```

### Verify the deploy — don't assume

A deploy command returning isn't proof. Confirm:

- The `--prod` JSON output shows `"readyState": "READY"` and
  `"target": "production"`, **and** the production alias was re-pointed
  (look for `Aliased  https://<your-domain>` in the output), or
- `npx vercel ls` shows the newest Production deployment is minutes-old.

State the deployed URL/alias and READY status in your report. If it errored or
stuck in BUILDING, say so — a failed deploy after a successful merge is the
worst silent outcome.

## Step 4 — Clean up

Tidy what the merge left behind. Each item is best-effort — **never let a
cleanup failure undo or obscure the successful merge+deploy**, and never
discard uncommitted work to make cleanup easier.

1. **Throwaway deploy worktree** (if you made one): `git worktree remove
   --force .worktrees/deploy-prod-tmp`. On OneDrive/Windows the *folder* delete
   may fail with `Permission denied` / `Device or resource busy` even though
   `--force` already **deregistered** the worktree from git — git state is then
   clean and the orphan folder clears on the next OneDrive sync. Don't fight it;
   note it and move on.
2. **Merged feature branch + its worktree.** If `--delete-branch` was skipped
   because the branch was in a worktree: check that worktree for uncommitted
   changes (`git -C <wt> status --short`). If clean, `git worktree remove <wt>`
   then delete the local branch with `git branch -D` (squash merges aren't
   ancestors of main, so `-d` refuses "not fully merged"; `-D` is correct once
   `gh pr view` shows `MERGED`). Also delete the REMOTE branch — the aborted
   `--delete-branch` left it on origin: `git push origin --delete <branch>`
   (batching several is fine), then confirm with
   `git ls-remote --heads origin <branch>` (empty = gone). **If the worktree
   has uncommitted WIP, leave it and report it** — don't force-remove and lose
   the work.
3. **Fast-forward local `<base>`** so it matches the shipped remote — but only
   if the working tree allows it (step 3's `--ff-only`); never force it past
   the user's uncommitted changes.
4. **Prune the shipped task from `TASKS.md`** (if the project keeps one). The
   merge+deploy you just finished is the moment a queued task is actually
   *done*, and you hold the only key that identifies it: this PR's number and
   head branch. Follow the `task-manage` contract
   (`~/.claude/skills/task-manage/references/tasks-md-contract.md`) — `TASKS.md`
   is a two-state `[open]`/`[in progress]` queue with **no done state**, so
   "done" means **deleting the matching entry**, not adding a `[done]` marker.
   - **Match on an unambiguous key.** Find the one task whose `Evidence` records
     *this* PR (URL/number) or *this* head branch — tasks in these repos embed
     both (e.g. `PR …/pull/11`, `branch task/use-album-actions-hook`). Delete
     only that entry; preserve the rest of the file's order and format.
   - **Don't guess.** No entry matches → leave the file untouched. Multiple
     entries match, or the matched entry has unfinished follow-up beyond what
     this PR shipped → **don't delete**; flag it for the user (or a later
     `task-manage` pass). This mirrors the contract's "if merge evidence is
     unclear, keep the task" rule.
   - This single delete is the *only* write `merge-and-ship` makes to
     `TASKS.md`. Promotion, reprioritizing, and bulk pruning stay with
     `task-manage`, the file's owner — here you're only retiring the item you
     just shipped.
5. **Report what you couldn't auto-clean and why**, so the user can finish it:
   e.g. "left `.worktrees/foo` — it has an uncommitted IDEAS.md edit" or
   "local `main` still behind; you have CRLF-only changes on two files blocking
   the fast-forward."

## Failure modes (fold these in)

These are the specific traps that have bitten in these repos. Recognize the
symptom, apply the fix, don't re-debug from scratch.

- **Stale `.git/index.lock` blocks every git command** (`"Unable to create
  '…/index.lock': File exists. Another git process seems to be running"`).
  Common on OneDrive (sync touches `.git`) or after a crashed/interrupted git
  op. Before removing it, confirm it's stale: check its age (`ls -la
  .git/index.lock`) and that no git process is live (`tasklist | grep -i git`
  on Windows). If old and orphaned, `rm -f .git/index.lock` and retry. Linked
  worktrees have their *own* lock at `.git/worktrees/<name>/index.lock`, so the
  main `.git/index.lock` belongs to the primary tree alone.
- **`git merge --ff-only` refuses over files with no real change.** OneDrive's
  LF→CRLF normalization marks files `M` with an *empty* content diff
  (`git diff --stat` shows nothing for them). The fast-forward still refuses
  because the index is stat-dirty. **Do not** `git checkout --` them to unblock
  — that's discarding the user's tree state without their say-so (and the
  permission classifier will rightly block it). Deploy from the throwaway
  worktree instead (step 3).
- **`vercel` deploys the cwd, not a ref.** Covered in step 3 — the reason the
  clean/dirty branch exists at all.
- **`.vercel` repo-level linking has no `project.json`.** Covered in step 3 —
  hand-write one from `repo.json`.
- **`git worktree remove` "Permission denied" under OneDrive.** Covered in
  step 4 — `--force` still deregisters; the orphan folder is harmless.
- **Merged to main but no production deploy appeared** (auto-deploy mode). If
  main was fast-forwarded onto a SHA Vercel already built as a *preview* (the
  feature-branch tip), Vercel dedups deployments by commit SHA and never
  creates the production deployment. Fix: push a new SHA
  (`git commit --allow-empty -m "chore: trigger production deploy"` on main)
  or Promote/Redeploy the existing deployment in the dashboard (a
  Redeploy-to-Production rebuilds with prod env vars). Squash/merge commits
  create fresh SHAs and avoid this; it bites on manual fast-forward merges.
- **`gh pr merge` fails with `fatal: bad object worktrees/<name>/HEAD` +
  "did not send all necessary objects".** A stale half-created worktree with
  an all-zero HEAD poisons fetch negotiation; the wording blames the remote
  but the problem is local. The PR usually still merged fine server-side —
  confirm with `gh pr view <N> --json state,mergedAt` FIRST. Repair:
  `git worktree list` to find the culprit (`0000000 (detached HEAD)`); if its
  dir holds only a `.git` pointer file, `rm -rf .git/worktrees/<name>` (and
  the dir); otherwise write a real commit sha into
  `.git/worktrees/<name>/HEAD` and remove the stale `HEAD.lock`.
- **`gh: command not found` from the Bash tool.** The Bash tool's Git Bash
  PATH omits `C:\Program Files\GitHub CLI` (and a `powershell.exe` spawned
  from it inherits the same stripped PATH). gh IS installed — call it by full
  path: `"/c/Program Files/GitHub CLI/gh.exe" …`.
- **Don't treat `tsc --noEmit` as the gate** if a project's docs say its real
  gate is `npm run lint` (some repos carry a standing `tsc` error baseline).
  Respect each project's documented checks.

## What to report at the end

A tight summary: PR # merged (merge SHA + method), deploy status (READY +
production URL/alias, or "auto-deploy verified"), and cleanup outcome — branch
and worktree removal, the local `<base>` fast-forward, and whether a `TASKS.md`
entry was pruned (or why it was left) — including anything left for the user and
why. If the local `<base>` wasn't fast-forwarded, a worktree/branch wasn't
removed, or a task was left in the queue, name it and give the one-liner to
finish it.
