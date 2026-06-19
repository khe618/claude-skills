---
name: agent-logs
description: Append durable findings — non-obvious bug fixes, tooling quirks, counterintuitive library/API behavior, anything that took real time to figure out and will plausibly bite again — to a two-tier log. Tier 1 (project-specific findings) goes to a per-subproject `LEARNINGS.md`; tier 2 (cross-project findings about Claude Code itself, OS/shell tooling, or third-party libraries) goes to a topic file under `~/.claude/agent-logs/`. Use this skill proactively the moment you've just (a) fixed a bug whose root cause was not obvious from the symptom, (b) confirmed a workaround for an external tool/library quirk, or (c) verified behavior that contradicts docs or comments. Also use when the user says any of these exact phrases or their close paraphrases — "log this", "log this learning", "save this learning", "remember this for next time", "add to LEARNINGS" — or types `/agent-logs`. The skill writes to the appropriate file; do not append by hand.
---

# /agent-logs

Capture findings the next session would otherwise rediscover the hard way. Two-tier storage: per-subproject `LEARNINGS.md` for project-specific findings, `~/.claude/agent-logs/<topic>.md` for cross-project findings (Claude Code itself, OS/shell tooling, libraries). This skill is autonomous — write directly, don't ask for approval.

## What belongs in LEARNINGS.md

Durable, cross-session knowledge that **isn't obvious from reading the code as it stands today**. Note the distinction: obvious-*in-code* (a function with a clear name and comment) does not belong; obvious-*in-retrospect* (something you only understood after the fix) does.

Concrete classes worth logging:

- **Non-obvious bug fixes** — the symptom didn't point at the cause (e.g., a timeout that was really a connection-pool exhaustion; an "undefined" error that was really an env var shadowed by OS-level config).
- **Tooling / environment quirks** — OneDrive syncing `node_modules` mid-build, Windows path length limits, PowerShell vs. Bash syntax surprises, per-project Node version pins, stale lockfiles, OS-specific behavior.
- **Counterintuitive library or API behavior** — verified, reproducible, contradicts docs or reasonable expectations. Not "a weird thing happened once"; "I confirmed by Y that it does X."
- **Schema-vs-code mismatches** discovered the hard way (e.g., column nullable in DB but treated as non-null in code).
- **Workarounds where the root cause is external** (vendor bug, OS bug, library issue). Log the workaround with evidence; mark the root cause as suspected/external/unknown.

## What does NOT belong

- Feature work, planned changes, normal commit context — that's PR descriptions and `git log`.
- In-progress task state — that's tasks, not memory.
- Anything that would be obvious from reading the current code with a careful eye.
- Transient one-off oddities you couldn't reproduce.
- Findings about secrets, tokens, internal URLs, absolute local paths with usernames, account/customer identifiers, raw stack traces, or proprietary service details — redact or skip. This file lives on disk (often sync'd or checked-in).

## When to log without being asked

The moment-of-discovery is when the context is freshest, and the user has explicitly delegated the call to this skill. Don't ask, don't pause to confirm — just write. Ground the decision in **observable signals**, not vibes:

- Multiple hypotheses tried before the fix landed (>=2 distinct attempts), OR
- The fix touches a file whose connection to the symptom was non-obvious, OR
- The fix is a workaround (not a clean resolution), OR
- You found and verified behavior that contradicts docs, comments, or a reasonable prior, OR
- The user reacted with surprise ("oh weird", "huh", "that's annoying") AND the finding is reproducible.

If you're on the fence, write it. A slightly-noisy log is recoverable; missing the moment is not. Don't hesitate, don't second-guess the bar, don't ask the user whether it's "worth logging" — that's exactly the friction this skill is meant to remove.

## Workflow

1. **Pick the tier — project-specific or cross-project.**

   - **Tier 1 (project-specific):** the finding is rooted in *this* project's code, schema, config, or test setup. A different project couldn't benefit from reading it. Example: "in `timesheet/`, libsql connection strings must use `file:` prefix even for local files."

   - **Tier 2 (cross-project / global):** the finding generalizes — it's about Claude Code itself (hooks, skills, settings, transcript format, harness behavior), the OS / shell / package-manager / sync-tool environment, or a third-party library's counterintuitive behavior that any project could hit. Example: "Claude Code transcripts split each assistant content block into its own JSONL entry."

   **Default rules — apply without asking:**
   - Findings about Claude Code itself (hooks, skills, settings, plugins, agents, MCP servers, harness) → **always tier 2**, never tier 1, regardless of where the files live.
   - Files edited live inside `~/.claude/` → tier 2.
   - When genuinely unsure → prefer tier 2 (gets surfaced in more future sessions).

2. **Locate the file.**

   **Tier 1 (project-specific):**
   - Anchor on the files actually edited or debugged this session — not just the shell cwd.
   - Walk up from those files looking for the nearest manifest (`package.json`, `requirements.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.). That directory's `LEARNINGS.md` is the target.
   - If touched files span multiple sibling subprojects (e.g., a monorepo with `apps/web/` and `apps/api/`, or this workspace's case of editing across two top-level folders), **stop and ask** the user which subproject owns the finding — don't pick one silently.
   - If no manifest is found but a `CLAUDE.md` exists walking up, use `LEARNINGS.md` next to that `CLAUDE.md`. Catches one-off top-level scripts in workspaces.
   - If still no anchor found, the finding probably isn't really tier 1 — reclassify as tier 2.

   **Tier 2 (global):** pick a topic file under `~/.claude/agent-logs/`. Auto-resolve to one of:
   - `claude-code.md` — Claude Code itself (hooks, skills, settings, plugins, agents, transcript format, harness behavior, MCP servers, slash commands).
   - `tooling.md` — OS / shell / package manager / sync tool / editor quirks (Windows path limits, OneDrive syncing node_modules mid-build, PowerShell vs. Bash, npm/pnpm/yarn differences, Git on Windows).
   - `libraries.md` — counterintuitive behavior of third-party libraries / APIs / frameworks that's NOT tied to a single project's setup (e.g., Next.js cache invariants, a Python stdlib gotcha).
   - `general.md` — fallback when none of the above clearly fits.

   Create the directory and the file on demand. Use the new-file header template below, substituting an appropriate title (e.g. `# LEARNINGS — Claude Code (user-global)` for `claude-code.md`).

3. **Read the existing file** if it exists. Decide between three actions:
   - **New entry** — no existing entry shares the same root cause AND the same fix.
   - **Append a dated note under an existing entry** — same root cause OR same fix, with new information (a related symptom, an additional file, a clarification). Add as a `**Update YYYY-MM-DD:** …` line under the existing entry; do not rewrite the original text.
   - **Add a dated contradiction note** — when a new finding contradicts an existing entry, never overwrite. Add a `**Update YYYY-MM-DD:** contradicts above — …` line under the old entry with what you observed now. Future-you can reconcile when revisiting.

   "Related" means **same root cause OR same fix** — not just same library, same file, or similar-sounding symptom. Two bugs in the same module with different causes are two entries.

4. **Write the entry directly** using the format below. Use today's date in `YYYY-MM-DD`. Each section is one to three sentences; the file stays scannable. No draft-and-approve step — just append. Newest entries at the top, immediately under the header block. If the file is missing, create it with the header template below. If the file exists but doesn't match the template (no `# LEARNINGS` heading, no `---` delimiter), insert the new entry at the top of the file above all existing content, and leave the legacy structure alone — don't reformat someone else's file.

5. **Confirm in one line.** "Logged to `<path>`." Don't restate the entry; the file is right there if the user wants to read it.

## Entry format

```markdown
## YYYY-MM-DD — Short imperative title

**Symptom / context:** What you'd see, or what you were trying to do when it bit you. Concrete enough to be greppable.

**Root cause:** The non-obvious thing. If the cause is genuinely external or unknown, write "Root cause (suspected): …" or "Root cause: unknown — external library/OS/vendor" and rely on the Fix and Refs sections to carry the weight.

**Fix / what to do next time:** The resolution or workaround. Concrete and actionable.

**Refs:** `path/to/file.ext:line`, commit SHA, PR link, external doc — whatever lets future-you verify it's still true.
```

New-file header template:

```markdown
# LEARNINGS — <project name OR global topic>

Durable findings — past bug fixes, non-obvious behavior, tooling quirks. Add when something surprised us; read when starting work here. Newest entries at the top.

---
```

For tier 2 files, use the topic as the title:
- `claude-code.md` → `# LEARNINGS — Claude Code (user-global)`
- `tooling.md` → `# LEARNINGS — Tooling & environment (user-global)`
- `libraries.md` → `# LEARNINGS — Libraries & APIs (user-global)`
- `general.md` → `# LEARNINGS — General (user-global)`

## Edge cases — resolve autonomously

- **Tier 1 subproject is ambiguous (multi-project).** Touched files span multiple sibling subprojects in a monorepo or this workspace and the finding is genuinely tier 1. Pick the subproject where most of the touched files live; if it's a true tie, reclassify as tier 2 and write to the appropriate topic file. ("No manifest found anywhere above the touched files" is NOT ambiguous; reclassify as tier 2 and pick a topic file.)

- **Tier 2 topic is ambiguous.** Default to `general.md`. Topic files are easy to grep; mis-bucketing is recoverable, friction is not.

- **The finding is a bug that should be fixed, not documented.** Log it anyway — logging doesn't preclude fixing, and the log is useful while the fix is pending. If a fix is obviously the right move, mention it briefly to the user after writing.

- **The entry contains sensitive content.** Secrets, tokens, internal URLs, absolute paths containing usernames, account/customer identifiers, raw stack traces with environment details. Redact before writing. If redaction would gut the finding, skip silently — don't pull the user in to decide.

- **New finding contradicts an existing entry.** Never overwrite. Add a `**Update YYYY-MM-DD:** contradicts above — …` note under the old entry with the new observation. Future-you can reconcile on a revisit.

## Why these constraints

A `LEARNINGS.md` is only valuable if future-Claude trusts it enough to read it. The guardrails that remain — anchoring dedup on root cause, never overwriting old entries, redacting secrets — keep the file useful. The approval gate that used to live here was friction with no payoff: it caused entries to be skipped or never written, which is worse than a slightly-noisy log. Write directly, trust your judgment on the bar, and if a particular entry turns out to be noise, future-you can prune it.
