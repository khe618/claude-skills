---
name: pr
description: Open a GitHub pull request from the current branch using the gh CLI. Use when the user types /pr, or says "open a PR", "make a PR", "create a pull request", "PR this", "submit a PR", or otherwise asks for the work on the current branch to be turned into a pull request. Assumes the branch is already committed and pushed — this skill does not stage, commit, or push on the user's behalf. Enforces a Summary + Test plan body template, verifies the base branch is correct, and writes the PR body without a Co-Authored-By trailer.
---

# /pr

Turn the current branch into a GitHub pull request via `gh pr create`. The branch should already be pushed with commits ahead of the base — this skill won't do that for you. The goal here is: a well-targeted PR with a title that reads cleanly in a list and a body that tells a reviewer what changed and how to check it.

## Workflow

Run these in order. The inspection steps are not skippable — a PR title and body written without reading the diff is just noise.

1. **`gh auth status`** — confirm `gh` is installed and authenticated. If the Bash tool reports `gh: command not found`, don't conclude it's missing — the Git Bash PATH omits `C:\Program Files\GitHub CLI` (a `powershell.exe` spawned from Bash inherits the same stripped PATH). Retry by full path: `"/c/Program Files/GitHub CLI/gh.exe" auth status`, and use that full path for every gh call below. If genuinely unauthenticated, stop and tell the user; don't try to authenticate on their behalf.
2. **`git status`** and **`git branch --show-current`** — confirm the working tree is clean-ish (uncommitted changes won't be in the PR, which may be a surprise) and note the current branch.
3. **Determine the base branch.** Run `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` to get the repo's default branch (usually `main` or `master`). That is the default base. If the current branch was branched from something else (e.g. a long-lived `develop` or a stacked branch), the user should tell you — but don't go hunting for it unprompted. **If the current branch *is* the default branch, stop** — you can't open a PR from main into main.
4. **`git log --oneline <base>..HEAD`** — see the commits that will be in the PR. If this is empty, stop: there's nothing to PR.
5. **`git diff <base>...HEAD --stat`** then **`git diff <base>...HEAD`** — read the actual changes. Note the three dots: `base...HEAD` shows what this branch adds relative to the base's tip at merge-base, which is what the PR will contain. `base..HEAD` (two dots) is fine for `git log` but misleading for diffs.
6. **Check the branch is pushed and up-to-date with its upstream.** Run `git status -sb` — look for `ahead N` (unpushed commits) or "no upstream". If either, stop and tell the user to push first. Do not `git push` for them; this skill's scope is PR creation only.
7. **Check whether a PR already exists for this branch.** Run `gh pr list --head <current-branch> --json number,url`. If one exists, report its URL and stop — don't open a duplicate.
8. **Compose the title.** Short (under ~70 chars), imperative mood, describes the change at a glance. Match the repo's existing PR title style — glance at `gh pr list --limit 5 --json title` if unsure (Conventional Commits? sentence case? lowercase?). If the repo has no prior PRs, fall back to the commit-message style from `git log --oneline -5` instead. Don't impose a convention the repo doesn't already use.
9. **Compose the body using the template below.** Read the commits and diff to fill it in — this is the part reviewers actually read.
10. **Confirm the base branch with the user if anything is unusual.** If the current branch's name implies a target other than the default (e.g. `hotfix/*` going into `release/*`, or a stacked branch obviously off another feature branch), ask before running `gh pr create`. If the default branch is the obvious target, just proceed.
11. **`gh pr create`** with title and body, using a HEREDOC for the body so multi-line formatting survives. See the exact invocation below.
12. **Report the PR URL.** One line. `gh pr create` prints the URL on success — relay it.

## PR body template

Use this exact structure. Fill the sections from the commits and diff; don't pad with filler.

```markdown
## Summary
- <one bullet per logical change, present tense, describes *what* changed at a high level>
- <keep to 2–5 bullets; if you need more, the PR is probably too big>

## Test plan
- [ ] <something the reviewer (or you) can do to verify this works>
- [ ] <edge cases worth checking>
- [ ] <regressions to watch for>
```

Two notes on the body:

- **Summary describes the change, not the process.** "Refactored auth middleware to use the new token shape" — yes. "Spent a while debugging the test suite then fixed the imports" — no.
- **Test plan is for the reviewer's benefit, not a log of what you did.** Phrase it as checks they should run, not history of checks you ran. If you genuinely verified something locally and it's worth calling out, fine, but the format is "things to verify," not "things I verified."

## The gh pr create invocation

Pass the body via HEREDOC so newlines, headings, and checklist items render correctly. Example:

```bash
gh pr create --title "the pr title" --base main --body "$(cat <<'EOF'
## Summary
- bullet one
- bullet two

## Test plan
- [ ] check thing
- [ ] check other thing
EOF
)"
```

Run this command via the **Bash tool**, not PowerShell — the `<<'EOF'` HEREDOC syntax is bash-only. If for some reason you need to run from PowerShell or a shell that doesn't support HEREDOCs, write the body to a temp file and use `gh pr create --body-file <path>` instead, then delete the temp file. `--body-file` is the most portable form; HEREDOC is just more convenient inside a single command.

Key flag notes:

- `--base <branch>` — be explicit. The default is the repo's default branch, but stating it makes the PR target obvious in the command and unambiguous if defaults change.
- `--head <branch>` — usually not needed; defaults to the current branch.
- `--draft` — **only if the user asked for a draft.** Don't pre-emptively open as draft. If they say "draft PR" / "open as draft", add it; otherwise skip.
- `--web` — don't pass this. It opens a browser form, which defeats the point of running the skill.
- `--reviewer`, `--assignee`, `--label` — only if the user mentioned specific reviewers/labels. Don't guess.
- `'EOF'` (quoted) — the single quotes around `EOF` prevent shell expansion inside the body. Important if the body contains backticks or `$`.

**Do not include a `Co-Authored-By:` or "Generated with Claude Code" trailer in the body.** Matches the user's `/commit` preference — keep PR bodies clean.

## Edge cases — stop and report, don't auto-fix

The whole point of this skill is "the branch is ready, ship the PR." Auto-recovery from these states either does the wrong thing or silently expands scope.

- **Current branch is the default branch** (e.g. on `main`). Stop. PRs go from a feature branch into main, not main into itself. Don't offer to create a branch.
- **No commits ahead of base.** Stop and report. An empty PR isn't useful and may indicate the user thinks they have work that isn't actually committed.
- **Unpushed commits / no upstream.** Stop and tell the user to push first. Do not run `git push -u origin <branch>` — branch/upstream decisions are not in this skill's scope.
- **Uncommitted changes in the working tree.** Warn the user before creating the PR — those changes won't be in it. They might have forgotten to commit, or they might be intentional WIP. Let them decide.
- **A PR already exists for this branch.** Report the existing PR's URL and stop. Don't open a duplicate; don't edit the existing one unless the user explicitly asks.
- **`gh` not authenticated** (`gh auth status` errors). Stop and report. The user runs `gh auth login` themselves — it's interactive and requires a browser.
- **Detected base looks wrong.** If the repo's default branch is something unusual (e.g. you see both `main` and `develop` as long-lived branches and the feature branch was clearly cut from the non-default one), ask the user which to target before creating.
- **Merge conflicts with base.** Don't try to resolve them. Note it in the report if `gh pr create` warns about it, but the PR can still be opened — GitHub will surface the conflict on the PR page.

## What this skill is *not*

- **Not a commit/push tool.** If the branch isn't pushed, that's a separate operation — use `/commit` or push manually first.
- **Not a code review.** Don't editorialize about the changes in the PR body. State what changed; let the reviewer judge.
- **Not a place for marketing.** No "🚀", no "This PR adds the long-awaited X feature!", no Co-Authored-By trailer. Clean, factual, scannable.
- **Not a refactor opportunity.** Don't tweak unrelated files "to make the PR cleaner." The PR is whatever is already on the branch.

## Why these constraints

The user wants a fast, one-step PR-creation command that produces consistently good PRs without surprises. Every guard above exists because the alternative — auto-pushing, auto-resolving the base branch from heuristics, opening duplicates, padding the body with boilerplate — either silently does the wrong thing or wastes the reviewer's time. The PR is the unit of code review, and reviewers respond to PRs that respect their attention: short title, structured body, no noise. "Stop and ask" is cheap; "opened a PR into the wrong branch" or "opened a duplicate PR" is not.
