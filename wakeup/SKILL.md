---
name: wakeup
description: Schedule a one-shot local cron that fires at a future clock time and pokes Claude to continue work in the current session. Use when the user types /wakeup, says "wake me at 2am", "set a wakeup for 11:32pm", "come back at 10pm and finish this", "resume at 7am tomorrow", or otherwise asks Claude to pause now and continue later at a specific time. Common use case: hitting session/usage limits and wanting Claude to pick up automatically after the limit window resets while the user is asleep. This is a session-local schedule — it survives only while Claude Code stays open and the machine stays awake.
---

# /wakeup

Schedule a one-shot local cron that fires at a future clock time in the current session, then self-deletes when it fires.

## When to use this vs. /loop or /schedule

- **/wakeup (this skill)** — one-shot, local, fires into the *current* session, preserves conversation context. Right for "come back at 2am and finish what we were doing."
- **/loop** — recurring, local. Right for "check the deploy every 5 minutes."
- **/schedule** — durable, cloud-based, *fresh* session (no current-context handoff). Right for "every morning send me a summary."

If the user wants in-session continuity, this skill is the answer. If they want it to survive closing the laptop, point them at `/schedule` and explain that they'll need to pass enough context for a cold-start agent.

## Parsing the time argument

Accept common clock-time phrasings. Be liberal — users won't always be precise.

| Input | Interpretation |
|---|---|
| `10pm`, `10 pm`, `10:00pm` | 22:00 |
| `2am`, `2 am`, `2:00 am` | 02:00 |
| `11:32 pm`, `11:32pm` | 23:32 |
| `23:00`, `2:00` (24h) | 23:00, 02:00 |
| `noon` | 12:00 |
| `midnight` | 00:00 |

**Target date**: always the *next* occurrence of that clock time. If the parsed time is later today, target today; if it's already passed today, target tomorrow.

**Time zone**: the machine's local time zone. Don't try to convert — cron runs in local time and the user thinks in local time.

If the argument is missing, ambiguous (e.g. `5` — am or pm?), or unparseable, ask one short clarifying question. Don't guess on AM/PM — getting this wrong means missing the wakeup by 12 hours.

## Building the cron expression

Use a fully-specified cron with the exact month and day-of-month, so the expression itself clearly encodes a single point in time:

```
<minute> <hour> <day-of-month> <month> *
```

Example: target = Mon Oct 13 02:05 → cron = `5 2 13 10 *`.

`CronCreate` will auto-delete after the single fire (see workflow), so the specific date is mostly for clarity, but it's also a safety net if the call is somehow made without `recurring: false`.

## Building the fire prompt

The prompt that gets injected when the cron fires. It must identify itself as an automated wakeup (so future-you doesn't think the user typed it) and tell future-you what to do.

Template:

```
[Automated /wakeup trigger at <human-readable target time> — this is not a real user message]

Review the recent conversation, identify what was in progress before this wakeup, and continue from there. If there's nothing obvious to resume (the user may have been testing /wakeup), send a one-line PushNotification confirming the wakeup fired and stop.
```

No self-delete instruction needed — `recurring: false` on `CronCreate` causes the job to auto-delete after a single fire.

## Workflow

1. Parse the time argument into `(hour, minute)`. If ambiguous or missing, ask one short clarifying question and stop.
2. Compute the target date — today if `(hour, minute)` is still in the future, otherwise tomorrow. Compute the human-readable target string (e.g. `"Mon Oct 13, 2:05 AM"`).
3. Build the cron expression `<minute> <hour> <day> <month> *`.
4. Call **CronCreate** with `cron`, the fire prompt, and **`recurring: false`**. The job auto-deletes after firing once — no manual cleanup needed.
5. Confirm to the user: target datetime, cron expression, job ID, and the caveats below.

## Confirming to the user

After scheduling, report concisely:

- Target wakeup time, in human-readable local time, including the date if it's not today
- The cron job ID
- These caveats, on their own lines:
  - "Claude Code has to stay open until then — close it and the schedule is gone."
  - "Your machine has to stay awake — check Windows sleep settings if you're stepping away."
  - "To cancel: `CronDelete <id>` or just tell me to cancel the wakeup."

Then stop. Don't editorialize, don't pre-explain what the wakeup will do — the fire prompt handles that.

## Edge cases — stop and ask, don't guess

- **Ambiguous AM/PM.** "5" → ask. "noon" / "midnight" / "5pm" → fine.
- **Past time today, no "tomorrow" qualifier.** Default to tomorrow and *say so* in the confirmation. ("It's 9pm now and you said 5pm — scheduling for 5pm tomorrow. Tell me if you meant something else.")
- **Time very close to now (<5 minutes).** Confirm before scheduling — likely a typo.
- **Existing wakeup already scheduled.** Call CronList first if it's easy. If you find one whose prompt starts with `[Automated /wakeup trigger`, tell the user and ask whether to replace it or stack a second one.
- **No clear "current task" to resume.** Still schedule — the fire prompt handles the empty case by sending a PushNotification and stopping. The user may be using /wakeup as a generic timer.

## What this skill is *not*

- Not a durable cloud schedule. If the user closes Claude Code or the machine sleeps, the cron dies. Tell them this once during confirmation — don't hide it.
- Not a context handoff. The whole point is that this fires *into the current session*, so don't write a summary or "what we were doing" doc — Claude will read the conversation history when the cron fires.
- Not a substitute for `/usage`. This skill doesn't know when the user's session limit resets — the user provides the time. If they ask "when do my limits reset?" tell them to run `/usage`.

## Why these constraints

The user built this skill specifically for the "hit the session limit late at night, want Claude to resume after reset while I sleep" workflow. That requires:
- *Local* execution, because a cloud agent would start cold without the conversation context.
- *One-shot* behavior, because the user wants exactly one continuation, not a repeating poke. `CronCreate` with `recurring: false` handles this natively — fires once, auto-deletes.

The fully-specified date in the cron expression is belt-and-suspenders: if the call is ever made without `recurring: false` by mistake, the cron can still only match once per year.
