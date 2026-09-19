---
name: jev-goal
description: Use when the user asks for work to be driven to completion against acceptance criteria and graded by Jev, or says "jev", "jev goal", "jev this", "grade it with jev", "goal mode", or "keep going until it passes". Also use when asked to self-grade a finished task instead of dispatching a reviewing subagent.
---

# jev-goal

Pre-register acceptance criteria, do the work, then let Jev (TypeSafe AI's evaluation model, via Vercel AI Gateway) grade the result from evidence the script gathers itself. Loop until every criterion passes. Cheap, fast, and the agent never grades its own summary.

**Core rule: criteria are written and frozen BEFORE any work starts, and never edited afterwards.** The script enforces this with a hash; the point is that you cannot bend the bar to fit what you built.

## Workflow

Script: `~/.claude/skills/jev-goal/scripts/grade.mjs` (Node 22+, key in `scripts/.env`).

1. **Draft criteria** at `<project>/.claude/jev/<task-slug>.json` (format below). Do this before reading much code and before editing anything. Do not show the criteria to the user for approval; they delegated that. Write the file with the Write tool or `node -e` + `JSON.stringify`, not a Bash heredoc: the Bash tool strips one level of backslashes from heredoc bodies, which silently corrupts regexes and sed delimiters.
2. **Freeze:** `node ~/.claude/skills/jev-goal/scripts/grade.mjs freeze <file>`. Dry-runs every evidence command once, then records a hash and the base commit. Failures and empty output are expected at this point (the work does not exist yet); the freeze is refused only when a command cannot run at all (shell syntax error, unknown command, malformed sed/grep expression). If refused, the file is not frozen: fix the command and freeze again. Read the dry-run output before moving on; a `jev` criterion flagged as printing nothing needs evidence that will produce text later.
3. **Do the work** as normal (other skills still apply: TDD, debugging, verification).
4. **Grade:** `node ~/.claude/skills/jev-goal/scripts/grade.mjs grade <file>`.
5. **Loop:** exit 1 means some criteria failed. The output names them. Fix, then grade again. Repeat until exit 0.
6. **Report.** On PASS the script prints a block between `--- jev-goal confirmation` and `--- end confirmation ---`: the task, when the criteria were frozen, the round count, and a table of every criterion with its question, check mode, and result. Paste that block verbatim into the final message, then summarise the work. The user reads it as proof of what was promised before the work started and how each promise was checked.

Exit codes: `0` pass · `1` fail, keep working · `2` lock/usage error · `3` maxRounds hit, stop and report · `4` grader unavailable (rate limit etc.), wait 60-120s with a background sleep and grade again; not a verdict.

## Criteria file

```json
{
  "task": "add rate limiting to POST /upload",
  "criteria": [
    { "id": "tests_pass",     "check": "exit0", "question": "Does the test suite pass?",            "evidence": "npm test" },
    { "id": "typecheck",      "check": "exit0", "question": "Does the type check pass?",            "evidence": "npx tsc --noEmit" },
    { "id": "scope",          "check": "exit0", "question": "Are changes limited to src/routes/ and test/?", "evidence": "test -z \"$(git diff --name-only \"$JEV_BASE\" | grep -vE '^(src/routes|test)/')\"" },
    { "id": "limit_in_route", "check": "jev",   "question": "Does the diff add a rate-limit check to the upload route handler?", "evidence": "git diff \"$JEV_BASE\" -- src/routes/" },
    { "id": "limit_tested",   "check": "jev",   "question": "Does the diff add a test that exercises the 429 response?", "evidence": "git diff \"$JEV_BASE\" -- test/" }
  ]
}
```

Optional keys: `threshold` (default 0.8), `maxRounds` (default 10), `cwd` (project root, relative to the file; default two levels up).

**Two check modes.** `exit0` passes when every evidence command exits 0: deterministic, instant, no model call. `jev` (the default) sends the command output to Jev and passes at P(true) >= threshold. Anything a script can decide gets `exit0`: tests, type check, lint, "file exists", "no changes outside these paths". Reserve `jev` for reading a diff or output for intent: "does the diff add a test that exercises X", "does the migration make the column non-null". When any `exit0` criterion fails, the Jev questions are skipped that round (shown as WAIT) so you fix concrete failures first and spend no gateway call.

**Writing good criteria:**

- 3 to 8 criteria. Each is one atomic, observable question that a reader could answer from the evidence output alone. Jev does not reason; it reads.
- Every criterion names the shell command(s) that prove it. The script runs them from the project root in bash. You never write the evidence yourself.
- Diffs use `"$JEV_BASE"`, the commit recorded at freeze time, so committing during the work does not empty the diff.
- Always include the project's real test command and its type/lint check if it has one, as `exit0`. Add one `jev` criterion for the behaviour the task asked for, one for the test that proves it, and one `exit0` `scope` criterion guarding against unrelated changes.
- A scope criterion names code and test paths only. `.claude/jev/` is git-ignored (globally on this machine), so the criteria file never appears in `git status`; listing it as an expected file makes the criterion fail.
- Phrase questions so `true` means done. Avoid negatives that Jev might invert.

## What Jev cannot grade

Jev reads evidence; it has no taste and does not reason. For open-ended goals ("make it look good", "make the docs clear", "clean this up") the criteria you can write are proxies: fonts loaded, a palette defined, a section present, a function shorter than N lines. A competent first draft clears proxies on round one, so grading will not push back on quality. Treat the criteria as the floor, and do the judgement check yourself: open the page in the browser, read the docs as a newcomer would, review the diff. Then say in the report what the confirmation block covers and what it does not. Do not stretch a `jev` question into "is this well designed?"; Jev will answer from whatever text it sees and the number will mean nothing.

## Rationalizations that mean STOP

| Thought | Reality |
|---|---|
| "This criterion turned out to be wrong, I'll tweak the wording" | Frozen. If the task genuinely changed, tell the user and start a new file; otherwise make the code satisfy it. |
| "Tests pass, so I'm done; grading is a formality" | Grade anyway. Jev caught a broken test script that looked green in its first real run. |
| "P(true)=0.76 is basically a pass" | Threshold is the threshold. Find out what evidence is missing and add it. |
| "I'll write the criteria after I see how hard it is" | That is exactly the bias pre-registration exists to prevent. Criteria first. |
| "The grader is rate limited, I'll declare it done" | Exit 4 is not a verdict. Wait and grade again. |
| "Ten rounds hit, I'll quietly stop" | Exit 3 means report the failing criteria and the rounds file to the user. Say it plainly. |
| "Freeze refused a command, I'll set JEV_SKIP_DRYRUN" | The dry run only blocks on commands that cannot run. Fix the command. The skip is for a command that genuinely cannot execute before the work exists, and that is rare. |
| "All ten criteria passed on round one, so the page must be good" | It means the proxies were met. Open it, read it, look at it. Proxies are the floor, not the verdict. |

## Common mistakes

- A `jev` criterion whose evidence prints nothing on success (`grep -q`). Jev needs text to read: use `grep -n pattern file`, or make it an `exit0` criterion instead.
- Evidence that depends on the shell cwd. Commands run from the project root; use paths relative to it.
- Criteria about quality of judgement ("is the design clean?"). Jev grades observable facts. Keep judgement calls for a human or a reasoning reviewer.
- Grading from a dirty tree that includes unrelated changes. `$JEV_BASE` diffs show everything since freeze.
- A frozen evidence command that turns out to be broken anyway (the dry run cannot catch everything). Do not grind rounds against it. Leave that file as a recorded FAIL, create `<slug>-2.json` with identical criteria and the fixed command, freeze that, and say so in the report.
- Backslashes in evidence regexes. Prefer `[.]` for a literal dot and `#` as the sed delimiter when the pattern contains `/`, so the command survives every quoting layer.
