---
name: social-post
description: Use when posting a TraderPrep question slideshow to Instagram, TikTok or X, running or checking the weekly Tuesday social post, drafting new slideshow decks when the queue runs low, or debugging a failed/partial/stale social run. Triggers on "/social-post", "post the slides", "weekly post", "social queue", "did the post go out", or the TraderPrepSocialPost scheduled task.
---

# Social post

Posts one six-slide question slideshow per week to the TraderPrep accounts on
Instagram (carousel), TikTok (photo post) and X (question image + answer reply),
then records what happened so the next run knows where it left off.

Content comes from decks in the traderprep repo at
`marketing/social/slideshows/decks/*.json`, rendered by
`marketing/social/slideshows/render.mjs` (see that folder's README). Only decks on
`main` are ever posted: merging a deck PR is the review step, and a scheduled run
never posts text nobody has read.

## Commands

```
/social-post run                        # the weekly job (Tuesday 09:00 via Task Scheduler)
/social-post post <slug> [--only ig|tiktok|x] [--dry-run]
/social-post draft                      # top up the deck queue, open a PR, notify
/social-post status                     # ledger + last run
```

From the skill directory: `npm test` (ledger logic), `node scripts/state.mjs --help`.

## Authorization (read this before any run)

The owner installed the `TraderPrepSocialPost` scheduled task and chose fully
unattended posting on 2026-09-13. A scheduled `/social-post run` therefore carries
the owner's instruction to publish the next **merged** deck to all three accounts.
That instruction covers merged decks only. A run must never publish text it wrote
itself in the same session: `draft` opens a PR and stops.

## Paths

| What | Where |
| --- | --- |
| Runner checkout | `C:\dev\traderprep-worktrees\social-post` (worktree on `main`; `node_modules` junctioned to the primary checkout) |
| Decks | `<runner>\marketing\social\slideshows\decks\*.json` |
| Rendered slides | `<runner>\marketing\social\slideshows\out\<slug>\{story,portrait}\NN-<kind>.png` + `caption.txt` |
| Ledger | `C:\dev\traderprep-data\social-post\state.json` (outside the repo and OneDrive) |
| Run log | `C:\dev\traderprep-data\social-post\logs\run.log` |

Override with `SOCIAL_POST_REPO` / `SOCIAL_POST_STATE` when testing from another checkout.

## `run` — the weekly job

1. `node scripts/state.mjs run-start`.
2. `git -C <runner> pull --ff-only`. A pull failure is a run failure: report and stop.
3. Check Chrome: `tabs_context_mcp` with `createIfEmpty: true`. If the extension
   is not connected, record `run-end failed "chrome not connected"`, push-notify,
   stop. Do not retry silently.
4. `node scripts/state.mjs plan` → `{ finish, post, remaining }`.
   - For each entry in `finish`, post that deck to just its listed platforms
     (these are platforms that failed or were never reached last time).
   - Then post `post` (the oldest deck with no ledger entry) to all three.
   - If `post` is null, record `run-end partial "queue empty"` and notify; the
     owner needs to merge decks.
5. Render if `out/<slug>/` is missing: `node marketing/social/slideshows/render.mjs <slug>` from the runner checkout.
6. Post per platform (mechanics below). After **each** platform, immediately
   `node scripts/state.mjs mark <slug> <platform> posted <url>` or
   `... failed - "<reason>"`. Mark before moving on, so a crash mid-run leaves an
   accurate ledger. A failure on one platform does not stop the others.
7. If `remaining < 1` after this run, do the `draft` flow.
8. `node scripts/state.mjs run-end ok|partial|failed "<summary>"`, then
   `PushNotification` with one line per platform: posted + URL, or failed + why.

A platform is **posted** only when verified on the platform's own page (see each
platform's "verify" step). A Share/Post click that returned without error is not
verification.

## Posting mechanics

Try `file_upload` with the runner's `out/<slug>/<format>/*.png` paths directly
first. On 2026-09-13 (scheduled run from the runner worktree) repo paths were
accepted on all three platforms with no copy. If a call is rejected with "only
files this session is allowed to read can be uploaded", copy to a folder the
session may read and retry:

```bash
SP="<scratchpad directory from the system prompt>"
mkdir -p "$SP/<slug>" && cp "<runner>/marketing/social/slideshows/out/<slug>/<format>/"*.png "$SP/<slug>/"
```

`find` the `<input type=file>` and call `file_upload` with six files (~1.2 MB,
well under the 10 MB cap). Ask `find` for "input type=file" explicitly: on X it
otherwise returns the "Add photos or video" wrapper `<button>`, which
`file_upload` rejects with "Element is not a file input". Never click the
platform's "select from computer" button; that opens a native dialog you
cannot drive.

Caption text for every platform is `out/<slug>/caption.txt` (caption + hashtags).

### Instagram (carousel, `portrait` slides)

1. `navigate` to `https://www.instagram.com/`. If the page is a login form, mark
   `ig failed "not logged in"` and move on.
2. Click **Create** in the left rail, then **Post**. `find` "input type=file in the
   create new post dialog" → `file_upload` the six portrait PNGs in order.
3. **Crop step: Instagram defaults to 1:1 and silently cuts the slides.** Click the
   ratio icon at the bottom-left of the preview and choose **4:5**. Confirm the
   first slide shows its header and footer before continuing.
4. Next → (filters, leave Original) → Next. The dialog resizes between steps, so
   re-screenshot before each click rather than reusing coordinates.
5. Click the caption box, `type` the caption text. Leave the Facebook cross-post
   toggle off. Click **Share**. Wait for "Your post has been shared."
6. Verify: `navigate` to `https://www.instagram.com/traderprep/` and confirm the
   hook slide is the newest grid tile. Record the profile URL (individual post
   URLs are not exposed in the web create flow).

### TikTok (photo post, `story` slides)

1. `navigate` to `https://www.tiktok.com/tiktokstudio/upload?tab=photo`. A
   redirect to `/login` means not logged in: mark `tiktok failed "not logged in"`.
2. `find` "input type=file in the Photos tab panel" → `file_upload` the six story
   PNGs. The page moves to `/tiktokstudio/upload/post/photo` and shows the six
   thumbnails in order.
3. Title box (90 chars): the deck's `hook`. Description box: the caption text.
   Type a trailing space after the last hashtag so the hashtag picker closes.
4. Scroll down. "When to post" = Now, "Who can see this post" = Everyone. Click
   **Post** (find "Post button"). The page moves to `/tiktokstudio/content`.
5. Verify: the new row is at the top of the content list. It shows **"Only me"
   and "Content under review"** for up to 12 hours; that is TikTok's normal review
   and it flips to public on its own. Record `https://www.tiktok.com/tiktokstudio/content`.
6. No sound is attached. Adding a trending sound is worth doing by hand from the
   row's edit action; do not attempt it in the scheduled run.

### X (question image, answer in reply, `portrait` slides)

1. `navigate` to `https://x.com/compose/post`. If the left rail shows no account
   card, mark `x failed "not logged in"`.
2. `find` the compose file input → `file_upload` **only `02-question.png`**.
3. `type` the X text: the deck `hook`, a blank line, then
   `Answer in the reply. 500+ more at https://traderprep.org` and two hashtags at
   most. Keep it under 280 characters. Click **Post**.
4. Verify: `navigate` to `https://x.com/TraderPrepHQ`, open the newest post, and
   record its URL (`/TraderPrepHQ/status/<id>`).
5. On that post, click **Reply**. `file_upload` `04-answer.png` and
   `05-reasoning.png`. `type` `<answer>. <answerNote>` from the deck. Click
   **Reply**. Verify the reply appears under the post.
6. The post counts as `posted` only when both the question post and the answer
   reply are verified. If the reply fails, mark `x failed "reply missing <url>"`
   so the next run posts the reply (not a duplicate question).

### `--dry-run`

Do every step up to, but not including, the final **Share** / **Post** / **Reply**
click. Screenshot that state, then close the dialog (X asks "Save post?": click
**Discard**) or navigate away. Mark nothing in the ledger.

### Chrome tab hygiene

- If a tool says the tab "is not in Claude's tab group", call `tabs_context_mcp`
  and use the id it returns.
- If `screenshot` fails with "Cannot take screenshot with 0 width", the tab is
  dead: `tabs_create_mcp`, close the old one, navigate again. Seen on X right
  after a navigate.
- `find` failing with "Chrome blocked the extension from accessing this page"
  means the page is still redirecting. Wait 3–4 s and retry once.

## `draft` — topping up the queue

Runs when `node scripts/state.mjs queue-low` exits 0 (fewer than two unposted decks).

1. In the runner checkout: `git checkout -b social/decks-<YYYY-MM-DD> origin/main`.
2. Pick two free questions not already used by a deck: compare
   `QUESTIONS.filter(q => q.free)` in `src/questions.js` against existing deck
   slugs. If none remain, notify "free question bank exhausted; drafting needs
   gated statements" and stop. Do not pull gated statements from Supabase.
3. Solve each question yourself, then write `decks/<slug>.json` matching the
   README's fields and limits. The `reasoning` lines must be a correct derivation,
   not a restatement of the answer. Plain Unicode math, no LaTeX.
4. `npm test` in the checkout (the deck validator runs there), then render.
5. Commit decks + rendered `out/`, push, open a PR titled
   `social: two new slideshow decks (<slug-a>, <slug-b>)` with the answers in the
   body so review is quick. Notify with the PR link.
6. `git checkout main` in the runner so the next `run` pulls cleanly.

## `status`

`node scripts/state.mjs status`: every deck with per-platform status and URL,
plus the last run's outcome. Use it to answer "did the post go out".

## Failure modes seen so far

| Symptom | Meaning / fix |
| --- | --- |
| `file_upload` → "only files this session is allowed to read" | Copy to the scratchpad directory and retry (repo paths worked directly on 2026-09-13; see Posting mechanics). |
| `file_upload` → "Element is not a file input" | `find` returned X's wrapper button. Re-run `find` asking for "input type=file". |
| X: image lands in the timeline composer behind the `/compose/post` modal | `find` picked the inline composer's input. Close the modal (X at top-left) and finish in the inline composer; it posts the same way. |
| X: Post/Reply click does nothing, spinner still showing | Media still uploading. Wait 2 s, `find` the button again, click by ref. Check the composer emptied before clicking a second time, so you never double-post. |
| Instagram slides missing header/footer on the crop step | 1:1 default. Pick 4:5 before Next. |
| Second Next click lands on the wrong thing | Dialog resized. Screenshot again, then click. |
| TikTok row says "Only me" | Under review, not an error. Leave it. |
| Tab "is not in Claude's tab group" | The tab was replaced. `tabs_context_mcp` again and use the new id. |
| `git pull --ff-only` fails in the runner | Someone committed in the worktree. Reset it to `origin/main`; nothing there is meant to be kept except in-flight `draft` branches. |

## Install

The scheduled task (`TraderPrepSocialPost`, weekly Tuesday 09:00, runs
`claude -p --chrome "/social-post run"` as the interactive user from the runner
worktree, stdout appended to `logs\run.log`) is registered by
`install\install-schedule.ps1`. Chrome must be open with the extension connected
at 09:00, and all three accounts must be logged in.

`--chrome` is required: a headless `claude -p` does not load the Chrome
integration by default, and the run then fails with "chrome not connected"
even though Chrome is open. To fire the task by hand:
`Start-ScheduledTask -TaskName TraderPrepSocialPost`. Note `run.log` holds only
the session's final message (the stop hooks' reply), so the ledger's `run-end`
note is the real record of what happened.
