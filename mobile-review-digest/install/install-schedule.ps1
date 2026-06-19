# Registers the two daily review-digest tasks. Run once in PowerShell; re-running updates them.
#   MobileReviewDigest        06:30  node run.mjs --scheduled   (deterministic core; always ships)
#   MobileReviewDigestEnrich  06:33  claude -p enrich            (best-effort "needs attention" layer)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found on PATH" }
if (-not $claude) { throw "claude not found on PATH" }
$skill = "C:\Users\khe61\.claude\skills\mobile-review-digest"
$ws = 'C:\Users\khe61\OneDrive\Documents\CS Programs'

$a1 = New-ScheduledTaskAction -Execute $node -Argument "`"$skill\scripts\run.mjs`" --scheduled" -WorkingDirectory $ws
Register-ScheduledTask -TaskName 'MobileReviewDigest' -Action $a1 `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 6:30am) `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)) `
  -Description 'Daily review digest core (deterministic) at 6:30 AM' -Force

# --model haiku: the enrich is a tiny task; on the default (Opus) the full agent took ~20 min,
# on Haiku it completes in ~1 min. Fast enough for a daily best-effort job.
$a2 = New-ScheduledTaskAction -Execute $claude -Argument '-p --model haiku "enrich today''s review digest with the needs-attention section"' -WorkingDirectory $ws
Register-ScheduledTask -TaskName 'MobileReviewDigestEnrich' -Action $a2 `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 6:33am) `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)) `
  -Description 'Best-effort review-digest attention enrichment at 6:33 AM' -Force

Write-Host "Registered MobileReviewDigest (6:30 node core) + MobileReviewDigestEnrich (6:33 claude enrich)."
