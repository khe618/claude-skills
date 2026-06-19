---
name: sync-codex
description: Keep CLAUDE.md and AGENTS.md in sync and mirror skills between Claude Code (~/.claude) and Codex (~/.codex), with AGENTS.md as the single source of truth. Use this whenever the user asks to sync, align, mirror, or reconcile Claude and Codex — e.g. "sync codex", "keep my agents.md and claude.md in sync", "my CLAUDE.md and AGENTS.md have drifted", "mirror my Claude skills to Codex" (or vice versa), "translate this skill/instructions to Codex", or after editing a CLAUDE.md or AGENTS.md and wanting the counterpart updated. It recursively walks the workspace plus the global instruction files, classifies content as general / Codex-only / Claude-only, translates Claude-specific language to Codex equivalents and back, and always reports a plan before changing anything.
---

# sync-codex

Keep a project's Claude Code and Codex configuration aligned without flattening
the legitimate differences between the two runtimes.

**The model:** `AGENTS.md` is the source of truth. It holds the full canonical
instructions; `CLAUDE.md` imports it and adds only Claude-specific notes. Skills
in `~/.claude/skills/` and `~/.codex/skills/` are mirrored so each side has a
translated copy of the other's. Read `references/translation-map.md` once at the
start — it carries the vocabulary table, the `@import` pattern, the three-bucket
content split, and which skills don't port. The rest of this file is the
workflow.

## Operating principles

- **Translate, don't copy.** The two runtimes use different vocabulary, and some
  instructions are *correctly opposite* (shell behavior is the canonical
  example). "In sync" means semantically equivalent with each side phrased for
  its own runtime — never byte-identical, never one clobbering the other.
- **Report before writing.** This touches many files and the workspace root is
  not a git repo, so there's no undo. Produce a full plan, get an explicit OK,
  *then* apply — backing up every file you overwrite first.
- **Flag, don't clobber.** Only auto-create the file/skill that's missing on one
  side. Where both sides exist and have genuinely diverged in *meaning* (not just
  translation artifacts), report it and leave both alone for the user to settle.
- **Skip what can't port.** A skill whose purpose is a feature the other runtime
  lacks gets skipped and listed, not turned into a broken stub.

## Scope

Default scope (what the user picked): the **global** pair
(`~/.claude/CLAUDE.md` ↔ `~/.codex/AGENTS.md`), **every** `CLAUDE.md`/`AGENTS.md`
pair found recursively in the workspace repo, and the two skills directories. If
the user names a narrower target (one directory, one file, one skill), honor it.

## Workflow

Turn these phases into a todo list so nothing is dropped.

### 1. Scan

Run the inventory script — it does the recursive census reliably so you don't
walk the tree by hand:

```bash
python "<skill-dir>/scripts/scan.py" --workspace "C:/Users/khe61/OneDrive/Documents/CS Programs"
```

It prints JSON: the global pair, every instruction-file pair with a
`both`/`claude_only`/`codex_only` status, and every skill with the same status
plus whether the Codex side has `agents/openai.yaml`. Use it to know *what
exists*; you still read files yourself to judge *meaning*.

### 2. Reconcile instruction files (per pair, AGENTS.md is truth)

For each pair from the scan, including the global one, read whichever files
exist and decide the target end state described in the translation map (AGENTS.md
= canonical general + Codex-only notes; CLAUDE.md = `@import` of AGENTS.md +
Claude-only section). Then:

- **`both` exist** — Sort the *general* content into AGENTS.md as the canonical
  copy. Pull anything Claude-specific out of AGENTS.md (e.g. the workspace
  `AGENTS.md` currently says "use the Bash tool" and "Codex (Codex.ai/code)" —
  fix that). Rewrite CLAUDE.md as `@./AGENTS.md` + a Claude-only section. On a
  first run the richer content often lives in CLAUDE.md — **migrate that general
  content up into AGENTS.md before slimming CLAUDE.md** so nothing is lost.
  Where both files have general content on the same topic that genuinely
  *conflicts* (not just wording), flag it instead of silently picking one.
- **`claude_only`** — Create AGENTS.md from CLAUDE.md's general content
  (translated to Codex vocabulary), then rewrite CLAUDE.md as the import + its
  Claude-only section.
- **`codex_only`** — Create CLAUDE.md as `@./AGENTS.md` plus a Claude-only
  section (usually small; translate any Codex-only notes that have a Claude
  analogue, e.g. shell behavior).

The global pair is the highest-stakes and most judgment-heavy reconciliation
(the global `~/.claude/CLAUDE.md` is large and mostly Claude-specific). Show its
full proposed before/after in the plan, not just a summary.

### 3. Reconcile skills (bidirectional, flag don't clobber)

Using the skill pairs from the scan and the guidance in the translation map:

- **`both`** — Read both `SKILL.md` files. If they're equivalent modulo expected
  translation (invocation syntax, tool names, the `openai.yaml`), they're in
  sync — leave them. If they've **diverged in meaning** (e.g. `idea-capture`
  targets `IDEAS.md` on the Claude side but `ideas.md` on the Codex side, with
  reworked bodies), **flag it** and don't overwrite either.
- **`claude_only` / `codex_only`** — If the skill ports (see the map), create the
  translated counterpart: rewrite the body for the target runtime, convert
  invocation (`/name` ↔ `$name`) and tool names, and on the Codex side add
  `agents/openai.yaml`. If it doesn't port, **skip and list it**.
- **Probable name mismatch** (e.g. Claude `commit` vs Codex `git-commit`) — these
  are one skill under two names. Don't create a duplicate; flag the suspected
  pair and ask the user to confirm before treating them as synced.

### 4. Present the plan and wait

Lay out everything you intend to do, grouped, before touching anything:

```
## sync-codex plan

### Instruction files
- ~/.claude/CLAUDE.md + ~/.codex/AGENTS.md  → REWRITE both (global; full preview below)
- <dir>/CLAUDE.md (+ create AGENTS.md)      → CREATE AGENTS.md, slim CLAUDE.md
- ...

### Skills
- idea-capture        → FLAG: diverged (IDEAS.md vs ideas.md, reworked body)
- commit / git-commit → FLAG: likely the same skill, confirm pairing
- agent-logs          → CREATE on Codex side (translated)
- wakeup              → SKIP: Claude session cron, no Codex equivalent

### Backups
All overwritten files copied to <claude-home>/backups/sync-codex/<UTC-timestamp>/ first.
```

Include actual before/after content (or a diff) for rewrites — at minimum for
the global pair and any file being substantially restructured. Then stop:
"Reply `apply` to proceed, or tell me what to change." Do not write until the
user confirms.

### 5. Apply

After the OK: create the timestamped backup dir under
`<claude-home>/backups/sync-codex/<UTC-timestamp>/` (the real `~/.claude` by
default, or the fixture's claude-home when overridden), copy every file you're
about to overwrite into it (preserving enough path to disambiguate), then make
the edits.
Create new files and `agents/openai.yaml` as planned. Don't touch anything you
flagged for the user to decide.

### 6. Report

Summarize what was created, rewritten, backed up, flagged (still needs the
user), and skipped — with the backup path. Keep flags actionable so the user
knows exactly what's left to settle by hand.

## Notes

- The skill is parameterizable: if the user points you at a fixture directory or
  alternate homes, pass them to `scan.py` (`--workspace`, `--claude-home`,
  `--codex-home`, `--no-global`) and operate there instead of the real config.
- `~/.codex/skills/.system/` and any `*-workspace/` dirs are not user skills —
  the scan already excludes them; never sync them.
