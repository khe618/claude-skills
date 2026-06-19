# skill-review Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `skill-review` skill that scans agent-logs findings, proposes edits to the user's owned skills, and delivers them as a reviewable git PR — and put the owned skills under source control.

**Architecture:** A prose-driven `SKILL.md` (the agent follows it directly, like `agent-logs`/`task-manage`) backed by a new private git repo at `~/.claude/skills`. No standalone program, no new dependencies; parsing, hashing, state I/O, secret scanning, and git/`gh` calls run inline via Read/Edit/Bash. The full behavioral contract is the spec at `~/.claude/skills/skill-review/spec.md` — it is the source of truth; this plan operationalizes building it.

**Tech Stack:** Markdown (`SKILL.md`), Git + GitHub CLI (`gh`), Git Bash (`sha256sum`, `grep`), JSON (`state.json`).

## Global Constraints

(Every task implicitly includes these. Values copied verbatim from the spec.)

- **All shell blocks in this plan are Git Bash** (POSIX), run via the Bash tool — not PowerShell. Paths with `~` expand; quote any path containing spaces.
- **Source of truth:** the spec at `~/.claude/skills/skill-review/spec.md`. Read it before authoring.
- **Owned skills only.** Never read or write anything under `~/.claude/plugins/**`, in any phase.
- **Owned-skill discovery:** glob `~/.claude/skills/*/SKILL.md` (single level); drop parents ending in `-workspace`; skip paths containing `sandbox`/`iteration-*`/`with_skill`/`without_skill`/`pristine`/`.backup-*`.
- **Secret-scan gate before EVERY commit** (the canonical scan is defined once below; setup uses the content+filename variant, all later commits use the added-lines variant). Never commit, push, or display a secret.
- **ASCII operational literals.** Regexes, commit/PR templates, the report line, and status names are plain ASCII.
- **Delivery:** at runtime both modes use a branch + PR; never a direct `main` commit, except the explicit `--in-place` flag. (Building the skill in this plan commits to `main` normally — that's authoring, not runtime.)
- **Hashing:** Git Bash `sha256sum`; fallback `git hash-object --stdin`. LF-normalize inputs.
- **State statuses (exact):** `applied | declined | irrelevant | already-covered | new-skill-candidate | needs-human-review | conflict | error`.
- **Flags (exact):** `--auto`, `--all`, `--global-only`, `--in-place`.

## Canonical secret scan (referenced by every commit step)

The pattern families use length floors so bare documented prefixes (e.g. `ghp_`, `sk-ant-`)
and regex-form documentation (e.g. `-----BEGIN [A-Z ]*PRIVATE KEY-----`, the JSON field
names without a trailing colon) do NOT match — only real-shaped values do. Save these as
two shell helpers the steps below call.

**`SECRET_RE`** (one extended-regex string):
```
ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(proj-|ant-)?[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,}|sbp_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|A[KS]IA[A-Z0-9]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----|[Aa]uthorization:[[:space:]]*[Bb]earer[[:space:]]+[A-Za-z0-9._-]{20,}|"(private_key|client_secret|refresh_token)"[[:space:]]*:|(SECRET|TOKEN|PASSWORD|API_KEY)[A-Za-z0-9_]*[[:space:]]*=[[:space:]]*[^[:space:]]{12,}
```

**`CRED_GLOB_RE`** (staged path names that must never be committed):
```
(^|/)(\.env(\..*)?|\.npmrc|credentials\.json|.*\.(pem|key|p12|pfx)|id_rsa.*|id_ed25519.*)$
```

- **Setup variant (initial commit, full content):**
  ```bash
  cd ~/.claude/skills
  git ls-files --cached | grep -E "$CRED_GLOB_RE" && { echo "BLOCK: credential filename staged"; exit 1; }
  git diff --cached | grep '^+' | grep -nE "$SECRET_RE" && { echo "BLOCK: secret in staged content"; exit 1; }
  echo "SECRET-SCAN CLEAN"
  ```
- **Per-commit variant (added lines + messages):** same as above but also scan the proposed
  commit message and any PR title/body text with `grep -nE "$SECRET_RE"`. Only added (`^+`)
  lines are scanned, so deleting an existing secret never blocks a cleanup commit.

On any `BLOCK:` the run stops, shows the offending file/line to the user, and does not
commit or push until resolved (unstage, `.gitignore`, or redact).

---

### Task 1: Initialize the skills git repo + push private remote

**Files:**
- Create: `~/.claude/skills/.gitignore`
- Repo: `git init` in `~/.claude/skills`; remote `origin` = `khe618/claude-skills` (private)

**Interfaces:**
- Produces: a git repo at `~/.claude/skills` on branch `main` with an `origin` remote; the existing `skill-review/spec.md` and `skill-review/plan.md` get tracked in the initial commit. Later tasks and runtime rely on this repo existing.

- [ ] **Step 1: Detect existing repo (idempotent).**

```bash
git -C ~/.claude/skills rev-parse --is-inside-work-tree 2>/dev/null && echo "ALREADY-REPO" || echo "NOT-REPO"
```
If `ALREADY-REPO`: skip Steps 3-4's init, go to Step 2 then jump to staging. If `NOT-REPO`: continue normally.

- [ ] **Step 2: Write `.gitignore`** with exactly this content:

```
# eval scaffolding + runtime
*-workspace/
state.json
state.json.lock
*.corrupt.*
test-fixtures/
# verification throwaways (Task 4) -- never commit to main
zzfixture-*/
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

- [ ] **Step 3: Init (with old-Git fallback) and stage.**

```bash
cd ~/.claude/skills
git rev-parse --is-inside-work-tree 2>/dev/null || { git init && git branch -M main; }
git add -A
```

- [ ] **Step 4: Verify `.gitignore` actually ignores the right things** (with sentinels, via `git check-ignore`).

```bash
cd ~/.claude/skills
mkdir -p sample-workspace && touch sample-workspace/x state.json zzfixture-x.md
git check-ignore state.json sample-workspace/x zzfixture-x.md && echo "IGNORE-OK" || echo "IGNORE-FAIL"
rm -rf sample-workspace state.json zzfixture-x.md
```
Expected: `IGNORE-OK` (all three are ignored). If `IGNORE-FAIL`, fix `.gitignore` before continuing.

- [ ] **Step 5: Secret-scan the staged tree (HARD GATE — setup variant).** Run the setup-variant scan from "Canonical secret scan." Expected final line: `SECRET-SCAN CLEAN`. Any `BLOCK:` stops the task.

- [ ] **Step 6: Initial commit.**

```bash
cd ~/.claude/skills
git commit -m "chore: put owned Claude skills under source control"
```

- [ ] **Step 7: Create the private repo and push (idempotent).**

```bash
cd ~/.claude/skills
if gh repo view khe618/claude-skills >/dev/null 2>&1; then
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/khe618/claude-skills.git"
  git push -u origin main
else
  gh repo create khe618/claude-skills --private --source . --remote origin --push
fi
```
If the name is taken by an unrelated repo, use `khe618/claude-skills-2` and adjust the remote URL accordingly.

- [ ] **Step 8: Verify remote + visibility.**

```bash
gh repo view khe618/claude-skills --json name,visibility,isPrivate
git -C ~/.claude/skills status --short
git -C ~/.claude/skills log --oneline -1
```
Expected: `"isPrivate":true` (visibility PRIVATE); clean status; the initial commit shown.

---

### Task 2: Author `SKILL.md`

**Files:**
- Create: `~/.claude/skills/skill-review/SKILL.md`

**Interfaces:**
- Consumes: the spec at `~/.claude/skills/skill-review/spec.md` (full behavioral contract).
- Produces: the invokable `/skill-review` skill. Frontmatter `name: skill-review`; the body is the workflow the agent follows.

- [ ] **Step 1: Read the spec in full** (`~/.claude/skills/skill-review/spec.md`). It is the source of truth; the SKILL.md restates it as second-person agent instructions.

- [ ] **Step 2: Write the frontmatter** verbatim:

```markdown
---
name: skill-review
description: Review durable findings from the agent-logs system (global ~/.claude/agent-logs/*.md topic files and per-project LEARNINGS.md) and propose edits to the user's own editable skills under ~/.claude/skills/*/SKILL.md, delivered as a reviewable git PR. Never touches plugin skills under ~/.claude/plugins/. Use when the user types /skill-review, or asks to "review my skills against the logs", "update skills from learnings", "fold agent-logs findings into skills", "feed my learnings back into skills", or to do a skills maintenance pass. Two modes: interactive (default, propose edits one at a time) and autonomous (--auto, best-effort auto-select then open a PR). Flags: --auto, --all, --global-only, --in-place.
---
```

- [ ] **Step 3: Write the body** as agent instructions, one section per spec section, in this order. Copy the literal blocks (the canonical secret scan / `SECRET_RE` / `CRED_GLOB_RE`, the `.gitignore` reference, the `state.json` schema, candidate-selection rules, the report line, the eligibility rules, the edge-case list) VERBATIM from the spec / this plan so they stay byte-identical. When documenting the secret patterns, keep them in regex form / bare prefixes (as in the spec) so the skill's own text does not self-trip the scanner:
  1. **Purpose & when to run** (interactive vs autonomous; the four flags).
  2. **Owned-skill discovery** (the canonical glob rule; plugins never touched).
  3. **Input: log entries** (sources; the `^## (\d{4}-\d{2}-\d{2})\b(.*)$` parser; CRLF normalize; legacy whole-file rule; entry identity: `logicalSource`/`key`/`hash`).
  4. **State file** (the JSON schema verbatim; the 8 statuses with semantics; candidate selection; `--all`; robustness; `state.json.lock`).
  5. **Secret handling** (setup gate + per-commit gate; `SECRET_RE` + `CRED_GLOB_RE` verbatim; redact-before-display).
  6. **Workflow Common steps 1-7** (parse args; acquire lock; repo preflight incl. interrupted-run recovery + dirty-tree abort + `--in-place`; build catalog + `catalogFingerprint` = names + frontmatter descriptions; collect candidates; match+redact+draft with the qualify rule; open branch with `git merge --ff-only origin/main` guard).
  7. **Interactive mode** (one-at-a-time present; `accept`/`reject`/`skip`/`accept-all-remaining`/`stop` semantics exactly as in the spec).
  8. **Autonomous mode** (hard eligibility (a) exact contradiction / (b) concrete absent item; never frontmatter; `needs-human-review` for the rest; PR Applied + Deferred sections).
  9. **Finalize** (preimage verify each edit; atomic commit -> push -> `gh pr create`; record `applied` only after the PR URL; failure -> `error` + preserve branch + recovery message; update state for resolved entries only; release lock; the verbatim report line + per-edit lines).
  10. **Error handling / edge cases** (the verbatim summary list).

- [ ] **Step 4: Consistency self-check** against the spec.

```bash
grep -nE 'TODO|TBD|FIXME|placeholder' ~/.claude/skills/skill-review/SKILL.md || echo "NO PLACEHOLDERS"
grep -c 'plugins/' ~/.claude/skills/skill-review/SKILL.md
```
Expected: `NO PLACEHOLDERS`; the only `plugins/` mentions are the "never touch `~/.claude/plugins/`" exclusions (read each hit to confirm none is a read/edit path). Manually verify the 8 status names, 4 flags, the state path, the parser regex, and the report line are byte-identical to the spec.

- [ ] **Step 5: Secret-scan, then commit.** Stage `SKILL.md`, run the per-commit-variant scan (added lines + the commit message). Expected `SECRET-SCAN CLEAN`, then:

```bash
cd ~/.claude/skills
git add skill-review/SKILL.md
git commit -m "feat: add skill-review skill"
git push
```

---

### Task 3: Stage temporary verification fixtures (in the real read-paths)

Fixtures live where the skill actually reads, so verification exercises the real discovery
glob and real log-parsing. They use a `zzfixture` prefix (gitignored inside the repo;
outside the repo for agent-logs) and are DELETED in Task 4's cleanup. Create them at the
start of verification, not before.

**Files (all temporary):**
- Create: `~/.claude/skills/zzfixture-demo/SKILL.md` (a real top-level dir so discovery sees it; gitignored via `zzfixture-*/`)
- Create: `~/.claude/agent-logs/zzfixture.md` (temp global topic file with dated entries)
- Create: `~/.claude/agent-logs/zzfixture-legacy.md` (temp file, NO dated headings -> whole-file entry)

**Interfaces:**
- Produces: a controlled corpus covering every classification path. Consumed by Task 4; removed by Task 4 Step C3.

- [ ] **Step 1: Create the fixture skill** `~/.claude/skills/zzfixture-demo/SKILL.md`:

```markdown
---
name: zzfixture-demo
description: A throwaway fixture skill used only to verify skill-review. Delete after verification.
---

# zzfixture-demo

This skill always uses Opus.

It already documents that callers should run it inside a git repo.

## Usage

Run it with no flags.
```

- [ ] **Step 2: Create the dated fixture log** `~/.claude/agent-logs/zzfixture.md` (covers contradiction, concrete-absent, already-covered, irrelevant, new-skill-candidate):

```markdown
# LEARNINGS — zzfixture (TEMP, delete after verification)

---

## 2026-06-19 — zzfixture-demo should document the --fast flag

**Symptom / context:** zzfixture-demo never mentions a `--fast` flag that speeds it up.

**Fix / what to do next time:** zzfixture-demo should document that callers can pass `--fast`.

**Refs:** fixture (expect: concrete absent item -> proposed edit).

## 2026-06-19 — zzfixture-demo's "always uses Opus" line is wrong

**Symptom / context:** zzfixture-demo says it always uses Opus, but it defaults to Haiku.

**Fix / what to do next time:** Correct the sentence to say it defaults to Haiku.

**Refs:** fixture (expect: exact contradiction -> proposed edit).

## 2026-06-19 — zzfixture-demo should be run inside a git repo

**Symptom / context:** Noted that zzfixture-demo expects a git repo.

**Fix / what to do next time:** Document that it must run inside a git repo.

**Refs:** fixture (expect: already-covered -- the skill already states this).

## 2026-06-19 — a GIN index sped up a JSONB query in some app

**Symptom / context:** Unrelated DB tuning note.

**Fix / what to do next time:** Nothing for any owned skill.

**Refs:** fixture (expect: irrelevant).

## 2026-06-19 — a broadly useful idea with no owning skill

**Symptom / context:** Something useful that no current owned skill covers.

**Fix / what to do next time:** Worth a dedicated skill someday.

**Refs:** fixture (expect: new-skill-candidate).
```

- [ ] **Step 3: Create the legacy (undated) fixture log** `~/.claude/agent-logs/zzfixture-legacy.md`:

```markdown
A note with no dated heading at all. The parser must treat this whole file as one
whole-file entry and never reformat it.
```

- [ ] **Step 4: Confirm the fixture skill is gitignored but discoverable.**

```bash
git -C ~/.claude/skills check-ignore zzfixture-demo/SKILL.md && echo "IGNORED-OK"
ls ~/.claude/skills/zzfixture-demo/SKILL.md && echo "ON-DISK (glob will see it)"
```
Expected: `IGNORED-OK` (won't be committed to main) and `ON-DISK` (the discovery glob, which is filesystem-based not git-aware, still sees it).

---

### Task 4: End-to-end verification, then cleanup

Follow `SKILL.md` exactly. Every step must produce a CONCRETE ARTIFACT (a printed list, a
diff, a `state.json` snippet, a branch name, scan output, or command output) — not a
"would do X" assertion. On any mismatch, fix `SKILL.md` and re-run that step.

**Phase A — analysis on fixtures (no writes beyond a throwaway branch).**

- [ ] **A1: Discovery + parsing.** Run discovery and log-parsing per `SKILL.md`. Artifact: the printed list of discovered owned skills (must include `zzfixture-demo`, exclude every `*-workspace` dir, and include nothing under `~/.claude/plugins/`), and the parsed entry list (the 5 dated `zzfixture.md` entries + 1 `whole-file` entry from `zzfixture-legacy.md`). Expected: counts match.

- [ ] **A2: Classification.** Artifact: the per-entry classification. Expected: `--fast` -> proposed edit (concrete absent), "always uses Opus" -> proposed edit (exact contradiction), "run inside a git repo" -> `already-covered`, GIN index -> `irrelevant`, broadly-useful -> `new-skill-candidate`. The two proposed edits must be shown as exact redacted diffs against `zzfixture-demo/SKILL.md`.

**Phase B — full delivery path on a throwaway branch (real PR, never merged).**

- [ ] **B1: Interactive accept + preimage.** Create branch off `main` per `SKILL.md` (confirm the `git fetch` + `git merge --ff-only origin/main` guard runs). Walk one-at-a-time: `accept` the `--fast` edit, `reject` the Opus correction, `skip` nothing/other. Artifact: the applied working-tree diff on `zzfixture-demo/SKILL.md`; the branch name `skill-review/<date>-<id>`. Force-add the gitignored fixture skill for this throwaway branch only: `git add -f zzfixture-demo/SKILL.md`.

- [ ] **B2: Per-commit secret-scan gate.** Before committing B1, also stage a line containing a fake token — generate it without a literal in this plan: `printf 'ghp_%s\n' "$(printf 'A%.0s' $(seq 1 36))" >> ~/.claude/skills/zzfixture-demo/SKILL.md; git -C ~/.claude/skills add -f zzfixture-demo/SKILL.md`. Run the per-commit scan. Artifact: the scan output showing a `BLOCK:` hit. Then remove that line and re-stage. Expected: blocked while present, clean after removal.

- [ ] **B3: Commit -> push -> PR.** With a clean scan, commit, `git push -u origin <branch>`, `gh pr create --base main`. Artifact: the real PR URL. Confirm `state.json` records the finding `applied` with the real `prNumber`/`branch` ONLY now that a PR URL exists (per spec — no placeholder `applied`).

- [ ] **B4: Push-failure path.** On a second throwaway branch with a trivial edit, set a bad remote to force a push failure: `git remote set-url origin https://github.com/khe618/this-does-not-exist.git`, attempt push. Artifact: the failure output; confirm `SKILL.md`'s rule marks the entry `error`, preserves the branch, prints recovery text, and does NOT mark `applied`. Restore the remote: `git remote set-url origin https://github.com/khe618/claude-skills.git`.

**Phase C — guards, then cleanup.**

- [ ] **C1: Guards.** Produce each state and confirm the abort/notice:
  - Lock held: `touch ~/.claude/skills/skill-review/state.json.lock` -> run -> expect "another run in progress" abort -> `rm` it.
  - Dirty tree on main: `echo x >> ~/.claude/skills/skill-review/spec.md` -> run -> expect dirty-tree abort -> `git -C ~/.claude/skills checkout -- skill-review/spec.md`.
  - Non-ff main: simulate divergence (local commit on main not on origin, plus a differing origin) or reason with the exact `git merge --ff-only` failure output -> expect abort before branching.
  - `--in-place`: run with `--in-place` -> expect a working-tree edit, NO branch/PR, and a clear "no review surface" notice. Revert the edit after.

- [ ] **C2: Idempotency / change-detection / flags.** Second run, unchanged -> "Nothing new since last run." Append an `**Update**` to a `zzfixture.md` entry -> it re-surfaces. Add a dummy owned skill dir -> `catalogFingerprint` change re-surfaces the `new-skill-candidate` -> remove it. `--all` reconsiders without wiping outcomes. `--global-only` skips project `LEARNINGS.md`. Artifact: the report line for each.

- [ ] **C3: Cleanup the fixtures + throwaways (MANDATORY).**

```bash
cd ~/.claude/skills
# close the throwaway PR(s) and delete branches
gh pr list --head "skill-review/" --json number --jq '.[].number' | xargs -r -n1 gh pr close
git checkout main
git branch | grep skill-review/ | xargs -r git branch -D
git push origin --delete $(git ls-remote --heads origin 'skill-review/*' | sed 's#.*refs/heads/##') 2>/dev/null || true
# delete fixtures
rm -rf ~/.claude/skills/zzfixture-demo ~/.claude/agent-logs/zzfixture.md ~/.claude/agent-logs/zzfixture-legacy.md
git status --short
```
Expected: `git status` clean, no `zzfixture-*` on disk, no `skill-review/*` branches local or remote, throwaway PRs closed. Verify: `gh pr list --state open --json headRefName` shows no `skill-review/*`.

**Phase D — real-corpus smoke (state-isolated, read-only).**

- [ ] **D1: Back up real state, dry-run, restore.**

```bash
cp ~/.claude/skills/skill-review/state.json /tmp/skillreview-state.bak 2>/dev/null || echo "no prior state"
```
Invoke the real `/skill-review` (interactive) against the ACTUAL logs and skills; `reject`/`stop` everything (make no PR, accept no edit). Artifact: the discovered real owned-skill list (excludes `*-workspace` + plugins), the count of parsed real `~/.claude/agent-logs/*.md` entries, and at least one sensible real proposal (e.g. the `--model haiku` finding -> a scheduling/`claude -p` skill). Then restore:
```bash
cp /tmp/skillreview-state.bak ~/.claude/skills/skill-review/state.json 2>/dev/null || rm -f ~/.claude/skills/skill-review/state.json
```
Expected: a coherent real dry run; real `state.json` unchanged afterward.

- [ ] **D2: Commit any verification fixes.** If Phases A-D required `SKILL.md` edits, secret-scan (per-commit variant) then:

```bash
cd ~/.claude/skills
git add skill-review/SKILL.md
git commit -m "fix: skill-review verification fixes"
git push
```

---

## Notes for the executor

- Tasks 1, 2, and D2 commit to `main` directly — that is authoring the skill, not its runtime behavior (which uses PRs). Phase B's commits go on throwaway branches that are NEVER merged to `main` and are deleted in C3.
- Task 1 Step 7 (`gh repo create ... --push`) is the one persistent outward-facing action. The setup secret scan (Step 5) is a hard gate before it; surface the scan output before pushing.
- The fixture skill is force-added (`git add -f`) only on throwaway branches because it is gitignored; C3 guarantees it never reaches `main`.
- The spec (`spec.md`) is authoritative. If any step here conflicts with the spec, the spec wins — flag the discrepancy.
