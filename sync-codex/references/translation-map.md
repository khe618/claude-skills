# Claude ↔ Codex translation map

Syncing is **not** copying. The two runtimes describe the same intent with
different vocabulary, and some instructions are genuinely runtime-specific and
must stay different. Use this map to translate, and to recognize what should
*not* be unified.

Direction is symmetric: when generating an AGENTS.md / Codex skill from a Claude
source, translate left→right; when generating a CLAUDE.md / Claude skill from a
Codex source, translate right→left.

## Vocabulary table

| Concept | Claude Code (CLAUDE.md / ~/.claude) | Codex (AGENTS.md / ~/.codex) |
| --- | --- | --- |
| Instructions file | `CLAUDE.md` | `AGENTS.md` |
| Self / product name | Claude, Claude Code | Codex |
| Doc URL in header | `claude.ai/code` | (drop it — Codex has no equivalent; write just "Codex") |
| Skill invocation | `/skill-name` | `$skill-name` |
| Skill metadata | `SKILL.md` frontmatter only | `SKILL.md` frontmatter **+** `agents/openai.yaml` |
| Run a shell command | "the Bash tool" | "the command/shell tool" |
| Edit files | "the Edit / Write tools" | "the apply-patch / file-edit tool" |
| Search | "the Grep / Glob tools" | "`rg` / `rg --files`" |
| Delegate work | "a subagent" / "the Task tool" | (Codex has no first-class subagents — describe the action plainly, e.g. "do X", and drop the tool name) |
| Permissions | `~/.claude/settings.json` allow-rules and hooks | `prefix_rule(...)` entries in `~/.codex/rules/*.rules`, `~/.codex/config.toml` |
| Model names | Opus / Sonnet / Haiku / Fable | (drop — these are Claude models; don't assert a Codex model) |

## Skill metadata: `agents/openai.yaml`

Codex skills carry an extra file `agents/openai.yaml` that Claude skills don't.
When **creating a Codex skill** from a Claude one, generate it from the skill's
frontmatter:

```yaml
interface:
  display_name: "Title Case Name"          # human-readable
  short_description: "One short line."       # ~8 words, what it does
  default_prompt: "Use $skill-name to ..."   # note the $ invocation
```

When **creating a Claude skill** from a Codex one, you do not need `agents/` —
Claude reads only `SKILL.md`. Drop it.

## Instruction-file end state (the model the user wants)

For every directory that has either file:

- **`AGENTS.md` = the source of truth.** It holds the full, canonical, general
  instructions written in tool-neutral or Codex-appropriate language, plus any
  **Codex-specific** notes.
- **`CLAUDE.md` = an import of AGENTS.md + a Claude-only section.** Claude Code
  auto-loads `CLAUDE.md` but not `AGENTS.md`, so a bare "see AGENTS.md" pointer
  would leave Claude without the general instructions. Use Claude Code's import
  syntax so the canonical content is actually pulled into context:

  ```markdown
  @./AGENTS.md

  <!-- General guidance lives in AGENTS.md (imported above), the single source
       of truth shared with Codex. Keep only Claude Code-specific notes below. -->

  ## Claude Code specifics

  - ...things that only make sense for Claude Code...
  ```

  For the **global** file use `@~/.codex/AGENTS.md` (the global Codex canonical).

## Three buckets — decide which one each piece of content is in

1. **General** → lives in `AGENTS.md`, imported by `CLAUDE.md`. Project layout,
   build/run/test commands, environment facts, "locate the project first",
   `LEARNINGS.md` / `IDEAS.md` conventions, coding conventions.
2. **Codex-specific** → `AGENTS.md` only. e.g. "use PowerShell-native commands",
   `prefix_rule` permission guidance, `npm.cmd` shims.
3. **Claude-specific** → `CLAUDE.md` "Claude Code specifics" section only.
   Anything naming a Claude-only feature: the Bash tool runs Git Bash, slash
   commands (`/commit`, `/loop`, `/pr`, `/wakeup`, `/code-review`),
   `superpowers:` skills, hooks, `PushNotification` / mobile notifications,
   plugin skills, `Co-Authored-By: Claude` trailers, model picks.

The classic tell that the two buckets are **opposite, not synced**: shell
behavior. Claude's Bash tool is Git Bash (POSIX) on this machine; Codex is told
to prefer PowerShell-native commands. Both are correct *for their runtime*.
Never overwrite one with the other — keep each in its own bucket.

## Skills with no clean cross-runtime equivalent → skip & report

Don't force a broken port. If the skill's whole purpose is a feature the other
runtime lacks, skip it and list it in the report. Judge by purpose, not name:

- **Claude-only in practice:** `wakeup` (Claude session cron), `pr` (assumes the
  `gh`/Claude PR flow), thin wrappers that *only* re-expose a `superpowers:`
  skill, hook-driven skills. (Note: superpowers loads on both runtimes, so a
  skill that merely *uses* superpowers steps still ports — see `implement-task`
  below. Only pure wrappers are Claude-only.)
- **Codex-only in practice:** skills built around `~/.codex` internals.
- **Ports cleanly (translate language):** `commit` ↔ `git-commit`,
  `idea-capture`, `agent-logs`, `playwright`, `task-manage` / `implement-task`,
  and most content/workflow skills. The `task-manage` (producer) /
  `implement-task` (consumer) pair operates on a project-local `TASKS.md`, not
  `~/.codex` internals, so both port; they share one `tasks-md-contract.md`
  reference (in the `task-manage` skill) that defines the file format on each
  side — translate the skill bodies, keep the contract content equivalent.

## Name mismatches are pairs, not duplicates

The same skill can have different names per runtime (`commit` vs `git-commit`).
Treat a probable semantic match under different names as a **pair to confirm**,
not two separate skills to create. Flag it for the user; don't silently create a
`commit/` on the Codex side next to its existing `git-commit/`.
