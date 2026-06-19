---
name: idea-capture
description: Log future-feature ideas and out-of-scope improvements — the "we could also do X" / "ideally Y, but later" / "skip Z for the first pass" thoughts that surface during prototyping — to a per-project `IDEAS.md` so they aren't lost between sessions. Use this skill proactively the moment a feature implementation wraps up (the change just landed, the user said "looks good" / "ship it" / "let's stop here"), because deferred ideas vanish from context the instant the conversation moves on. Also use when the user says any of "save this for later", "add to the ideas list", "log this idea", "remember this for next time", "we should do X eventually", "add to IDEAS", "/idea-capture", or a close paraphrase. The skill scans the recent conversation for deferred-improvement signals, de-duplicates against the existing file, appends the entries directly, and then reports what it logged so the user can adjust the list afterward. It writes without a separate approval step — capturing is low-stakes and a plain-text list is trivial to edit. It only pauses to ask when it genuinely can't tell where the file belongs (missing/ambiguous project root, multiple subprojects) or when the content looks sensitive.
---

# /idea-capture

Capture out-of-scope improvements surfaced during work into a per-project `IDEAS.md` so the next session doesn't have to re-derive them. Capturing an idea is low-stakes and easy to undo — it's one line in a plain-text list the user can edit anytime — so the default is to **write the entries directly and report what you logged**, not to ask for sign-off first. The round-trip of drafting, waiting for approval, then writing is friction this skill deliberately skips. You still pause for the few cases where autonomous writing could go wrong (see *When to pause or flag* below): you can't tell where the file should live, or the content looks sensitive.

## What belongs in IDEAS.md

Future features and improvements that came up during work but were intentionally deferred. The point is to remember the idea, not to spec it — each entry is one sentence.

Concrete classes worth logging:

- **"For now / first pass" deferrals** — anything the user or you explicitly punted: "we'll hard-code this for now", "skip the empty state for the prototype", "we'll wire up real auth later".
- **Adjacent features that came up** — "we could also support X", "this would be nicer if it also did Y", "the natural next step is Z".
- **Quality / polish backlog** — accessibility, error states, edge cases, performance, observability — the stuff a prototype skips on purpose.
- **Integrations / scope expansions** — "should also talk to service A", "would be cool to expose this in the CLI too".
- **Refactor ideas with future leverage** — only if the user agreed they're worth doing eventually; otherwise they belong in a code comment or get dropped.

## What does NOT belong

- **Bugs in the code as it stands.** Those should be fixed or filed as bugs, not parked in an ideas file. If the user wants to defer a real bug, flag it: "this sounds like a bug — log it as an idea, or open a fix?"
- **In-flight task state.** Use tasks for that, not this file.
- **Findings about how the code already works** (non-obvious behavior, tooling quirks). That's `LEARNINGS.md` via the `agent-logs` skill — different file, different purpose.
- **Trivia or one-liners** the user mentioned in passing without endorsing as a real idea. If you're unsure, it's fine to log it and note it in your report so the user can keep or drop it.
- **Secrets, internal URLs, customer identifiers, absolute paths with usernames.** This file lives on disk and is often sync'd. Redact or skip.

## When to capture without being asked

Bias toward capturing — the moment-of-discovery is the cheapest time, and the user can't remember to ask every time. But ground the action in **observable signals**, not vibes:

- A feature implementation just wrapped (change landed, tests pass, user signed off), AND
- The conversation contained at least one explicit "for now" / "out of scope" / "we could also" / "eventually" mention.

If both are true, run the skill. If only the first is true (feature wrapped but no deferred-idea signals in the conversation), don't run it — there's nothing to capture.

When capturing proactively: log the entries directly and report what you captured (compact — title plus one line each), same as a commanded run. You don't need to offer first or wait for a yes. If the user later says to drop something, remove it — it's a one-line edit.

Skip proactive capture entirely for trivial work (one-line tweaks, copy edits, formatting). The overhead isn't worth it.

## Workflow

1. **Locate the project root.**

   `IDEAS.md` lives at the project root, not the workspace root and not in a subdirectory.

   - Anchor on the files actually edited or worked on this session — not the shell cwd.
   - Walk up from those files looking for the nearest manifest (`package.json`, `requirements.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `Gemfile`, `composer.json`, `setup.py`, etc.). That directory is the project root.
   - If no manifest is found but a `CLAUDE.md` exists walking up, use the directory containing that `CLAUDE.md`. (Catches one-off top-level scripts in workspaces.)
   - If touched files span **multiple sibling subprojects** (e.g., a monorepo with `apps/web/` and `apps/api/`, or this workspace's case of editing across two top-level folders), **stop and ask** the user which project the ideas belong to — don't pick one silently. Ideas for two different projects should go in two different files.
   - If no anchor can be found at all (genuinely loose scripts in a directory with no manifest and no `CLAUDE.md`), ask the user where the file should live.

2. **Read the existing `IDEAS.md`** if it exists. You need to know what's already there to avoid logging duplicates. If it doesn't exist, you'll create it with the header template below.

3. **Scan the conversation for candidate ideas.**

   Look back through the recent conversation for phrases that signal a deferred improvement. Common markers:

   - "out of scope" / "for now" / "for the first pass" / "for the prototype" / "MVP"
   - "we could also" / "we should eventually" / "in the future" / "down the road"
   - "TODO" / "follow-up" / "later" / "next iteration"
   - "would be nice" / "would be cleaner if" / "ideally"
   - "this doesn't handle X yet" / "X isn't supported"
   - The user explicitly declining a sub-feature mid-implementation ("don't worry about case X right now", "skip the empty state").

   For each candidate, extract:

   - **A short title** — 3-7 words, imperative phrase preferred ("Support multi-currency totals", "Add CSV export", "Cache stale-while-revalidate on quotes").
   - **A one-sentence description** — what the improvement is, concretely enough that future-you can tell if it's still relevant.
   - **Optionally:** a brief *Why deferred* note if the conversation gave a clear reason ("first pass keeps it inline for simplicity", "blocked on the new auth flow").

4. **Assemble the entries — no approval gate.**

   Turn the scanned candidates into entries in the format below. Don't stop to show a draft and wait for a yes — capturing is low-stakes, and a plain-text list is trivial to edit, so a wrong or surplus entry costs the user one line they delete later, which is cheaper than a round-trip on every capture. The user reviews after the fact, in step 7.

   If your scan turned up nothing, say so and don't create or modify the file. An empty `IDEAS.md` is worse than no file — it implies "we considered and have nothing".

5. **De-duplicate against existing entries.**

   Before writing, compare each new entry against the existing `IDEAS.md` content. If a candidate is clearly the same idea as something already logged (similar title or substantively overlapping description), either:

   - **Drop it** from the new batch (preferred when it's a true duplicate), or
   - **Merge it** into the existing entry (e.g., add a clarifying detail or a second motivation).

   When you're **not sure** whether two entries are really the same, keep both rather than dropping or merging — a near-duplicate is visible in your report and trivially deleted, but a wrongly-dropped idea vanishes silently with nobody having seen it. Reserve drop/merge for cases where the overlap is clear.

6. **Append to `IDEAS.md`.**

   - If the file doesn't exist, create it with the header template below, then add the new entries beneath.
   - If the file exists and has sections (e.g., `## UI`, `## Backend`, `## Polish`), slot each new entry into the most appropriate section. Don't restructure the file without the user's OK.
   - If the file is a flat list, add new entries to the bottom. If you're adding 3+ entries that naturally fall into different groups, you can suggest introducing sections — but only suggest, don't restructure unilaterally.
   - If the file exists but uses a totally different format (someone hand-rolled it), leave the existing structure alone and append your new entries beneath in the format below. Don't reformat someone else's file.

7. **Report what you logged.** Because there's no draft step, this report is the user's review surface — so do list what you wrote, compactly. Lead with "Logged N ideas to `<path>`:" then the entries as title + one-line each. Keep it tight (glance-and-move-on); the user edits the file directly if anything's off. This is also where you raise any flags from the *pause or flag* cases below (a bug, a spec-sized entry, a contradiction).

## Entry format

```markdown
- **Short imperative title** — One-sentence description of the improvement. *Why deferred:* brief reason (optional).
```

Examples:

```markdown
- **Per-user feature flag overrides** — Let specific users opt into a flag regardless of the global setting.
- **Fetch flags from a config service** — Replace hard-coded flag values with a remote config source so they can change without a deploy. *Why deferred:* first pass keeps flags inline for simplicity.
- **Admin UI for toggling flags** — A small page that lets non-engineers flip flags without editing code.
```

New-file header template:

```markdown
# Ideas

Future features and improvements considered out of scope at the time they were logged. Each entry is one sentence — the goal is to remember the idea, not spec it. Remove entries (or move to a "Shipped" section at the bottom) once they're done.

---
```

## When to pause or flag

Autonomous write is the default. A few cases warrant either pausing before you write or calling something out in your report — two tiers:

**Pause before writing** — you genuinely don't know where the entry goes, or it shouldn't be written as-is:

- **No project root found.** Don't default to the workspace root — that's a junk drawer. Ask where the file should live before writing.
- **Multiple subprojects touched.** Don't pick one silently. Ask which project owns each idea. (Ideas from two projects → two files, not one.)
- **Sensitive content** (secrets, tokens, internal URLs, absolute paths with usernames, customer identifiers). Redact before writing — this file lives on disk and is often sync'd. If redaction would gut the entry, surface it and let the user decide rather than writing it verbatim.

**Write the rest, but flag it in your report** — don't silently bury these in the list:

- **The "idea" is actually a bug** in the code as it stands. Log the genuine ideas, but call the bug out instead of filing it: "this one sounds like a bug, not a future feature — want to fix it, or still log it?" Don't bury active bugs in an ideas list.
- **An entry is large enough to need a real design doc.** Log it, but note it: "this might be too big for a one-liner in IDEAS — want a spec instead, or a pointer to one?"
- **An entry contradicts something already in `IDEAS.md`** (existing says "use approach A", new idea is "switch to approach B"). Write the non-conflicting entries, but surface the conflict in your report and ask whether the old entry is stale (mark it superseded or remove it) or genuinely competes (both stay, with a note). Don't silently add a contradiction.

## Why these constraints

An ideas file is only valuable if future-you (or future-Claude) trusts it enough to read it. That trust comes from the file staying clean — short entries, no duplicates, no real bugs buried in the wishlist, no secrets — not from a human having signed off on each line before it landed. Capture is cheap and reversible (one line in a plain-text list), so the old "draft → wait → write" gate mostly added friction at the exact moment capture is most valuable: the moment of discovery. The guards that remain — de-dup, keep entries to a sentence, don't write to the wrong project, don't write sensitive content, flag a real bug or a genuine contradiction instead of silently filing it — are the ones that actually protect the file's signal, and none of them require blocking on the user first. Reporting after the write (step 7) keeps the user in control without making them the bottleneck.
