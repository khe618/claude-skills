---
name: ga-weekly-digest
description: Use for TraderPrep's weekly GA growth digest — running it on demand, checking on scheduled Tuesday runs, explaining what "how did the site do this week" would show, troubleshooting a failed/deploy-failed/stale run, or rotating the GA service-account key. Triggers on "growth digest", "GA digest", "how did the site do this week", or questions about the Tuesday 07:10/07:25 scheduled tasks.
---

# GA weekly growth digest

TraderPrep's weekly self-hosted analytics digest: a static page built from
GA4 + Search Console data, with a best-effort Claude-written narrative
layered on top, deployed to its own Vercel project. Runs from the
**traderprep** repo (not a worktree) — `C:\dev\traderprep`.

Spec: `docs/superpowers/specs/2026-08-22-ga-weekly-growth-digest-design.md`
Plan: `docs/superpowers/plans/2026-08-22-ga-weekly-growth-digest.md`
(both paths relative to `C:\dev\traderprep`)

## On-demand commands

Run from `C:\dev\traderprep`:

```
node scripts/growth/ga-digest.mjs             # Job A: fetch GA4/GSC -> render -> archive -> deploy
node scripts/growth/ga-digest.mjs --dry-run   # fetch + checkCompatibility + snapshot summary; no deploy, no state writes
node scripts/growth/analyze-job.mjs           # Job B: claude narrative -> splice into the page -> deploy
```

Job B only does anything if Job A's most recent run for the *currently
eligible* week succeeded (`status: "core"`) and the on-disk page still
matches the hash Job A recorded — otherwise it's a clean no-op (see exit
codes below). Always run Job A before Job B; the scheduler mirrors this with
Job A at 07:10 and Job B at 07:25 (15 min buffer).

**Digest URL:** printed by both jobs on success (`deployResult.url` /
`last-run.json.deployUrl`) — the Vercel project is `traderprep-growth-digest`
(working name at setup time; confirm the live domain in the Vercel dashboard
or `last-run.json` after the first real deploy). Report the URL back to the
user after an on-demand run rather than assuming a fixed domain.

## Scheduled runs

Two Windows Task Scheduler tasks, installed via
`scripts\growth\install-schedule.ps1` (checked into the repo; re-run it any
time to idempotently re-register both tasks after a change):

- `TraderPrep GA Digest - Job A` — weekly Tuesday 07:10, 15 min time limit.
- `TraderPrep GA Digest - Job B` — weekly Tuesday 07:25, 30 min time limit.

Both run as the interactive logged-on user (`Interactive` logon type,
`Limited` run level — matches the daily review-digest tasks), require
network, and use `MultipleInstances IgnoreNew` (a still-running instance
blocks a new trigger rather than stacking). Stdout/stderr append to
`state\logs\job-a.log` / `job-b.log`, with 1 MB rotation to a single `.1`
backup baked into each task's command.

## State layout

Everything lives outside the repo and outside OneDrive, at
`C:\dev\traderprep-data\growth-digest\`:

```
secrets\ga-service-account.json   # GA service-account key (see Key rotation)
state\
  data\<week-monday>.json         # weekly snapshots — PRIVATE, never deployed
  recommendations.json            # Job B's recommendations ledger, keyed by week
  last-run.json                   # single source of truth for run status
  logs\job-a.log / job-b.log      # rotating stdout/stderr
site\                             # the ONLY directory ever deployed
  index.html
  archive\<week-monday>.html
  archive\index.html
```

### `last-run.json` statuses

- `pending` — Job A started this week's run but hasn't finished (crash mid-run
  never looks enrichable to Job B).
- `core` — Job A succeeded: page rendered and deployed. Job B may now run.
- `enriched` — Job B succeeded: narrative spliced in and redeployed.
- `failed` — Job A aborted before deploying (e.g. GA/auth error). Last week's
  page is still live.
- `deploy-failed` — Job A rendered locally (snapshot + archive on disk) but
  the Vercel deploy itself failed.

### Exit codes

- **Job A** (`ga-digest.mjs`): `0` success or `--dry-run` completed, `2` lock
  already held by a concurrent run, `1` any other failure.
- **Job B** (`analyze-job.mjs`): `0` on `enriched` **or** an expected no-op
  (no core run yet, wrong week, stale content hash, lock held), `1` on an
  actual failure (model error, invalid/unparseable JSON, splice failure,
  deploy failure — Job B rolls back to the pre-run bytes on any of these, so
  the core page always stands even when Job B exits 1).

## Degradation semantics

- **Stale page timestamp = failed run.** The page always shows its
  generation timestamp. If it hasn't moved since last Tuesday, Job A failed
  before deploying (check `last-run.json.status` — expect `failed` — and
  `state\logs\job-a.log`); last week's content is what's still live, not a
  broken page.
- **Search Console section unavailable** — until SC setup (site verification
  + granting the service account access) is done, or on any SC-side error,
  the page renders the SC section in a labeled "unavailable" state rather
  than failing the whole run. GA-only digests are a valid, complete run.
- **`NO_FINAL_DATA`** — `scError.code` when Search Console has no finalized
  date in the lookback window yet (data lag, not a real error). Same
  "unavailable" rendering as above; not worth investigating unless it
  persists for multiple weeks.
- Job A never deploys a partial/broken page: local snapshot + archive files
  land before the deploy attempt, so a deploy failure never loses history —
  it just leaves `status: "deploy-failed"` and last week's live page in
  place.

## `VERCEL_TOKEN` — persist it, don't just export it

Scheduled tasks read the **user environment** (the persistent one set via
`setx` or System Properties), not whatever is exported in an interactive
shell session. A token that only exists in the shell you tested from will be
invisible to the Tuesday-morning scheduled run and both jobs will fail at the
deploy step — but not identically: Job A writes `status: "deploy-failed"`
(snapshot + rendered page are on disk, just not deployed). Job B never
writes `deploy-failed` — on a deploy failure it rolls its staged writes back
to the prior `core` state (index/archive/ledger/last-run all restored
byte-for-byte) and exits `1`, so `last-run.json` still reads `core` after a
failed Job B run.

Set it once, permanently:

```
setx VERCEL_TOKEN <value>
```

Then open a **new** shell (or reboot, or just wait for the next scheduled run
— `setx` writes to the registry immediately, existing processes just don't
see it) before relying on it. Verify with `Start-ScheduledTask` in the
scheduled context per the spec's §11 validation step — that's the only way
to actually prove the scheduler's environment has it, since your own shell
having it proves nothing about the scheduled context.

## Key rotation

The GA service-account key at
`C:\dev\traderprep-data\growth-digest\secrets\ga-service-account.json` is
long-lived and unattended, so rotate it if you suspect exposure or on a
routine cadence:

1. In Google Cloud console, create a **new** key for the same service
   account.
2. Download it and overwrite
   `C:\dev\traderprep-data\growth-digest\secrets\ga-service-account.json`
   with the new key (same path — no env var change needed unless
   `GA_SA_KEY_PATH` was customized).
3. Run `node scripts/growth/ga-digest.mjs --dry-run` to confirm the new key
   authenticates before relying on it for the next scheduled run.
4. Back in the Google Cloud console, **delete the old key** — revocation is
   immediate on deletion, and there's no reason to leave a superseded key
   live.

The loader validates the key JSON (`type: "service_account"`,
`client_email`, `private_key` present) before use and never logs the key,
JWTs, or access tokens; API errors that reach `last-run.json` are reduced to
sanitized `{ status, code, message }` with no headers/URLs.
