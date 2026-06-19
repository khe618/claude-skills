# Parsing reference

- `scripts/parse-tasks.mjs` → `parseTasks(md)` returns
  `{ num, state, title, fields:{context,objective,scope,evidence,doneWhen}, blocked, blockReason, effort }`.
- `blocked` keys off dependency language; never recommend a blocked task as "do next".
- `effort` is a coarse S/M/L from Scope breadth — label it as an estimate.
- `scripts/discover.mjs` → `discoverRepos(root?)` returns `{ dir, tasksPath, slug, branch }[]`
  for every `TASKS.md` within depth 3 of the workspace. `slug`/`branch` may be null
  if a dir is not a git repo.
- `scripts/pr-data.mjs` → `gatherPrs(slug)` returns `{ open, merged, error }`;
  `merged` is already filtered to the last 7 days. Each `Pr` has
  `{ number, title, branch, isDraft, state, checks, mergeable, mergedAt, body, files }`.
  `checks` ∈ `passing|failing|pending|none`. On any `gh` failure, `error` is set
  and `open`/`merged` are empty (never throws).
