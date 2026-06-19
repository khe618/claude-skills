# Scheduling the digest

Run once in PowerShell (your direct terminal):

    powershell -ExecutionPolicy Bypass -File "C:\Users\khe61\.claude\skills\mobile-review-digest\install\install-schedule.ps1"

- Fires at **06:30 daily**. `-StartWhenAvailable` runs it after a missed start
  (e.g. machine asleep at 06:30) once the machine wakes.
- **Limitation:** if the machine is fully off at 06:30 and not woken, the run is
  skipped until the next day. The reliable path remains on-demand from the phone
  ("give me my review digest").
- The task runs as you (the logged-on user) so it inherits your `claude` auth and
  Remote Control connection — needed for the push to reach your phone.

## Verify

- Inspect:  `Get-ScheduledTask -TaskName MobileReviewDigest`
- Manual fire (also verifies headless push/file delivery — see
  `../references/delivery-check.md`):
  `Start-ScheduledTask -TaskName MobileReviewDigest`
  Within a minute or two the push + card image should arrive on your phone.
- Remove:   `Unregister-ScheduledTask -TaskName MobileReviewDigest -Confirm:$false`

## Notes

- The action runs `claude -p "run the mobile-review-digest skill in scheduled
  digest mode"`. If your `claude` shim spells the headless flag differently,
  adjust the `-Argument` in `install-schedule.ps1`.
- If headless delivery does not reach the phone, see the fallback in
  `../references/delivery-check.md`.
