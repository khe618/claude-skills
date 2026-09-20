# opencode adapter

Routing and fallback are caller-owned; this adapter never selects a backend.

## preflight

- `opencode --version` — presence.
- Model resolution, by **ordered display-name targets** resolved to ids at runtime.

Ids are never hardcoded, because stealth codenames rotate — but the *targets* are an
explicit ordered list, so selection is deterministic rather than left to the implementer:

1. Enumerate registered providers: `opencode debug v2`.
2. Enumerate callable ids: `opencode models`.
3. Fetch `https://models.dev/api.json`, filter to **registered providers only**, and match
   on the `name` field against each display-name target in order.
4. Require **exactly one** match. Zero or ambiguous ⇒ stop and report; never pick the first.
5. Establish cost is **zero** from the catalog's `cost` object. Unknown cost ⇒ stop.
   Never auto-select a paid model.
6. Record resolved id, display name, and the cost evidence in the report.

Resolve by display name, never by id substring: stealth ids share no substring with their
display names — the model shown as "Ox Alpha Free (Unlimited)" is `opencode/x-preview-f-free`
— and the CLI's "Did you mean" suggestion matches the full catalog including providers this
install cannot reach.

| failure | failureClass |
|---|---|
| HTTP 401 / `unauthorized` | `auth` — stop, tell the user to re-authenticate |
| HTTP 429 / `rate limit` | `quota` |
| HTTP 5xx / connection reset | `transport` |
| anything else | `unknown` |

## invoke

```bash
opencode run --dir "$repo_root" --auto --format json --model "$model_id" \
  < "$run_dir/prompt.md" > "$run_dir/oc.jsonl" 2> "$run_dir/oc.err" &
oc_pid=$!
```

- `--dir` is **mandatory**. Without it the agent may discover a different project than the
  one checkpointed and edit the wrong tree. Immediately before launch, assert
  `git rev-parse --show-toplevel` from the subprocess cwd equals the recorded canonical root.
- `--auto` bypasses **approval prompts, not the OS**. It is acceptable only because the
  clean-tree checkpoint makes tracked edits revertible.
- Prompt by stdin. Never `"$(cat …)"` argv interpolation.
- Capture `oc_pid` at launch; `terminate` needs it.

## terminate

Terminate the process tree rooted at `$oc_pid`, then **confirm exit**. A skill cannot
guarantee process-tree teardown on Windows — if exit cannot be confirmed, return
`terminalState = unknown` and refuse to auto-reset. Never reset the tree while a delegate
may still be writing to it.

## parse

**Exit status is authoritative in neither direction.** Verified 2026-08-22: the process
exits 0 when a provider 503 truncates a run mid-task. Do not infer success from exit 0, and
do not infer failure from a missing final event.

Success requires all four: a completed assistant message, a final `step_finish` whose
`reason` is `stop`, no session error, and no pending tool parts. Any other finish reason
(`length`, `error`, `unknown`) fails closed.

Extraction: `sessionId` from any event's `sessionID`; `usage` **summed across every**
`step_finish` — the last event alone understates a run roughly 4×; `finalMessage` from the
last `text` part, advisory only; write-began from any write/edit tool part. If the persisted
session cannot be queried by id after exit, `terminalState = unknown`.

```python canonical-parse
import json, sys

QUOTA = ["rate limit", "quota", "insufficient_quota", "too many requests"]
AUTH = ["unauthorized", "invalid credentials", "authentication"]
TRANSPORT = ["service unavailable", "bad gateway", "gateway timeout", "connection reset"]
WRITE_TOOLS = {"write", "edit", "patch", "apply"}


def err_text(e):
    d = (e.get("error") or {})
    return f"{d.get('name','')} {(d.get('data') or {}).get('message','')} " \
           f"{(d.get('data') or {}).get('statusCode','')}".lower()


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
    sid = next((e["sessionID"] for e in events if e.get("sessionID")), "-")
    model = next((e["model"] for e in events if isinstance(e.get("model"), str)), "-")

    errs = [e for e in events if e.get("type") == "error"]
    steps = [e for e in events if e.get("type") == "step_finish"]
    texts = [e for e in events if e.get("type") == "text"]
    tools = [e for e in events if e.get("type") == "tool"]
    pending = any(((t.get("part") or {}).get("state") or {}).get("status")
                  not in ("completed", "error") for t in tools)
    wrote = any((t.get("part") or {}).get("tool") in WRITE_TOOLS
                and ((t.get("part") or {}).get("state") or {}).get("status") == "completed"
                for t in tools)
    last_reason = ((steps[-1].get("part") or {}).get("reason") if steps else None)
    base_ok = bool(texts) and bool(steps) and last_reason == "stop" and not pending

    if base_ok and errs:                                   # row 6
        return "unknown", "unknown", sid, model

    if errs:
        msg = err_text(errs[-1])
        if any(q in msg for q in QUOTA):
            return ("unknown", "unknown", sid, model) if wrote \
                else ("failed", "quota", sid, model)       # rows 3 / 2
        if any(a in msg for a in AUTH) or " 401" in msg:   # row 4
            return "failed", "auth", sid, model
        if any(t in msg for t in TRANSPORT) or any(c in msg for c in ("502", "503", "504")):
            return "truncated", "transport", sid, model
        return "failed", "unknown", sid, model             # row 5

    if base_ok:                                            # rows 7 / 8
        return ("completed", "none", sid, model) if exit_status == "0" \
            else ("unknown", "unknown", sid, model)

    if steps and last_reason != "stop":                    # length/error/unknown: fail closed
        return "unknown", "unknown", sid, model
    if pending:
        return "unknown", "unknown", sid, model
    return "truncated", "transport", sid, model            # row 9


try:
    print("\t".join(classify()))
except Exception:
    print("unknown\tunknown\t-\t-")
```

## Validation

```bash
SCRATCH="C:/Users/khe61/AppData/Local/Temp/claude/C--dev/c51dcca4-6cf7-4e86-a3fd-56110559bead/scratchpad/dispec"
python "$SCRATCH/harness.py" ~/.claude/skills/delegate-implementation/references/opencode.md opencode
```

Must pass every fixture row, including `09_truncated_503_exit0` — the provider truncation
that still exits 0, which is the case that motivated this entire contract.
