# Codex PR review — wait, triage, resolve

The user's repos have the ChatGPT Codex GitHub app (`chatgpt-codex-connector`)
review every PR. Factory PRs (`claude/<prefix>-NNN-*` branches) get their
review threads handled by the factory responder; **every other PR has nobody
reading them unless you do.** By 2026-10-17, 18 Codex threads sat unresolved
on merged travel_app PRs (3 on the sign-in PR #85, 4 on account deletion #78),
because nothing in the open → merge path looked at them. This procedure is
that check. It's used in two places: right after you open a PR (CLAUDE.md
"PR review comments") and as a merge gate (`merge-and-ship` step 1).

## How Codex behaves

- It reviews when a PR is **opened**, **marked ready for review**, or when
  someone comments **`@codex review`**. It does **not** re-review on a new
  push — after you push fixes, ask for a re-review explicitly (below).
- It reacts 👀 while running, then posts (and keeps editing) one summary
  comment, and posts each finding as an inline **review thread** with a
  P0–P3 badge. A run with no findings ends in a 👍 reaction.
- The summary comment carries a machine-readable marker:
  `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"…","has_unresolved_findings":…,"status":"completed"}, …} -->`.
  `commit_sha` is the commit it reviewed. Older PRs (before ~2026-10-14) have
  the summary comment without this marker — fall back to the threads.
- A review usually lands 2–5 minutes after the trigger.

## 1. Wait for the review of the current head

```bash
gh pr view <N> --json headRefOid,comments -q '.headRefOid, (.comments[] | select(.author.login=="chatgpt-codex-connector") | .body)' \
  | grep -o 'codex-review-state:v1 {.*}' 
```

The review is **current** when `code_review.status` is `completed` and
`code_review.commit_sha` equals `headRefOid`. If it isn't there yet, poll
every ~60 s for up to ~10 minutes (use a Monitor/until-loop, not foreground
sleeps). If nothing arrives after that, comment `@codex review` once (see
§4) and wait one more round; if still nothing, say so in your report rather
than blocking forever — a missing review is "unknown", not "clean".

If the head moved since Codex last reviewed (you pushed after the review),
the old threads still count, but the new commits are unreviewed: ask for a
re-review (§4) if the new commits change behavior, not for a typo fix.

## 2. List the unresolved threads

```bash
gh api graphql -F o=<owner> -F r=<repo> -F n=<N> -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:20){nodes{author{login} body}}}}}}}' \
  -q '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | [.id, .path, (.line|tostring), .comments.nodes[0].author.login, (.comments.nodes[0].body|split("\n")[0])] | join(" | ")'
```

Then read each thread's full body (drop the `-q` filter, or select one `id`).
Count **every** reviewer's unresolved threads, not only Codex's — a human
comment matters at least as much. (jq string literals don't accept `\s`; use
`[ ]*` in any `sub()` pattern.)

## 3. Triage each unresolved thread

Read the finding against the **current** code (the thread may be outdated —
`isOutdated: true` means the lines moved, not that it's fixed). Then exactly
one of:

- **Valid and in scope** → fix it on the PR branch, verify (lint/tests, plus
  whatever the project's AGENTS.md requires), push, then reply on the thread
  with what changed and the commit SHA, and resolve it.
- **Not valid** (misreads the code, already handled elsewhere, contradicts a
  deliberate decision in the spec/AGENTS.md) → reply with the concrete reason
  (point at the line or doc), and resolve it.
- **Valid but out of scope / needs a decision** → don't resolve it. Leave it
  for the user and list it in your report with your recommendation. If the
  user then explicitly waives it in the conversation, reply noting the
  waiver (and log it via `idea-capture` if it's a real follow-up), then
  resolve.

Be honest in triage: "valid" is the default when the finding is plausible
and you can't show it's wrong. Don't resolve a thread just to clear the gate.
Multiple threads → batch the fixes into as few commits as is natural.

Reply and resolve via GraphQL (write the body to a file first so quotes and
backticks survive):

```bash
gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' -f t=<thread id> -F b=@reply.md
gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -f t=<thread id>
```

## 4. Ask for a re-review after behavior-changing fixes

```bash
gh pr comment <N> --body "@codex review"
```

Codex ignores comments from bots, but `gh` here is authenticated as the user,
so this works. Post it once per round, then go back to §1 for the new head.

## Report

State the outcome in one line per PR: "Codex: reviewed `<sha>`, N findings —
X fixed (`<sha>`), Y declined with reasons, Z left for you: …" or "Codex:
reviewed `<sha>`, no findings." Never report a PR as ready while a thread is
unresolved without naming it.
