# Delivery / deploy reference (v2)

- Delivery is a **Vercel-hosted HTML page**, not push. Two daily jobs:
  - **Job A** `node scripts/run.mjs --scheduled` (6:30) — deterministic core; sole
    writer of `index.html` core, the dated archive, and `lastScheduledRunAt`.
  - **Job B** `claude -p` enrich (6:33) — best-effort; splices the attention section
    into Job A's `index.html` (index-only deploy); no-ops unless today's Job A
    succeeded; rolls back on deploy failure.
- `scripts/deploy.mjs` → `deploy({siteDir, token=VERCEL_TOKEN, run})`. Default runner
  uses `shell:true` (Windows `vercel` is a `.cmd`), a 120s `timeout`, `windowsHide`,
  `CI=1`/`NO_COLOR=1`; the spaced path stays in `cwd`. URL = JSON `deployment.url`
  (fallback `*.vercel.app` regex); empty/non-URL ⇒ `ok:false`. Loud-fails (no hang)
  if `VERCEL_TOKEN` unset or `<siteDir>/.vercel/project.json` missing.
- Bookmark the stable production domain `https://review-digest.vercel.app`.
- No `PushNotification` / `SendUserFile`.

## One-time setup
1. `setx VERCEL_TOKEN "<token>"` (reopen shell). 2. `vercel link` the folder. 3.
Register the two scheduler tasks (`install/install-schedule.ps1`). 4. Canary:
`node scripts/run.mjs`; open the URL on the phone. 5. Mandatory: `Start-ScheduledTask
-TaskName MobileReviewDigest` (and `MobileReviewDigestEnrich`) once to validate the
scheduled context.
