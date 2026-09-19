# jev-stop-nudge: a Jev-graded Stop hook for Claude Code

Date: 2026-09-19
Status: Codex-reviewed draft, awaiting user approval
Code location: `~/.claude/skills/jev-goal/scripts/` (shares `node_modules`, `.env`, and a new `lib/` with `grade.mjs`)

## 1. Purpose

A Claude Code `Stop` hook with two independent parts:

1. **Goal gate (deterministic, no model call).** While criteria that *this session* froze with `grade.mjs freeze` are not in a terminal state, block the stop. This turns the jev-goal skill's "loop until PASS" from an instruction into a harness guarantee.
2. **Nudge battery (one Jev call).** On a working turn with no active goal, ask Jev a fixed set of boolean questions about the final assistant message and the latest request. Block with a nudge when the answers show unfinished work Claude could advance now without the user.

The hook runs alongside the two existing Stop hooks (`stop-agent-logs.py`, `stop-idea-capture.py`) and does not replace them.

## 2. Non-goals

- No per-tool-call classification.
- No `SubagentStop`, `UserPromptSubmit`, or best-of-N selection. Separate follow-ups.
- No second judge (Haiku prompt hook). Shadow mode is the calibration path.
- No "claims complete without verification" questions in v1.
- The battery never fires on a conversation-only or research-only segment (user decision). The gate is not subject to that rule, because an open goal is unfinished by definition. See §4.4.
- The gate does not detect mutations made through Bash after a PASS (only Edit, Write, NotebookEdit). Documented limitation.

## 3. Files

| Path | Role |
|---|---|
| `scripts/lib/jev.mjs` | Extracted from `grade.mjs`: `askJev`, `findBash`, `truncate` (head and tail with omitted marker), `classifyGatewayError`. `grade.mjs` imports from it; its behaviour changes only where §5 says so. |
| `scripts/lib/transcript.mjs` | Pure functions over transcript JSONL: `parseTranscript`, `humanPrompts`, `chain` (since last human prompt), `segment` (since last string-content user entry), `finalAssistantText`, `toolCalls` (with outcomes), `freezeInvocations`, `nudges(sentinel)`. |
| `scripts/lib/goal-gate.mjs` | `goalStates(projectRoot, ownedFiles, transcriptFacts)` returning one state per owned criteria file (§4.4). |
| `scripts/lib/redact.mjs` | `redact(text)` for anything sent off-machine or written to the log preview. |
| `scripts/stop-hook.mjs` | Entry point. Reads stdin JSON, runs §4, prints the decision. |
| `scripts/stop-hook-report.mjs` | Prints the shadow log as a table. |
| `scripts/test/*.test.mjs` | `node --test` suites (§9); tests build temp directories rather than reading fixture files. |
| `~/.claude/settings.json` | Registers the hook and sets `JEV_STOP_HOOK` (§7). |
| `~/.claude/jev-stop-hook/log.jsonl` | Append-only evaluation log (§6). |

## 4. Pipeline

Steps run in order. Any step that produces a block ends the run. Every other exit prints nothing and exits 0. `stop_hook_active` is never used as a bail-out; the caps in §4.3 and §4.4 govern repeats, because a second block after real progress is intended.

### 4.1 Guards

- `JEV_STOP_HOOK` unset or `off`: exit 0. Modes: `off`, `shadow`, `enforce`. Project-level `.claude/settings.json` can set `off` to exclude a repository entirely.
- `transcript_path` missing or unreadable: exit 0.
- Headless detection: any transcript entry with `entrypoint: "sdk-cli"` marks a `claude -p` or SDK run (verified against real transcripts: interactive sessions carry `entrypoint: "cli"`); the hook exits 0. `--safe-mode` disables hooks entirely as well.

### 4.2 Transcript facts

Ignore entries with `isSidechain: true` and any `type` other than `user` or `assistant`. Skip lines that fail to parse; if nothing parses, exit 0.

**Human prompt.** A `user` entry where: if `origin` is present, `origin.kind === "human"`; if `origin` is absent, `message.content` is a string and `isMeta` is not true. Text is `message.content` when a string, else the concatenation of `text` blocks when a list (multimodal prompts). Stop-hook feedback (`isMeta: true`, content starting `Stop hook feedback:`) and tool results (list content with `tool_result` blocks) are never human prompts.

**Chain.** Every entry from the most recent human prompt onward. Used for nudge history and gate caps.

**Segment.** Every entry after the most recent `user` entry whose content is a string (a human prompt or a hook feedback entry). This is the reply Claude is stopping on right now. Used for the final message, the working-turn test, and the battery. The distinction matters: after `stop-agent-logs.py` blocks and Claude answers with one sentence, the chain still holds the original turn's tool calls but the segment holds none.

**Final assistant message.** Concatenated `text` blocks of `assistant` entries in the segment (Claude Code writes one entry per content block).

**Tool calls.** Every `tool_use` block in `assistant` entries, joined to its `tool_result` (matched by `tool_use_id` in the following `user` entries) to give `{name, summary, ok, timestamp}`. `ok` is `false` when the result has `is_error: true`, otherwise `true`. `summary` is: `file_path` for Read, Edit, Write, NotebookEdit; the first shell word for Bash (never the full command); `description` for Agent; `skill` for Skill; `pattern` for Grep, Glob; the tool name alone for everything else. Nothing else from tool inputs or outputs leaves the transcript.

**Mutation-capable tools.** `Edit`, `Write`, `NotebookEdit`, `Bash`, `Agent`, `Skill`, and any `mcp__*` tool. **Read-only tools.** `Read`, `Glob`, `Grep`, `ToolSearch`, `ListAgents`, `ReadNotifications`, `WebSearch`, `WebFetch`, `TodoRead`, `AskUserQuestion`.

**Freeze invocations.** Every Bash `tool_use` in the whole transcript whose command matches `grade.mjs freeze <path>` with `ok: true`. The path, resolved against the entry's `cwd`, gives the set of criteria files this session owns. Ownership never comes from timestamps, so a second session working in the same repository cannot gate this one.

### 4.3 Nudge history

Each block reason this hook emits starts with a sentinel: `jev-stop-nudge#<id>` for the battery, `jev-goal-gate#<id>` for the gate, where `<id>` is 8 hex characters of randomness. Claude Code echoes a block reason back into the transcript as an `isMeta` user entry, possibly concatenated with other hooks' reasons, so the hook searches the **whole** text of each feedback entry in the chain for its sentinels.

- `nudgeCount` = battery sentinels in the chain. `gateCount` = gate sentinels in the chain.
- **Progress after a nudge** = at least one mutation-capable tool call after the most recent sentinel entry. Read-only calls do not count.

### 4.4 Goal gate

Runs whenever the session owns at least one criteria file, regardless of the working-turn test. `projectRoot` is the hook input `cwd`; owned files outside it are still checked by their resolved path.

**Per-file state**, computed from the criteria file, its `.lock`, and its `.rounds.jsonl` (a truncated trailing line in the rounds file is tolerated; any other parse failure is `invalid`):

| State | Condition |
|---|---|
| `superseded` | Another owned file with the same base slug and a higher revision exists and is frozen. Base slug and revision come from `^(.*?)(?:-(\d+))?\.json$`, so `task.json`, `task-2.json`, `task-3.json` share base `task`; only the highest frozen revision is live. |
| `released` | Criteria file or lock file no longer exists. Terminal; takes no part in decisions or supersession. Deleting the file is the documented way to abandon a goal. |
| `invalid` | Lock present but `sha256` does not match the file (criteria edited after freeze), or lock/rounds unparseable. |
| `exhausted` | Rounds count is at least `maxRounds` and the last round failed. Terminal. |
| `passed` | Last round `passed: true`, and no Edit/Write/NotebookEdit tool call in the transcript has a timestamp later than that round's `at`. Terminal. |
| `reopened` | Last round passed but a later Edit/Write/NotebookEdit call exists. |
| `open` | No rounds yet, or last round failed with rounds below `maxRounds`. |

**Decisions**, in order, considering only non-superseded owned files:

1. `gateCount >= 3`: do not block; log `gateYielded: true`. The gate cap exists so a genuinely stuck session (the criteria cannot be met, the user must decide) can reach the user. Claude Code's own limit of 8 consecutive blocks is the backstop behind it.
2. Any `invalid`: block. Reason names the file and says: restore the frozen criteria, or start `<slug>-<n+1>.json` for a genuinely new task, then grade.
3. Any `open` or `reopened`: block. Reason names each file, its round count, the failing criterion ids from the last round (or "not yet graded"), and for `reopened` says files changed after the passing grade. Then: "Run `grade` and keep working until it passes. If the criteria cannot be met, say why in one sentence and stop; the gate yields after three blocks."
4. Any file whose last round passed with `at` later than the latest human prompt's timestamp, and whose confirmation token (§5) is absent from the final assistant message: block. Reason: paste the confirmation block printed by `grade`.
5. Otherwise the gate passes. `exhausted` files never block; the skill already requires a failure report at `maxRounds`, and `grade.mjs` now refuses to run past it (§5).

### 4.5 Battery eligibility

All must hold, otherwise exit 0 (after logging when in shadow mode and the gate ran):

- The session owns **no** criteria file. While a goal exists the gate is the authority, and this keeps the battery from competing with `grade.mjs` for the gateway quota.
- The segment contains at least one mutation-capable tool call (working-turn test; the user's rule).
- The segment contains no `AskUserQuestion`, `EnterPlanMode`, or `ExitPlanMode` call (waiting on the user by construction).
- `nudgeCount < 2`, and if `nudgeCount == 1`, progress after the nudge exists.

### 4.6 Battery

**State**, every string passed through `redact()` then `truncate()`:

```json
{
  "latestUserRequest": "<latest human prompt, cap 4000>",
  "assistantMessageBeforeRequest": "<final text of the reply preceding that prompt, cap 3000, or null>",
  "finalAssistantMessage": "<cap 6000>",
  "toolCallsThisSegment": [{ "name": "Edit", "summary": "src/x.ts", "ok": true }],
  "previousNudge": null
}
```

`assistantMessageBeforeRequest` makes short replies like "yes, do that" intelligible. Earlier user prompts are deliberately not sent: without their outcomes Jev cannot tell a completed request from an abandoned one, and a status question after finished work would read as unmet. `toolCallsThisSegment` is capped at 60 entries (first 39, an omission marker, last 20). When `nudgeCount == 1`, `previousNudge` is `{ "reason", "assistantMessageBefore": "<final text of the segment that preceded the nudge, cap 3000>", "mutatingCallsAfter": <count> }`.

**Questions**, all boolean, one `experimental_evaluate` call to `typesafe-ai/jev` with `maxRetries: 0` and a 25 s abort signal. Each carries the `grade.mjs` rule text (true only if the state clearly demonstrates it; if ambiguous, false). Every question is phrased so it can be answered from the message text, not inferred from tool semantics.

| id | question | role |
|---|---|---|
| `asks_user` | Does the final assistant message end by asking the user a question, or asking them to choose between options or approve something, such that the assistant needs that answer before it can continue? | veto |
| `blocked_external` | Does the final assistant message state that further progress needs the user's permission, information only the user has, or an event outside the assistant's control? | veto |
| `declined` | Does the final assistant message state that the assistant will not or cannot do the requested work, and give a reason such as safety, scope, or impossibility? | veto |
| `promises_pending` | Does the final assistant message say the assistant will do, or still needs to do, specific work that the same message does not report as already done? | trigger |
| `request_unmet` | Does the latest user request ask for a concrete deliverable that the final assistant message does not report as done? | trigger |
| `restatement` | Compared with the assistant message before the previous nudge, does the final assistant message repeat the same promises or the same blocker without reporting new progress? | veto, sent only with `previousNudge` |

**Decision.** Nudge when `promises_pending >= 0.80` or `request_unmet >= 0.80`, and each veto that was asked is `< 0.50`. Thresholds are constants in `stop-hook.mjs`, tuned from the shadow log. The AI SDK documents that boolean probabilities are not guaranteed calibrated, so tuning uses the labelled log (§6), not memory.

Known limitation, accepted: an unfinished reply that ends with "would you like me to continue?" triggers `asks_user` and escapes. That is the user's own rule ("if the user is still choosing a direction, don't nudge") and the shadow log will show how often it happens.

**Reason text on block:**

```
jev-stop-nudge#3f9a1c2e (1/2): the user's request looks unfinished.
  request_unmet P(true)=0.91: the latest request asks for a deliverable the final message does not report as done.
  promises_pending P(true)=0.84: the final message describes work not yet done.
If you can advance the request now, do it. If you are genuinely waiting on the user, say so in one sentence and stop.
```

Only fired signals are listed.

### 4.7 Output

- Block (enforce mode): print `{"decision":"block","reason":"<text>"}`, exit 0.
- Shadow mode: never block. Log with `wouldBlock`, exit 0. Note that shadow mode still makes the external Jev call; it is shadow with respect to blocking, not with respect to data leaving the machine.
- Otherwise: exit 0, no output.

The decision is computed and printed before the log append; a logging failure never changes a decision.

## 5. Changes to `grade.mjs`

- Import `askJev`, `findBash`, `truncate`, `classifyGatewayError` from `lib/jev.mjs`. No behaviour change.
- **Confirmation token.** The confirmation block gains a line `token: <slug>:<round>:<12 hex>` where the hex is `sha256(lock.sha256 + ":" + round + ":" + at)` truncated. The hook recomputes it from the rounds file and requires an exact match in the final message for each newly passed file. A quoted example or a block from another task no longer satisfies the gate.
- **Round ceiling.** `grade` refuses to run when the rounds file already holds `maxRounds` entries: exit 3 with "maxRounds reached; report the failing criteria to the user, or start a new criteria file". Today a later invocation would append round 11.
- SKILL.md gains a short section describing the gate: criteria frozen in a session hold the session until PASS, exhaustion, or three gate blocks; what to do when the criteria cannot be met; the headless caveat.

## 6. Shadow log

Every run that reaches §4.4 or §4.6 appends one line to `~/.claude/jev-stop-hook/log.jsonl`. Local file only.

```json
{
  "at": "2026-09-19T14:02:11.120Z", "session": "6d53ae91-...", "cwd": "C:\\dev\\jev-goal-page",
  "mode": "shadow", "nudgeCount": 0, "gateCount": 0,
  "gate": { "owned": ["explainer-page-2.json"], "states": { "explainer-page-2.json": "passed" }, "blockedOn": null, "gateYielded": false },
  "batteryRan": true,
  "answers": { "asks_user": 0.03, "blocked_external": 0.05, "declined": 0.02, "promises_pending": 0.84, "request_unmet": 0.91 },
  "wouldBlock": true, "blocked": false, "reason": "jev-stop-nudge#3f9a1c2e (1/2): ...",
  "finalMessagePreview": "<first 80 chars after redact()>",
  "usage": { "inputTokens": 5210, "outputTokens": 90 }, "error": null, "label": null
}
```

`stop-hook-report.mjs` prints date, cwd, gate states, wouldBlock, fired signals, and the preview, and accepts `--label <line> good|bad` to write the `label` field. Rollout: `shadow` for about a week, label the log, adjust thresholds or wording, then flip to `enforce`. No automatic rotation; the file grows one line per working turn. Sessions never write concurrently to the same line because each append is a single `appendFileSync` call under 4 KB.

## 7. Registration

```json
"env": { "JEV_STOP_HOOK": "shadow" },
"hooks": { "Stop": [ { "hooks": [
  { "type": "command", "command": "python ~/.claude/hooks/stop-agent-logs.py", "timeout": 15 },
  { "type": "command", "command": "python ~/.claude/hooks/stop-idea-capture.py", "timeout": 15 },
  { "type": "command", "command": "node ~/.claude/skills/jev-goal/scripts/stop-hook.mjs", "timeout": 45 }
] } ] }
```

The existing entries are unchanged. Stop hooks run in parallel and Claude receives every block reason. The agent-logs prompt asks for one sentence; the turn that answers it has an empty segment, so the battery does not fire on it (§4.2 segment rule).

## 8. Data boundary

What leaves the machine, only when the battery runs: the redacted latest human prompt, the redacted preceding assistant reply, the redacted final assistant message, tool names with file paths or first shell words, and the previous nudge text. Never: full Bash commands, tool outputs, file contents, earlier prompts. Destination: Vercel AI Gateway, then TypeSafe AI. `redact()` replaces, at minimum: strings matching common key shapes (`sk-`, `AKIA`, `ghp_`, `xox[abp]-`, `Bearer <token>`), `KEY=value` and `TOKEN=value` assignments, and anything between `-----BEGIN` and `-----END`. Redaction is a floor, not a guarantee, and SKILL.md says so. A repository that must not send anything sets `JEV_STOP_HOOK=off` in its project settings.

## 9. Failure handling

Every failure of the battery fails open. Failures of the gate are visible, not silent.

| Failure | Behaviour |
|---|---|
| Transcript unreadable | exit 0 |
| Corrupt lock or rounds (beyond a truncated trailing line) | gate state `invalid`, block with a visible reason (subject to the gate cap) |
| `AI_GATEWAY_API_KEY` missing | log `error: no_key`, exit 0 |
| Gateway 429, 5xx, network, abort at 25 s | log `error: grader_unavailable` with status, exit 0 |
| Log append fails | ignored; decision already printed |
| Any other exception in the battery | log, exit 0 |
| Any other exception in the gate | log, exit 0 (the gate cannot be more reliable than its own code) |
| Hook timeout | registered at 45 s; Claude Code kills the process, which counts as no output |

Never exit 2: on Stop that only shows stderr to the user.

## 10. Testing

`node --test scripts/test/`, no network. A fake judge is injected through `JEV_FAKE_ANSWERS` (JSON map of question id to probability), read only when set.

- **transcript.test.mjs**: human prompt detection with `origin` present, absent, multimodal list content, and synthetic string entries without `origin`; feedback entries not counted as prompts; segment versus chain after a hook block; final message assembled across split entries; tool outcomes joined by `tool_use_id`; Bash summary is the first word only; sidechain ignored; freeze invocations resolved against entry `cwd`, failed freezes ignored; sentinel found when concatenated after another hook's reason; progress after nudge counts only mutation-capable calls.
- **goal-gate.test.mjs**: each state in §4.4 from fixture directories; `task`, `task-2`, `task-3` supersession; hash mismatch; `maxRounds` exhaustion; PASS then Edit reopens; PASS then Read does not; another session's freshly frozen file is ignored because no freeze invocation is in this transcript; confirmation token present, absent, and wrong-task; gate cap yields at 3.
- **stop-hook.test.mjs** (entry point as child process): `off` prints nothing; conversation-only segment prints nothing; research-only segment prints nothing; `AskUserQuestion` segment prints nothing; owned goal suppresses battery; battery decision at each threshold boundary, each veto alone suppresses, each trigger alone fires, `declined` suppresses a refusal; shadow logs `wouldBlock` and prints nothing; nudge cap at 2; second nudge refused without mutating progress; missing key and simulated 429 print nothing; redaction of a token in the final message shows in the log preview; reply of "yes do that" carries the preceding assistant message.
- **grade.test.mjs**: `status` and `grade` output unchanged on the fixture except the token line; `grade` exits 3 at `maxRounds` without appending.
- **Replay**: a script runs `stop-hook.mjs` in shadow mode over every Stop point of three or four real transcripts under `~/.claude/projects/` and prints the report, for manual comparison before enforce mode.

## 11. Follow-ups (not in this spec)

- `claims_complete` and `verified_after_last_edit` questions in the battery.
- Bash-aware reopen detection (parse the command for known mutating tools).
- `SubagentStop` variant; `UserPromptSubmit` classifier; Haiku prompt hook logged side by side; best-of-N selection with Jev as the selector.
- Serialising `grade.mjs` writes per criteria file if two sessions ever share one.
