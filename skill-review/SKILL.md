---
name: skill-review
description: Review durable findings from the agent-logs system (global ~/.claude/agent-logs/*.md topic files and per-project LEARNINGS.md) and propose edits to the user's own editable skills under ~/.claude/skills/*/SKILL.md, delivered as a reviewable git PR. Never touches plugin skills under ~/.claude/plugins/. Use when the user types /skill-review, or asks to "review my skills against the logs", "update skills from learnings", "fold agent-logs findings into skills", "feed my learnings back into skills", or to do a skills maintenance pass. Two modes: interactive (default, propose edits one at a time) and autonomous (--auto, best-effort auto-select then open a PR). Flags: --auto, --all, --global-only, --in-place.
---

# /skill-review

Scan the durable findings in the agent-logs system, find entries that imply a concrete change to an owned skill, propose the edits, and deliver them through a git PR for review. Record what was reviewed so the same finding is not re-surfaced every run.

## 1. Purpose and when to run

Run when the user types `/skill-review`, asks to "review my skills against the logs", "update skills from learnings", "fold agent-logs findings into skills", "feed my learnings back into skills", or wants a skills maintenance pass.

**Two modes:**

- **Interactive (default):** Propose edits one at a time; the human accepts, rejects, or skips each. Accepted edits go into a PR.
- **Autonomous (`--auto`):** Best-effort auto-selection behind hard eligibility rules; opens a PR for the human to review later. No in-chat prompts.

Both modes deliver via a branch + PR -- never a direct commit to `main` -- unless `--in-place` is explicitly passed.

**Four flags (combinable):**

- `--auto` -- autonomous mode.
- `--all` -- bypass the candidate filter and reconsider all previously-reviewed entries.
- `--global-only` -- skip per-project `LEARNINGS.md`; read only global `~/.claude/agent-logs/*.md` files.
- `--in-place` -- apply edits directly to the working tree, no branch, no PR, no review surface. The user has opted out of review. Still runs preimage verification, redaction, and secret scans per edit. Label this mode clearly in all output.

**Out of scope (v1):** creating new skills (that is `skill-creator`); skill evals or wholesale description rewrites; scheduled or hook runs; auto-merging PRs; auto-running `sync-codex` (the Codex mirror is *handed off* after human review, never synced from inside this skill -- see Section 9); re-checking prior PR status; writing back to agent-logs files.

## 2. Owned-skill discovery

**Canonical rule:** a directory is an owned, editable skill iff `~/.claude/skills/<name>/SKILL.md` exists exactly one level deep AND `<name>` does not end in `-workspace`.

**Implementation:** glob the single level `~/.claude/skills/*/SKILL.md` (non-recursive); drop parents ending in `-workspace`; as a safety net, skip any matched path whose path segments include `sandbox`, `iteration-*`, `with_skill`, `without_skill`, `pristine`, or `.backup-*`.

Run discovery fresh on each invocation.

**Plugin exclusion (hard rule):** `~/.claude/plugins/**` is NEVER read, written, staged, or touched in any phase of this skill -- discovery, analysis, edits, commits, or PR. Do not include any plugin path as a read target or edit target.

If no owned skills are discovered, report that fact and exit (release the lock).

## 3. Input: log entries

**Sources:**

1. Global topic files: `~/.claude/agent-logs/*.md` -- always read.
2. Per-project `LEARNINGS.md` under `C:\Users\khe61\OneDrive\Documents\CS Programs` -- read unless `--global-only` is passed. Exclude any path containing: `node_modules`, `.git`, `.next`, `dist`, `build`, `out`, `coverage`, `.venv`, `venv`, `env`, `__pycache__`, `.cache`, `*-workspace`, `sandbox`.

**Parsing:**

- Normalize CRLF and CR to LF before processing. Never reformat the source file.
- Split entries on the pattern `^## (\d{4}-\d{2}-\d{2})\b(.*)$` (anchor on the date, separator-agnostic).
- Ignore the header block above the first dated heading.
- An entry runs from a dated `##` to the next dated `##` or EOF -- it includes any appended `**Update YYYY-MM-DD:**` notes.
- **Legacy files** (no dated `##` headings): treat the whole file as one entry; title slug = `whole-file`; hash = SHA-256 of the entire file content post-normalization.

**Entry identity:**

- `logicalSource` = `global:<filename>` (for `~/.claude/agent-logs/*.md`) or `project:<relative-path-from-workspace-root>` (forward-slashed, lowercased; keep the absolute path separately for display).
- `key` = `<logicalSource>|<date or "nodate">|<title-slug>`. Logical keys survive path churn.
- `hash` = SHA-256 of the full entry body (post-normalization). A changed entry (e.g., an `**Update**` appended) re-surfaces it.

**Computing hashes:** use Git Bash `sha256sum` on LF-normalized input (fallback `git hash-object --stdin`, or PowerShell `Get-FileHash -Algorithm SHA256`). Use the same method for entry hashes and for `catalogFingerprint` so values stay stable across runs.

## 4. State file

**Path:** `~/.claude/skills/skill-review/state.json` (gitignored; local machine state only).

A lock file `state.json.lock` guards the whole run. Acquire it before reading or writing state; release it when done (including on error paths).

**Schema (verbatim contract):**

```json
{
  "version": 1,
  "lastRun": "2026-06-19T14:03:00Z",
  "catalogFingerprint": "<sha256 of: each owned skill name + its SKILL.md frontmatter description>",
  "entries": {
    "<key>": {
      "hash": "<sha256-hex>",
      "displayPath": "<absolute path, human reference only>",
      "reviewedAt": "2026-06-19",
      "mode": "interactive | auto",
      "outcome": {
        "status": "applied | declined | irrelevant | already-covered | new-skill-candidate | needs-human-review | conflict | error",
        "appliedSkills": ["wakeup"],
        "declinedSkills": ["mobile-review-digest"],
        "conflictSkills": [],
        "prNumber": 42,
        "branch": "skill-review/2026-06-19-a1b2c3"
      }
    }
  }
}
```

**The 8 outcome statuses (exact):**

- `applied` -- one or more edits accepted and included in PR `prNumber`. Recorded only after the PR URL exists. Per-skill split in the `*Skills` arrays.
- `declined` -- proposals existed but the human accepted none. Resolved; will not re-surface unless content changes.
- `irrelevant` -- no edit applies; resolved.
- `already-covered` -- no edit needed; the skill already says it; resolved.
- `new-skill-candidate` -- useful finding but no owned skill fits. A `skill-creator` job. Live candidate.
- `needs-human-review` -- autonomous mode judged it potentially useful but not eligible for auto-apply (ambiguous, stylistic, or a frontmatter change). Live candidate; a later interactive run will surface it.
- `conflict` -- an accepted edit's target text no longer matched at apply time. Live candidate.
- `error` -- evaluation, commit, push, or PR failed before resolution. Live candidate.

**Candidate selection rules (verbatim):** an entry is a candidate iff any of the following:

- Key is absent from state.
- Stored hash differs from the current entry hash (content changed).
- Stored status is `new-skill-candidate` AND `catalogFingerprint` has changed.
- Status is `needs-human-review`, `conflict`, or `error`.
- `--all` flag is present.

`catalogFingerprint` hashes skill names PLUS each `SKILL.md` frontmatter description, so a rewritten or renamed skill re-surfaces deferred candidates even if names are unchanged.

**`--all` behavior:** bypasses the candidate filter only; never wipes `entries`. Prior outcomes are overwritten only for entries that receive a new explicit outcome this run.

**Robustness:**

- Missing state file: treat as empty.
- Corrupt state file: copy to `state.json.corrupt.<UTC-ts>`, warn the user, proceed with empty state.
- Permission or IO error on state: abort.
- Writes are temp-file-then-rename for atomicity.
- If `state.json.lock` is already held when you try to acquire it, abort with "another skill-review run is in progress".

## 5. Secret handling

Secrets must never be committed, pushed, displayed in a proposal, written into a commit message, or written into a PR body. Two gates apply:

**Setup gate (one-time, initial commit):** scan all to-be-tracked files before the very first commit.

**Per-commit gate (every run):** before any `git commit`, scan the staged diff AND the proposed commit message AND the PR title/body with `SECRET_RE`. Any hit blocks the commit and push; surface the offending file and line to the user; do not proceed until resolved.

**Redact-before-display:** before presenting any finding or draft edit in chat, redact any content matching `SECRET_RE` -- show guidance (e.g., "[redacted credential]"), never the raw value. Redact absolute local paths containing usernames from proposals where practical.

**`SECRET_RE` (extended-regex, used with `grep -nE`):**

```
ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(proj-|ant-)?[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,}|sbp_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|A[KS]IA[A-Z0-9]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----|[Aa]uthorization:[[:space:]]*[Bb]earer[[:space:]]+[A-Za-z0-9._-]{20,}|"(private_key|client_secret|refresh_token)"[[:space:]]*:|(SECRET|TOKEN|PASSWORD|API_KEY)[A-Za-z0-9_]*[[:space:]]*=[[:space:]]*[^[:space:]]{12,}
```

**`CRED_GLOB_RE` (staged path names that must never be committed):**

```
(^|/)(\.env(\..*)?|\.npmrc|credentials\.json|.*\.(pem|key|p12|pfx)|id_rsa.*|id_ed25519.*)$
```

**Setup scan procedure** (one-time, the very first commit -- scans the FULL content of every to-be-tracked file, since there is no prior history to diff against):

```bash
cd ~/.claude/skills
git ls-files --cached | grep -E "$CRED_GLOB_RE" && { echo "BLOCK: credential filename staged"; exit 1; }
git diff --cached -- . ':(exclude)skill-review/spec.md' ':(exclude)skill-review/plan.md' | grep '^+' | grep -nE "$SECRET_RE" && { echo "BLOCK: secret in staged content"; exit 1; }
echo "SECRET-SCAN CLEAN"
```

(The two pattern-documentation files are excluded because they legitimately contain `SECRET_RE` in regex form. On a fresh repo the entire content of each staged file appears as `^+` lines in `git diff --cached`, so this catches secrets in full file bodies.)

**Per-commit scan procedure** (every run, before any commit skill-review makes -- scans only ADDED lines plus the messages):

```bash
cd ~/.claude/skills
git ls-files --cached | grep -E "$CRED_GLOB_RE" && { echo "BLOCK: credential filename staged"; exit 1; }
git diff --cached | grep '^+' | grep -nE "$SECRET_RE" && { echo "BLOCK: secret in staged content"; exit 1; }
echo "SECRET-SCAN CLEAN"
```

Also scan the commit message and any PR title/body text with `grep -nE "$SECRET_RE"`. Only added lines (`^+`) are scanned, so deleting an existing secret never blocks a cleanup commit. On any `BLOCK:`, stop the run, show the offending file/line to the user, and do not commit or push until resolved.

## 6. Workflow: common steps 1-7

**Step 1 -- Parse args.**
Parse `--auto`, `--all`, `--global-only`, `--in-place`. Default is interactive with PR.

**Step 2 -- Acquire lock.**
Write `state.json.lock`. If it already exists, abort: "another skill-review run is in progress."

**Step 3 -- Repo preflight.**

- Require `~/.claude/skills` to be a git repo with an `origin` remote and `gh` authed. If any is missing, abort with setup guidance -- UNLESS `--in-place` was passed (the explicit no-PR escape hatch; it still runs preimage + redaction + secret scans per edit, but the user has opted out of review surface). In `--in-place` mode, label all output clearly: "Applying in-place -- no branch, no PR, no review surface."
- **Interrupted-run recovery:** if the current branch is a `skill-review/*` branch with uncommitted changes, treat it as a crashed prior run. Offer three options: (a) commit + PR the leftover edits, (b) discard them (`git checkout -- .` / delete the branch), or (c) abort. Wait for the user's choice.
- **Dirty tree on `main` (or any non-`skill-review/*` branch):** abort. Ask the user to commit or stash unrelated changes before running.

**Step 4 -- Build the owned-skill catalog.**
Run discovery (Section 2). Read each full `SKILL.md` -- the catalog is small (around 10 skills), so read full content, not just headings, to avoid false no-match judgments. Compute `catalogFingerprint` as SHA-256 of: all skill names concatenated with their `SKILL.md` frontmatter description fields, in discovery order. If no owned skills found, report and exit (release lock).

**Step 5 -- Collect and identify candidates.**
Read all in-scope log files, parse entries, compute `key` and `hash` for each. Load state. Apply the candidate-selection rules from Section 4. If zero candidates, print: "Nothing new since last run (<N> already reviewed)." Refresh `lastRun` and `catalogFingerprint` in state, release lock, and exit.

**Step 6 -- Match, redact, and draft.**
For each candidate:

1. Redact the entry body first (Section 5) -- show guidance, never raw secrets or absolute paths with usernames.
2. Judge the entry against the full skill catalog. A finding qualifies if it:
   - **Contradicts** quoted current skill text (stale or wrong), OR
   - **Adds a concrete, actionable item** absent from the skill: a specific command, flag, path-shape, or gotcha.
3. Classify non-proposals: `irrelevant` (no skill connection), `already-covered` (skill already says it), `new-skill-candidate` (useful but no owned skill fits).
4. Draft the smallest edit that captures the qualifying finding. Tag `[description change]` if the edit touches frontmatter or a skill's trigger/description line.
5. If the finding matches multiple skills, draft one edit per skill. Outcomes are recorded per-skill.

**Step 7 -- Open a working branch** (skip in `--in-place` mode).

```bash
git checkout main
git fetch origin
git merge --ff-only origin/main
```

If `main` has diverged from `origin/main` and the merge is not fast-forward, abort with guidance: "main has diverged from origin/main -- rebase or push main before running skill-review." Do not branch off stale or divergent main.

Create branch: `skill-review/<YYYY-MM-DD>-<shortid>` (use `git rev-parse --short HEAD` or a random 6-hex string for `<shortid>`). On name collision, append a counter (`-2`, `-3`, ...).

## 7. Interactive mode (default)

**Step 8i -- Present one edit at a time.**

For each proposed edit, display:

- Source finding: `logicalSource` + date + title slug.
- Target: `<skill-name>` -> section heading, plus `[description change]` tag if applicable.
- One-line rationale: why this finding qualifies.
- Exact redacted diff: show the `old_text` and `new_text` as a unified-style diff.

Then prompt for one of five responses:

- `accept` -- apply the edit now (preimage verify per Section 9; see Finalize), queue it for the PR.
- `reject` -- mark the finding `declined` (resolved; will not re-surface unless content changes).
- `skip` -- record NO outcome; the entry stays a live candidate for the next run.
- `accept-all-remaining` -- accept every remaining unanswered proposal without further prompting; apply each in turn (preimage verify per Section 9 for each).
- `stop` -- stop the presentation loop. Already-accepted edits proceed to commit and PR. Not-yet-decided entries are treated as `skip` (live). Confirm with the user before stopping: "Stop presenting? Accepted edits will proceed to PR; unanswered entries will stay live for the next run." Stopping discards nothing.

**Step 9i -- Finish.**
If zero edits were accepted: no commit; delete the empty branch; update state for `declined` entries (skip entries receive no state write and remain live candidates); release lock; report.
If one or more edits were accepted: proceed to Finalize (Section 9).

## 8. Autonomous mode (`--auto`)

**Step 8a -- Hard eligibility (auditable, no subjective bar).**

Auto-apply an edit ONLY if it meets one of:

- **(a) Exact contradiction:** the finding directly contradicts a specific sentence in the target `SKILL.md`. The conflicting current text must be quotable in the PR body.
- **(b) Concrete absent item:** the finding supplies a specific command, flag, path-shape, or gotcha that is verifiably not present anywhere in the target `SKILL.md`.

**Never** auto-apply frontmatter, description, or trigger changes -- these are always `needs-human-review`.

Anything that looks useful but does not meet (a) or (b) -- ambiguous, stylistic, or a frontmatter change -- is classified `needs-human-review` (live candidate, listed in the PR body's "Deferred" section). Apply eligible edits with preimage verification (Section 9).

**Step 9a -- Finish.**
PR body has two sections:

- "Applied" -- each applied edit, with the source finding quoted, and for (a) edits, the contradicted text quoted.
- "Deferred for human review" -- the `needs-human-review` and `new-skill-candidate` items, listed with their source and rationale.

If nothing is eligible: no branch, no PR; report the deferred items; they remain live candidates. Proceed to Finalize for state write and lock release.

## 9. Finalize

**Preimage verification (every edit, both modes):**
Before applying any edit, re-read the target `SKILL.md` and confirm the proposed old text occurs exactly once. If the text is missing or occurs more than once, skip that edit and mark the source entry `conflict` (live candidate). Apply the exact-string edit (using the Edit tool). Confirm the resulting file content matches the expected diff.

**Atomic commit -> push -> PR ordering:**

1. Stage edits (`git add skill-review/<name>/SKILL.md` for each modified skill -- staged by name, not glob).
2. Run the per-commit secret scan (Section 5) over the staged diff, the proposed commit message, and the PR title/body. Abort push on any `BLOCK:` hit; do not mark `applied`; mark affected entries `error`; preserve the branch with recovery instructions.
3. Commit: `git -c user.name="khe618" -c user.email="khe618@yahoo.com" commit -m "<message>"`.
4. Push: `git push -u origin <branch>`.
5. Create PR: `gh pr create --base main --title "<title>" --body "<body>"`.
6. Record `applied` (with `prNumber` and `branch`) **only after `gh pr create` returns a real PR URL**. Never record `applied` with a placeholder.

**On push or PR creation failure:**
Do NOT mark the affected entries `applied`. Mark them `error`. Preserve the branch (committed work is not lost). Print recovery instructions: the branch name, the push command to retry, and the `gh pr create` command to create the PR manually. Never delete a branch that has commits on a failure path.

**State update (resolved entries only):**
Write `{ hash, displayPath, reviewedAt, mode, outcome }` for each resolved entry. Statuses `skip`, `needs-human-review`, `conflict`, and `error` are either recorded as such or left absent (for pure `skip`), so they stay live candidates. Refresh `lastRun` and `catalogFingerprint`. Write via temp-file-then-rename. Release the lock.

**Report (print after every run):**

One ASCII summary line (verbatim format):

```
Scanned <N> | new/changed <C> | edits <P> across <S> skills | applied <A> | declined <D> | already-covered <AC> | new-skill-candidate <NC> | needs-human-review <HR> | irrelevant <I> | conflict <CF> | PR <url-or-none>.
```

Then one line per applied edit:

```
[applied] <skill>: <one-line-description> (from <logicalSource> <date>)
```

**Codex sync hand-off (never auto-run):**

skill-review edits only the Claude side (`~/.claude/skills`). Some skills are mirrored as a *translated* copy under `~/.codex/skills` (kept aligned by the `sync-codex` skill), so an applied edit can leave Codex stale. **Never invoke `sync-codex` from within this skill** -- only hand off, and only for the human-reviewed version of the change:

1. **Detect mirrored targets.** For each skill that received an `applied` edit this run, check for a Codex counterpart: a directory `~/.codex/skills/<name>` exists, with the one known rename `commit` -> `git-commit`. If `~/.codex/skills` is absent (Codex not installed), or no applied skill has a counterpart, print `No Codex-mirrored skills changed -- no sync needed.` and stop.
2. **PR modes (interactive, `--auto`).** The edits live on a branch/PR; local `main` is unchanged, so there is nothing to sync yet, and the human-review gate is the PR *merge* -- which happens after this run exits. Do not run anything. Print:
   `Codex-mirrored skill(s) changed: <list>. After you review and merge PR <url> and pull ~/.claude/skills, run sync-codex scoped to those skills to mirror the change into ~/.codex/skills. Not run here by design -- only the merged, human-reviewed version should be synced.`
3. **`--in-place` mode (no review surface).** The edits were applied unreviewed, so do **not** start a sync. Print:
   `Applied in-place with no review. Codex-mirrored skill(s) now differ from ~/.codex/skills: <list>. Run sync-codex (it has its own report-before-write gate) when you choose to propagate -- intentionally not auto-run because these edits were not human-reviewed.`

The rule is identical across modes: **detect and hand off; a human-reviewed change is what authorizes the sync; `sync-codex` always runs separately** (preserving its own plan-before-write review). This is a hand-off message only -- it changes no files and runs no commands.

## 10. Error handling and edge cases

- **No repo / no remote / `gh` unauthed:** abort with setup guidance (both modes), unless `--in-place` is passed (explicit, no review surface).
- **Interrupted prior run (leftover `skill-review/*` branch with uncommitted changes):** recovery prompt -- offer (a) commit + PR, (b) discard, or (c) abort.
- **Dirty tree on main:** abort; ask the user to commit or stash.
- **Stale / divergent main (non-ff vs origin):** abort before branching.
- **Concurrent run (lock held):** abort.
- **Corrupt state:** backup + warn + proceed empty; state IO error -> abort.
- **Secret detected (setup, per-commit, or in a draft):** block; never commit, push, or display a secret.
- **No candidates / no owned skills:** report and exit.
- **Legacy / malformed log file:** treat as a single `whole-file` entry; never reformat.
- **Finding matches multiple skills:** one edit per skill; structured per-skill outcome arrays.
- **Push / PR failure after commit:** mark entry `error`; preserve branch; print recovery message; do not mark `applied`.
- **Update appended to a reviewed entry:** hash changes; entry re-surfaces as a candidate.
- **New or rewritten skill:** `catalogFingerprint` changes; deferred `new-skill-candidate` and `needs-human-review` entries re-surface.
- **Target text changed before apply:** `conflict` (live candidate).
- **Plugin skills:** never read or written; `~/.claude/plugins/**` is excluded from all phases.
- **Codex-mirrored skill edited:** at Finalize, hand off to `sync-codex` (gated on the human-reviewed/merged change); never auto-run it from this skill. `--in-place` edits are flagged as out-of-sync but not auto-synced, because they were not reviewed.
