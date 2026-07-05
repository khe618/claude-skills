---
name: mobile-review-digest
description: Generate the daily review digest — one self-contained HTML page (New PRs to review since the last run + a collapsible faithful render of each project's TASKS.md) deployed to the review-digest Vercel site, plus a best-effort "Needs your attention" section flagging stalled in-progress tasks. Use when the user asks for their review digest, "what should I work on", a task/PR update, or when run on the 6:30 AM schedule.
---

# Mobile Review Digest (v2)

A phone-friendly **HTML page** the user reads at the review-digest Vercel URL. The
**core is fully deterministic** (a plain `node` script); the LLM only does a tiny
best-effort enrichment. **No push notifications** (pure pull); freshness is the
in-page generation timestamp.

Scripts in `scripts/` (zero deps). Site dir:
`C:\Users\khe61\OneDrive\Documents\CS Programs\review-digest`.

## The page
1. **⚠ Needs your attention** (best-effort, Job B only) — stalled in-progress tasks.
2. **New PRs to review** — open PRs created since the last scheduled run, with a
   one-line summary + GitHub link.
3. **Tasks** — each project's `TASKS.md`, collapsible (`<details>`): title visible,
   tap to expand the raw block verbatim.

## On-demand
Run `node scripts/run.mjs` (reuses the cutoff, doesn't advance it) and report the
deployed URL. If you're acting as an agent and want the attention section too, run
the Job B flow below afterward.

## Daily — two jobs (deterministic core + best-effort enrichment)
- **Job A — `node scripts/run.mjs --scheduled` (6:30, plain node):** renders the
  core with an empty `<!--ATTENTION-SLOT-->`, writes `index.html` + the dated
  archive, **advances `lastScheduledRunAt`** (only if every repo scanned OK),
  deploys. Always ships; no model.
- **Job B — `claude -p --model haiku` enrich (6:33, best-effort):** layered on Job A.
  Use **Haiku** — the task is tiny, but on Opus the full agent took ~20 min; on Haiku
  it's ~1 min. Steps:
  1. `gather()` → repos with in-progress `tasks`.
  2. `findStalledTasks(repos, ghView)` (from `scripts/attention.mjs`) — links each
     in-progress task to its PR (Evidence `/pull/N` or branch) and flags definitive
     stalled states (conflicts / failing CI / changes-requested / merged-while-open
     / closed-unmerged). Deterministic; uses the real `ghView`.
  3. For each flagged item, write a **specific one-line `diagnosis` that states the
     ACTION to take** (not just the problem) — e.g. "PR #10 is merged; mark the task
     done and prune it from TASKS.md" / "PR #6 has conflicts — rebase onto main" →
     build
     `items = [{ repo, taskNum, taskTitle, prNumber, prUrl, diagnosis }]`.
  4. `enrich({ siteDir, today: <YYYY-MM-DD>, items })` (from `scripts/enrich.mjs`) —
     **always call it, even when `items` is empty** (empty → it splices a "✓ Nothing
     needs your attention" note, which also confirms the enrich ran).
     **No-ops unless today's Job A succeeded**; string-splices the attention section
     into Job A's exact `index.html`, deploys `index.html` only, sets
     `status:'enriched'` (preserving the cutoff). Any failure → no-op / rollback.

## Degradation (never hard-fail)
- Per-repo `gh` error → "PRs unavailable" row + blocks cutoff advance.
- **Zero repos discovered → treat as a broken scan, not a clean empty result.**
  With no repos there are no per-repo errors, so `allReposOk` stays true and
  the cutoff advances over a scan that found nothing (this masked a
  `DEFAULT_ROOT` move for days). If the page says "No task queues found",
  first check `discover.mjs` `DEFAULT_ROOT` still points at the live
  workspace; after fixing, roll `lastScheduledRunAt` back in `last-run.json`
  to before the earliest missed PR or it stays stranded behind the cutoff.
- No prior cutoff → "New in the last 24h" (labeled).
- Job B any failure (no fresh core / no slot / no items / gh/model error / deploy
  fail) → no-op; Job A's core page stands.

## Setup (one-time, user actions — see install/README)
`VERCEL_TOKEN` env var; `vercel link`; two scheduler tasks (`node run.mjs
--scheduled` @6:30 + `claude -p` enrich @6:33); a canary; mandatory `Start-
ScheduledTask` validation.
