# Codex adapter

Routing and fallback are caller-owned; this adapter never selects a backend.

## preflight

- `codex --version` — presence.
- `codex doctor` — auth health. **Isolate the authentication-specific result** from the
  doctor output. Do not treat the overall doctor exit status as an auth verdict: doctor
  also reports install, config, and runtime health, and a failing disk or plugin check
  would otherwise be misreported as an auth failure with useless remediation.

| doctor result | failureClass |
|---|---|
| authentication check failed | `auth` — stop, tell the user to re-authenticate |
| network/runtime check failed | `transport` |
| anything else failing | `unknown` |

An auth failure is classified `auth`, never `quota`.

## invoke

```bash
codex exec --sandbox workspace-write -C "$repo_root" --json \
  --model "$model" -o "$run_dir/codex-last.txt" - < "$run_dir/prompt.md" \
  > "$run_dir/codex.jsonl" 2> "$run_dir/codex.err" &
codex_pid=$!
```

- `--model` is **explicit** so the report is deterministic; capture the model actually used
  from the session record rather than assuming the request was honored.
- `-` plus stdin redirection is **mandatory**. Never `"$(cat …)"` argv interpolation.
- `--dangerously-bypass-approvals-and-sandbox` is **forbidden**. `workspace-write` is the
  widest sandbox this adapter may use.
- cwd must be the canonical repo root recorded in the pre-flight manifest.
- Capture `codex_pid` at launch; `terminate` needs it.

## terminate

Terminate the process tree rooted at `$codex_pid`, then **confirm exit**. A skill cannot
guarantee process-tree teardown on Windows — if exit cannot be confirmed, return
`terminalState = unknown` and refuse to auto-reset. Never reset the tree while a delegate
may still be writing to it.

## parse

Branch on the **top-level** `.type` of each parsed event. Never substring-match the raw
line: `item.completed` wraps items whose own `type` may be `"error"`, and those advisories
(hook-timeout clamps, skill-description truncation notices) appear on fully successful
runs. Verified 2026-08-23 — a naive error-scan fails 100% of runs.

Extraction: `sessionId` from `thread.started.thread_id`; `usage` from the single
`turn.completed.usage` (**not** summed); `finalMessage` from the `-o` file, advisory only;
write-began from any `item.type == "file_change"`.

**`model` is not in the JSONL** — verified 2026-08-23, the parse block returns `-` for it.
The actual model appears in the stderr banner as a `model: <name>` line. Read it from
`$run_dir/codex.err` for the report; do not assume the `--model` request was honored:

```bash
model_actual=$(grep -m1 '^model:' "$run_dir/codex.err" | sed 's/^model:[[:space:]]*//')
```

The quota signature table is **empty** — no Codex quota error has been observed and
captured yet. Every unrecognized failure therefore classifies `unknown` and stops. This is
correct fail-closed behavior; do not invent message text to force a `quota` classification.

```python canonical-parse
import json, sys

QUOTA = []                                   # empty: no verified Codex quota signature yet
AUTH = ["you've hit your session limit"]     # observed 2026-08-23
TRANSPORT = ["service unavailable", "bad gateway", "gateway timeout",
             "connection reset", "502", "503", "504"]


def classify():
    try:
        events = []
        with open(sys.argv[1], encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    events.append(json.loads(line))       # malformed -> row 1
    except Exception:
        return "unknown", "unknown", "-", "-"
    if not events:
        return "unknown", "unknown", "-", "-"

    exit_status = sys.argv[2]
    sid = next((e.get("thread_id") for e in events
                if e.get("type") == "thread.started" and e.get("thread_id")), "-")
    model = next((e["model"] for e in events if isinstance(e.get("model"), str)), "-")

    done = [e for e in events if e.get("type") == "turn.completed"]
    bad = [e for e in events if e.get("type") == "turn.failed"]
    wrote = any(e.get("type") == "item.completed"
                and (e.get("item") or {}).get("type") == "file_change" for e in events)

    if len(done) > 1 or (done and bad):                    # row 6
        return "unknown", "unknown", sid, model

    if bad:
        msg = ((bad[-1].get("error") or {}).get("message") or "").lower()
        if any(q in msg for q in QUOTA):
            return ("unknown", "unknown", sid, model) if wrote \
                else ("failed", "quota", sid, model)       # rows 3 / 2
        if any(a in msg for a in AUTH):                    # row 4
            return "failed", "auth", sid, model
        if any(t in msg for t in TRANSPORT):
            return "truncated", "transport", sid, model
        return "failed", "unknown", sid, model             # row 5

    if done:                                               # rows 7 / 8
        return ("completed", "none", sid, model) if exit_status == "0" \
            else ("unknown", "unknown", sid, model)

    return "truncated", "transport", sid, model            # row 9


try:
    print("\t".join(classify()))
except Exception:
    print("unknown\tunknown\t-\t-")
```

## Validation

```bash
SCRATCH="C:/Users/khe61/AppData/Local/Temp/claude/C--dev/c51dcca4-6cf7-4e86-a3fd-56110559bead/scratchpad/dispec"
python "$SCRATCH/harness.py" ~/.claude/skills/delegate-implementation/references/codex.md codex
```

Must pass every fixture row, including `07_success_with_advisory` (nested advisories on a
successful run) and `08_exit_disagreement` (success predicate met, non-zero exit).
