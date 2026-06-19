# Spec -- `skill-review` skill

**Date:** 2026-06-19
**Status:** Codex-reviewed draft for approval (rev 3 -- hardens git/PR + secret handling)
**Location of skill:** `~/.claude/skills/skill-review/`

Note: this spec is implementation source. All operational literals (regexes, commit/PR
templates, the report line, status names) are plain ASCII. Prose uses ASCII punctuation
too, to avoid mojibake leaking into generated files.

## Problem

`agent-logs` continuously captures durable findings (non-obvious bug fixes, tooling
quirks, library gotchas, contradicted docs) into two places:

- Global topic files: `~/.claude/agent-logs/{claude-code,tooling,libraries,general}.md`
- Per-project files: `LEARNINGS.md` scattered across workspace subprojects

Nothing feeds those findings back into the skills we own and can edit
(`~/.claude/skills/*/SKILL.md`). A finding like "for short scheduled `claude -p` jobs, pass
`--model haiku`" should update the relevant workflow skill, and a finding that contradicts
what a skill currently says should correct it. Today that loop is manual and never happens.
The owned skills are also not under source control -- no history, diff, or review surface.

`skill-review` closes the loop: scan the logs, find entries that imply a concrete change to
an owned skill, propose the edits, deliver them through a git PR for review, and record what
was reviewed so the same finding is not re-surfaced every run.

## Locked decisions (do not relitigate)

1. Input = global agent-logs topic files AND per-project `LEARNINGS.md`.
2. Tracking = a separate `state.json` (the log files are never modified).
3. Edits are reviewed, never blind auto-applied to `main`.
4. Manual trigger only (`/skill-review`); no schedule/hook in v1.
5. Owned skills are versioned in a dedicated, skills-only private git repo (`git init` in
   `~/.claude/skills`). Secrets and eval scaffolding are excluded.
6. Two modes, both delivering via a branch + PR (never a direct `main` commit):
   - Interactive (default): propose edits one at a time; the human accepts/rejects each;
     accepted edits go into the PR.
   - Autonomous (`--auto`): best-effort auto-selection behind hard eligibility rules; opens
     a PR for the human to review later. No in-chat prompts.

Already-acknowledged limitation (not a finding): a PR later closed unmerged is not
auto-re-surfaced in v1; `prNumber` is stored and `--all` re-considers everything.

## Scope

In scope (v1): read global + project findings; match against owned skills only; deliver
edits as a PR (interactive or autonomous) with a per-commit secret scan, preimage
verification, and redaction before display/commit/PR; track reviewed entries in
`state.json`. Flags: `--auto`, `--all`, `--global-only`, `--in-place` (explicit no-PR
escape hatch). Combinable.

Out of scope (v1): plugin skills (`~/.claude/plugins/**`) are never read or written;
creating new skills (that's `skill-creator`); skill evals / wholesale description rewrites;
scheduled/hook runs; auto-merging PRs; re-checking prior PR status; writing back to the
agent-logs files.

## Secret handling (applies everywhere)

Secrets must never be committed, pushed, displayed in a proposal, or written into a commit
message / PR body. Two gates:

- **Setup gate:** scan all to-be-tracked files before the very first commit (below).
- **Per-commit gate (every run):** before any `git commit` skill-review makes, scan the
  staged diff (and the commit message + PR title/body) with the pattern set below. Any hit
  blocks the commit/push and is surfaced to the user; the run does not proceed to push.

**Secret pattern set (maintained literal list):**
`sk-`, `sk-proj-`, `sk-ant-`, `ghp_`, `gho_`, `github_pat_`, `npm_`, `sbp_`, `whsec_`,
`xox[baprs]-`, `AIza`, `AKIA`, `ASIA`, bearer/`Authorization:` header values,
`-----BEGIN [A-Z ]*PRIVATE KEY-----` blocks, JSON fields `"private_key"`/`"client_secret"`/
`"refresh_token"`, and `=`-assigned values on lines containing `SECRET`/`TOKEN`/`PASSWORD`/
`API_KEY`.
**Credential filename globs (blocked from staging):** `.env`, `.env.*`, `.npmrc`,
`credentials.json`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`,
`*.corrupt.*`.

## Source control (one-time setup)

A prerequisite the implementation performs once.

- `git init` in `~/.claude/skills`, default branch `main`. (`~/.claude` is local, NOT
  OneDrive-synced; `.credentials.json` and other secrets live in `~/.claude`, OUTSIDE
  `~/.claude/skills`, so they are not in this repo's tree -- but the scans above are still
  the real gate.)
- **`.gitignore`** (real skills only + defensive credential rules):
  ```
  # eval scaffolding + runtime
  *-workspace/
  state.json
  state.json.lock
  *.corrupt.*
  test-fixtures/
  # defensive credential / secret artifacts (scan is the real gate)
  .env
  .env.*
  .npmrc
  credentials.json
  *.pem
  *.key
  *.p12
  *.pfx
  id_rsa*
  id_ed25519*
  # OS cruft
  .DS_Store
  Thumbs.db
  ```
- **Setup secret scan** (pattern set above) over to-be-tracked files; stop and surface any
  hit before committing.
- Create a private repo: `gh repo create khe618/claude-skills --private --source . --remote
  origin --push`, push `main`.

## Owned-skill discovery

Canonical rule: a directory is an owned, editable skill iff `~/.claude/skills/<name>/SKILL.md`
exists exactly one level deep AND `<name>` does not end in `-workspace`. Implementation: glob
the single level `~/.claude/skills/*/SKILL.md` (non-recursive), drop parents ending in
`-workspace`; as a safety net skip any matched path containing a
`sandbox`/`iteration-*`/`with_skill`/`without_skill`/`pristine`/`.backup-*` segment. One
rule, one glob. `~/.claude/plugins/**` excluded from all phases. Discovery runs each
invocation.

## Input: log entries

Sources: (1) global `~/.claude/agent-logs/*.md`; (2) project `**/LEARNINGS.md` under
`C:\Users\khe61\OneDrive\Documents\CS Programs` (skipped when `--global-only`), excluding
`node_modules`, `.git`, `.next`, `dist`, `build`, `out`, `coverage`, `.venv`/`venv`/`env`,
`__pycache__`, `.cache`, `*-workspace`, `sandbox`.

Parsing: normalize CRLF/CR to LF; split entries on `^## (\d{4}-\d{2}-\d{2})\b(.*)$` (anchor
on the date, separator-agnostic); ignore the header block above the first dated heading; an
entry runs to the next dated `##` or EOF (so it includes appended `**Update YYYY-MM-DD:**`
notes). Legacy files (no dated `##`): one whole-file entry, title slug `whole-file`, hash of
the entire file. Never reformat the source.

Entry identity: `logicalSource` = `global:<filename>` or
`project:<relative-path-from-workspace-root>` (forward-slashed, lowercased; absolute path
kept separately for display). `key` = `<logicalSource>|<date or "nodate">|<title-slug>`.
`hash` = SHA-256 of the full entry body (post-normalization). Logical keys survive path
churn; the hash makes a changed entry re-surface.

## State file

Path: `~/.claude/skills/skill-review/state.json` (gitignored; local machine state). A lock
file `state.json.lock` guards the whole run.

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

Outcome statuses:
- `applied` -- >=1 edit accepted and **included in PR `prNumber`** (recorded only after the
  PR URL exists). Per-skill split in the `*Skills` arrays.
- `declined` -- proposals existed but the human accepted none (resolved; won't nag).
- `irrelevant` / `already-covered` -- no edit; resolved.
- `new-skill-candidate` -- useful but no owned skill fits (a `skill-creator` job).
- `needs-human-review` -- autonomous mode judged it potentially useful but not eligible for
  auto-apply (ambiguous/stylistic, or a frontmatter change). **Live candidate** -- stays a
  candidate so a later interactive run surfaces it.
- `conflict` -- an accepted edit's target text no longer matched at apply time. Live.
- `error` -- evaluation/commit/push/PR failed before resolution. Live.

Candidate selection: an entry is a candidate iff any of -- key absent; stored hash differs;
stored status is `new-skill-candidate` AND `catalogFingerprint` changed; status is
`needs-human-review`/`conflict`/`error`; or `--all`. `catalogFingerprint` hashes skill
names PLUS each `SKILL.md` frontmatter description, so a rewritten/renamed skill re-surfaces
deferred candidates even if names are unchanged.

`--all` bypasses the candidate filter only; never wipes `entries`. Prior outcomes are
overwritten only for entries that receive a new explicit outcome this run.

Robustness: missing -> empty; corrupt -> copy to `state.json.corrupt.<UTC-ts>`, warn,
proceed empty; permission/IO error -> abort. Writes are temp-file-then-rename. The run
acquires `state.json.lock` first; if already held, abort ("another skill-review run is in
progress") to prevent concurrent runs racing state or branches.

## Workflow

### Common (both modes)

1. **Parse args** -- `--auto`, `--all`, `--global-only`, `--in-place`. Default = interactive
   with PR.
2. **Acquire lock** (`state.json.lock`); abort if held.
3. **Repo preflight.**
   - Require `~/.claude/skills` to be a git repo with an `origin` remote and `gh` authed.
     If any is missing: abort with setup guidance -- UNLESS `--in-place` was passed, which is
     the explicit, clearly-labeled "apply to working tree, no branch, no PR, no review
     surface" escape hatch (it still runs preimage + redaction + secret scans per edit, but
     the user has opted out of review).
   - **Interrupted-run recovery:** if the current branch is a `skill-review/*` branch with
     uncommitted changes, treat it as a crashed prior run: offer to (a) commit + PR the
     leftover edits, (b) discard them (`git checkout -- .` / delete branch), or (c) abort.
   - **Dirty tree on `main` (or any non-`skill-review/*` branch):** abort, ask the user to
     commit/stash -- do not entangle unrelated changes.
4. **Build the owned-skill catalog.** Glob owned skills; read each full `SKILL.md` (~10
   skills, so no heading-only index -- avoids false no-match). Compute `catalogFingerprint`.
   No owned skills -> report and exit (release lock).
5. **Collect + identify candidates.** Read in-scope logs, parse, compute key+hash, load
   state, apply candidate selection. Zero candidates -> "Nothing new since last run (<N>
   already reviewed)." exit (refresh `lastRun`/`catalogFingerprint`, release lock).
6. **Match + redact + draft.** For each candidate: redact first (secret pattern set;
   guidance not raw secrets/paths); judge against the full catalog -- a finding qualifies if
   it **contradicts** quoted current skill text (stale/wrong) or **adds a concrete,
   actionable item absent from the skill** (a command, flag, or gotcha); classify
   non-proposals as `irrelevant`/`already-covered`/`new-skill-candidate`; draft the smallest
   edit that captures a qualifying finding; tag `[description change]` if it touches
   frontmatter/trigger.
7. **Open a working branch** (skip only in `--in-place`): `git checkout main; git fetch
   origin; git merge --ff-only origin/main`. If `main` has diverged from `origin/main`
   (non-ff), abort with guidance (don't branch off stale/divergent main). Then create
   `skill-review/<YYYY-MM-DD>-<shortid>`; on name collision append a counter.

### Interactive mode (default)

8i. **Present one edit at a time.** For each proposed edit, show: source finding
   (logicalSource + date + title), target (`<skill>` -> section, `[description change]` tag),
   one-line why, exact redacted diff. Prompt one of:
   - `accept` -- apply now (preimage verify), edit is queued for the PR.
   - `reject` -- resolved; the finding's entry will be recorded `declined` (won't re-surface
     unless its content changes).
   - `skip` -- unresolved; record NO outcome, so it stays a live candidate next run.
   - `accept-all-remaining` / `stop` escape hatches. `stop` = stop presenting; already-
     accepted edits proceed to commit/PR; not-yet-decided entries are treated as `skip`
     (live). Confirm before `stop` discards nothing -- it only ends the presentation loop.
9i. **Finish** (see Finalize). If 0 accepted: no commit; delete the empty branch; entries are
   `declined`/`skip` as chosen.

### Autonomous mode (`--auto`)

8a. **Hard eligibility (auditable, no subjective bar).** Auto-apply an edit ONLY if it meets
   one of:
   - (a) **Exact contradiction:** the finding directly contradicts a specific sentence in the
     target `SKILL.md` (the conflicting current text is quoted in the PR body), or
   - (b) **Concrete absent item:** the finding supplies a specific command, flag, path-shape,
     or gotcha that is verifiably not present in the target `SKILL.md`.
   **Never** auto-apply frontmatter/description/trigger changes. Anything else that looks
   useful -> `needs-human-review` (live candidate), listed in the PR body. Apply eligible
   edits (preimage verify).
9a. **Finish** (see Finalize). PR body has two sections: "Applied" (each edit + quoted source
   + for (a) the contradicted text) and "Deferred for human review" (the
   `needs-human-review` + `new-skill-candidate` items). If nothing eligible: no branch/PR;
   report; deferred items remain live candidates.

### Finalize (both modes)

- **Preimage verification, every edit:** re-read the target `SKILL.md`, confirm the proposed
  old text occurs exactly once; if missing/duplicated, skip the edit and mark the source
  entry `conflict` (live). Apply the exact-string edit; confirm the result matches the diff.
- **Atomic commit/push/PR ordering.** Stage edits; run the **per-commit secret scan** over
  the staged diff + commit message + PR title/body (abort the push on any hit). Commit ->
  `git push -u origin <branch>` -> `gh pr create --base main`. Record `applied` (with
  `prNumber`, `branch`) **only after `gh pr create` returns a PR URL**. If push or PR
  creation fails: do NOT mark `applied`; mark the affected entries `error`; **preserve the
  branch** (committed work is not lost) and print recovery instructions (branch name + how to
  retry/PR manually). Never delete a branch that has commits on a failure path.
- **Update state -- only for fully-resolved entries.** Write `{ hash, displayPath,
  reviewedAt, mode, outcome }` per resolved key. `skip`/`needs-human-review`/`conflict`/
  `error` stay live (recorded as such where applicable, or left absent for pure `skip`).
  Refresh `lastRun`/`catalogFingerprint`; temp-file-then-rename; release the lock.
- **Report.** One ASCII summary line:
  `Scanned <N> | new/changed <C> | edits <P> across <S> skills | applied <A> | declined <D> | already-covered <AC> | new-skill-candidate <NC> | needs-human-review <HR> | irrelevant <I> | conflict <CF> | PR <url-or-none>.`
  Then one line per applied edit: `[applied] <skill>: <one-line> (from <logicalSource> <date>)`.

## Components

Prose-driven `SKILL.md` (like `agent-logs`, `task-manage`): semantic matching, drafting,
redaction, and eligibility judgment are reasoning the agent does directly; parsing, hashing,
state I/O, secret scanning, and git/`gh` calls run inline via Read/Edit/Bash. No standalone
program, no new deps.

- `SKILL.md` -- the workflow as agent instructions, with discovery, parsing, state schema,
  secret pattern set, redaction checklist, mode logic, git/PR steps, and proposal format
  inlined.
- `state.json` + `state.json.lock` -- runtime, gitignored.
- `spec.md` -- this document.

Hashing via the Bash tool (Git Bash; `sha256sum`, fallback `git hash-object --stdin` or
PowerShell `Get-FileHash -Algorithm SHA256`). Inputs LF-normalized.

## Error handling / edge cases (summary)

- No repo / no remote / `gh` unauthed -> abort with setup guidance (both modes), unless
  `--in-place` (explicit, no review surface).
- Interrupted prior run (leftover `skill-review/*` branch, uncommitted) -> recovery prompt.
- Dirty tree on main -> abort, commit/stash.
- Stale/divergent main (non-ff vs origin) -> abort before branching.
- Concurrent run (lock held) -> abort.
- Corrupt state -> backup + warn + empty; state IO error -> abort.
- Secret detected (setup, per-commit, or a draft) -> block; never commit/display a secret.
- No candidates / no owned skills -> report and exit.
- Legacy/malformed log file -> single `whole-file` entry; never reformat.
- Finding matches multiple skills -> one edit per skill; structured per-skill outcome.
- Push/PR failure after commit -> `error`, branch preserved with recovery message.
- Update appended to a reviewed entry -> re-surfaces. New/rewritten skill -> fingerprint
  change re-surfaces `new-skill-candidate`/`needs-human-review`.
- Target text changed before apply -> `conflict`, live.
- Plugin skills -> never read or written.

## Testing / verification

Against fixtures, never the real durable logs:
1. `test-fixtures/` (gitignored) with a sample topic file + `LEARNINGS.md` covering: a
   finding mapping to an owned skill, a contradiction, an already-covered, a
   new-skill-candidate, a legacy (undated) entry; a fixture skill to edit; a planted fake
   token (setup-scan test) AND a fixture edit that introduces a fake token (per-commit-scan
   test).
2. Setup: `.gitignore` keeps `state.json`/`*-workspace/`/`test-fixtures/`/credential globs
   out of `git status`; setup secret scan flags the planted token.
3. Per-commit secret scan: a run whose accepted edit introduces a fake token is blocked
   before push.
4. Interactive dry run: correct discovery (excludes `*-workspace` + plugins); correct parsing
   of both fixtures; one-at-a-time accept/reject/skip; reject-all -> branch deleted, no PR,
   entries `declined`; skip leaves entries live; state records resolved entries.
5. Interactive apply: accept one edit -> ff to origin/main, branch + PR with only that edit;
   state records `applied` with `prNumber`/`branch`. Preimage: hand-edit the anchor then
   re-accept a stale proposal -> `conflict`, no write.
6. Autonomous (`--auto`): no prompts; only (a)/(b)-eligible edits applied; frontmatter change
   NOT auto-applied (-> needs-human-review); PR has Applied + Deferred sections; ambiguous
   findings stay live candidates.
7. Failure paths: simulate push/PR failure -> entries `error`, branch preserved, recovery
   message printed, not marked applied. Lock held -> second concurrent run aborts.
   Stale/divergent main -> abort. `--in-place` -> applies to working tree, no branch/PR,
   clearly labeled.
8. Idempotency / change detection / `--all` / `--global-only` as before.

Success = the loop runs end-to-end on the real logs, proposes at least the obviously-
applicable findings (e.g. `--model haiku` -> a scheduling/`claude -p` skill), delivers them
as a reviewable PR in the new private repo, never touches plugin skills, never commits a
secret (setup OR per-commit), records `applied` only after a real PR URL, and stays quiet on
the second run.

## Open questions

None blocking. Exact arg-parsing, the PR-body template, and the precise redaction/secret
regexes are implementation details for the plan (the pattern set above is the contract they
must satisfy).
