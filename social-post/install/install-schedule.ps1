# Registers the weekly TraderPrep social post. Run once in PowerShell; re-running updates it.
#   TraderPrepSocialPost  Tue 09:00  claude -p "/social-post run"
#
# The run drives the user's real Chrome via the claude-in-chrome tools, so it MUST
# run as the interactive logged-on user with Chrome open and the extension
# connected. If Chrome is closed the run reports a failure and notifies rather than
# silently doing nothing.
#
# Also prepares the runner checkout: a git worktree of traderprep on main at
# C:\dev\traderprep-worktrees\social-post, with node_modules junctioned to the
# primary checkout so the Playwright renderer works without a second npm install.
$ErrorActionPreference = 'Stop'

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { throw "claude not found on PATH" }

$primary = 'C:\dev\traderprep'
$worktree = 'C:\dev\traderprep-worktrees\social-post'
$state = 'C:\dev\traderprep-data\social-post'
$logs = Join-Path $state 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

if (-not (Test-Path $worktree)) {
  git -C $primary fetch origin main
  git -C $primary worktree add $worktree origin/main
  git -C $worktree checkout -B main origin/main
}
$nm = Join-Path $worktree 'node_modules'
if (-not (Test-Path $nm)) {
  cmd /c mklink /J "$nm" "$primary\node_modules" | Out-Null
}

# Append stdout/stderr to logs\run.log with a 1 MB rotation, so a run that dies
# before it touches the ledger still leaves a trace. Same cmd.exe quoting trick as
# the GA digest installer: one outer quote pair around a command that contains
# further quoted tokens; /s strips only the outer pair.
$log = Join-Path $logs 'run.log'
$rotate = '(if exist "{0}" for %F in ("{0}") do @if %~zF gtr 1048576 move /y "{0}" "{0}.1")' -f $log
# --chrome is load-bearing: a headless `claude -p` does NOT load the Claude in
# Chrome integration by default (the MCP list has no claude-in-chrome entry and
# no mcp__claude-in-chrome__* tools exist), so without it every run fails with
# "chrome not connected". Verified 2026-09-13 on Claude Code 2.1.270.
$run = '"{0}" -p --chrome "/social-post run" >> "{1}" 2>&1' -f $claude, $log
$action = New-ScheduledTaskAction -Execute $env:ComSpec `
  -Argument ('/d /s /c "{0} & {1}"' -f $rotate, $run) `
  -WorkingDirectory $worktree

Register-ScheduledTask -TaskName 'TraderPrepSocialPost' -Action $action `
  -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Tuesday -At 9:00am) `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable `
      -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
      -MultipleInstances IgnoreNew) `
  -Description 'Weekly TraderPrep question slideshow -> Instagram, TikTok, X (Tue 09:00)' `
  -Force

Write-Host "Registered TraderPrepSocialPost (weekly Tuesday 9:00 AM)."
Write-Host "Runner checkout: $worktree"
Write-Host "State dir: $state"
