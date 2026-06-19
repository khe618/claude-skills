# Tasks

1. [in progress] Continue Stripe subscriptions implementation plan
   - Context: The branch is ahead of main with billing commits.
   - Objective: Continue the existing Stripe subscriptions plan from the next step.
   - Scope: Follow the plan; preserve completed branch work. Do not redesign pricing.
   - Evidence: Branch not merged to main.
   - Done when: Remaining plan tasks implemented and merged to main.

2. [open] Rename the estimation batch-span constant
   - Context: MAX_INTERVAL_RATIO now means minimum span.
   - Objective: Rename MAX_INTERVAL_RATIO to MIN_BATCH_SPAN across code and tests.
   - Scope: constants.js, route.js, and the matching tests. Rename only.
   - Evidence: IDEAS.md entry "Rename MAX_INTERVAL_RATIO".
   - Done when: No MAX_INTERVAL_RATIO references remain and focused tests pass.

3. [in progress] Wire up the export button
   - Context: Users asked for CSV export.
   - Owner: codex
   - Steps:
     - [x] add the endpoint
     - [ ] add the button
   - Evidence: PR https://github.com/khe618/x/pull/9
