---
name: commit
description: Stage changed files, run the project linter, create a one-line commit, and push to the remote. Use when the user types /commit, or says "commit and push", "commit my changes", "commit what I have", "ship it", or otherwise asks for the changes in their working tree to be committed and pushed in one shot. This skill explicitly overrides the default Claude Code commit flow — no Co-Authored-By trailer, no multi-line body — so prefer it over the default flow whenever the user asks for a quick commit-and-push.
---

# /commit

Stage the user's working-tree changes, commit them with a single-line message, and push. End-of-session shortcut — keep it tight, don't editorialize.

## Workflow

Run these in order. Don't skip the inspection steps — the commit message has to actually describe what changed, and that requires reading the diff.

1. **`git status`** — see what's modified, staged, and untracked.
2. **`git diff`** and **`git diff --staged`** — read the actual changes. You need this to write a meaningful one-line message; "update files" is not a commit message.
3. **`git log -1 --format=%s`** — glance at the most recent commit message so your style matches the repo (e.g. lowercase imperative vs. sentence case). Don't impose Conventional Commits unless the repo already uses them.
4. **`git add <files>`** — stage the relevant changed and untracked files **by name**. Do not use `git add -A` or `git add .` — those can sweep up secrets or unrelated junk.
5. **Run the project linter.** Use the repo's documented lint script (e.g. `npm run lint`, or whatever the manifest defines). If no lint command exists, say so and skip this step. **If lint fails, stop and report — do not commit** unless the user already told you to commit despite lint failures. Don't auto-fix.
6. **Compose the commit message.** One line. Under ~72 characters. Describe the change. No body, no footer, **no `Co-Authored-By` trailer**. The user wants one line — give them one line.
7. **`git commit -m "<message>"`** — pass the message via `-m`, not a HEREDOC, since it's a single line.
8. **`git push`** — push to the current branch's upstream.
9. **Report briefly** — one sentence: "Committed `<message>`, lint passed, pushed to `<branch>`." That's it.

## Files to skip when staging

Look at the `git status` output before staging and **do not** stage:

- `.env`, `.env.*`, `.envrc`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`
- `credentials*`, `secrets*`, `*.secret`
- Anything matching patterns in the project's `.gitignore` that has somehow ended up untracked-but-visible (a sign it was force-added or the ignore is broken)
- Large binaries the user clearly didn't mean to commit (build outputs, `node_modules/` if untracked, multi-MB media not referenced in the diff)

If you see one of these, **stop and ask the user** before staging anything. Don't quietly skip it and commit the rest — the user might have meant to add it (a real `.env.example`, an intentional cert) or might want to know it leaked into their working tree.

## Edge cases — stop and report, don't auto-fix

The whole point of this skill is "I'm done, ship it." Auto-recovery from these states is the opposite of simple and can destroy work. Surface the problem and let the user decide.

- **Clean working tree.** `git status` shows nothing to commit. Tell the user there's nothing to commit and stop. Do not create an empty commit, do not `--allow-empty`.
- **Lint failure.** The linter (step 5) reported errors. Report which check failed and paste the relevant output, then stop — do not commit. The user fixes it and re-runs `/commit`. (If they explicitly said to commit despite lint, proceed.)
- **Pre-commit hook failure.** The commit didn't happen. Report which hook failed and paste the relevant output. Do not retry with `--no-verify`. Do not `--amend` (the previous commit is unrelated; amending it would corrupt history). Let the user fix the underlying issue, then they can re-run `/commit`.
- **Push rejected — non-fast-forward.** The remote has commits you don't. Report the rejection. Do **not** `git push --force` or `--force-with-lease`. Do **not** auto-`git pull` or `git pull --rebase` — the user might have local commits that would conflict, and rebase decisions belong to them.
- **No upstream set / detached HEAD.** Report it and stop. Don't run `git push -u origin <branch>` or `git checkout -b` on the user's behalf — branch topology is a deliberate choice.
- **Merge or rebase in progress** (`.git/MERGE_HEAD`, `.git/rebase-*` exist). Report it and stop. The user is mid-operation; don't interfere.

## What this skill is *not*

- Not a code review. Don't lecture the user about their changes; just commit them.
- Not a refactor opportunity. Don't tidy up other files "while you're in there."
- Not a place for the standard Claude Code commit footer. The user explicitly asked for a one-line message — `Co-Authored-By` and `Generated with Claude Code` lines turn it into a four-line message.

## Why these constraints

The user built this skill because they want a one-keystroke ship-it command at the end of a session. Every guard above exists because the alternative — auto-recovering from hook failures, auto-pulling on rejected pushes, force-pushing — can silently destroy work or rewrite shared history. "Stop and tell the user" is cheap; "oops, I rebased your unpushed work onto a divergent main" is not. When in doubt, surface the situation and stop.
