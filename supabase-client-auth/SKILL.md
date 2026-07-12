---
name: supabase-client-auth
description: >-
  Use when writing or debugging browser-side Supabase auth (supabase-js v2):
  login spinners that never resolve, getSession() hanging, logged-in users
  intermittently unable to act while logged-out works, clicks silently doing
  nothing, "temporarily unavailable" errors while server logs show 200,
  navigator.locks / auth-token lock contention, entitlement gating or
  fail-open decisions, auth-callback pages, or timeouts around
  supabase.auth/rpc calls. Also when adding any new client code that awaits
  getSession(), signInWithPassword(), or an authenticated RPC.
---

# Supabase client auth — surviving the auth lock

## Overview

supabase-js v2 serializes all browser token access through one **exclusive
cross-tab Web Lock**: `lock:sb-<project-ref>-auth-token`. One wedged tab
(frozen/stuck while holding it) starves **every tab on the origin, forever** —
and auth-js's built-in steal-recovery does not save you (verified: the steal
frees the lock for ~6 ms and the frozen context immediately re-grabs it).

Every incident in this family looked like a different bug — login hanging,
Start buttons silently dead for logged-in users, "Billing temporarily
unavailable", "Couldn't load your messages" — and every one was the same root
cause reached through an unbounded await, a mis-ordered timeout, or trusting
an unresolved auth state.

**Core principle: no UI path may await the auth lock unbounded, and no gate
may treat "auth unknown" the same as "denied."**

## Diagnosis playbook (symptom → proof)

Run these BEFORE touching code — they distinguish the lock from a real
server/env problem in minutes:

| Check | How | Means |
|---|---|---|
| Lock wedged? | `await navigator.locks.query()` in the page console | `lock:sb-<ref>-auth-token` in `held` with entries in `pending`, persisting across checks = wedged. An `ifAvailable` request returning null confirms. |
| Server actually broken? | Replay the failing POST with the token read straight from localStorage (`sb-<ref>-auth-token` → `.access_token`) | 200 = server fine; the failure is the client's lock path. |
| Client timed out, not errored? | Server/API logs show 200 for the "failed" call | Client gave up before the (successful) response arrived — check timeout ordering (below). |
| Login broken on ONE deploy only? | `TypeError: Headers.append: "Bearer …" is an invalid header value` in runtime logs | Control char (stray newline) in the pasted `ANON_KEY`/URL env var — re-enter it, redeploy (`NEXT_PUBLIC_*` is baked at build). `.trim()` at read sites as defense. |

**Immediate user remedy for a wedge (no deploy):** close ALL tabs of the
origin (one frozen tab is the holder) or restart the browser.

## Client construction — build the resilience in

**1. Replace the lock primitive at `createClient`.** Bound acquisition with an
`AbortController`; on timeout, **run the operation WITHOUT the lock**. Do NOT
re-request or steal — that's auth-js's own recovery and it loses the
steal→re-grab race. This is the only fix that also covers `signInWithPassword`
(login *establishes* the session, so a localStorage-token fallback can't help
there). Reference implementation: traderprep `lib/auth-lock.js`
(`createTimeoutAuthLock`, `AUTH_LOCK_TIMEOUT_MS = 5000`), wired in
`lib/supabase-client.js`.

**2. Never await `getSession()` unbounded.** Cap it with a timeout race, and
on timeout fall back to the session persisted in localStorage — that read
needs no lock and works during a real wedge. Skip expired tokens. Reference:
traderprep `lib/with-timeout.js` + `lib/persisted-session.js`.

**3. Timeout hierarchy — per-call timeout > lock timeout.** Any `withTimeout`
wrapping a lock-gated call (`rpc()`, `getSession()`) must EXCEED the lock's
own acquire timeout, or every burst of lock contention becomes a spurious
client error while the server quietly succeeds (the 4000 < 5000 inbox bug).
Derive it, never hardcode: `CALL_TIMEOUT = AUTH_LOCK_TIMEOUT_MS + network
headroom` (e.g. +3000).

**4. Always `await` query builders.** supabase-js builders are lazy thenables —
a fire-and-forget `supabase.from(x).update(...)` with no `await`/`.then()`
**never sends the request**, silently. In sync handlers use
`.then(() => {}, () => {})`.

## Gate decisions — unknown ≠ denied

**5. Three-state gate logic.** Auth state starts `null` and resolves async;
UI (forms, buttons) usually renders before it resolves. A gate that returns
the same falsy "no" for *unknown* and *denied* silently eats clicks landing in
the resolution window. During unknown: consult the lock-free persisted
session (token present ⇒ treat as logged in, route to a server check) or ask
the server; deny only on confirmed no-session.

**6. Fail-open vs fail-closed depends on the consumer.** On timeout/error,
failing open to "entitled" is right for **gating** (never false-block a
payer; the server re-checks every gated action) but wrong for **advertising**
("Your current plan" flashed to a free user). Carry a confirmation flag next
to the value — `{ isEntitled, entitlementConfirmed }` — so gating trusts the
guess and display surfaces require `confirmed`.

**7. Optimistic claims off a prefetch.** If a mount-time status prefetch
already proves the user can act, resolve the claim instantly and fire the
consuming RPC in the background to reconcile; await the server only when the
prefetch hasn't resolved. Single-flight guards (one on the call, one on the
RPC) keep a double-click to one consumption.

## Auth-state side effects fire more than once

**8. One-shot guards on session-detection side effects.** Session detection
is inherently multi-path (`onAuthStateChange` listener + `getSession()` poll,
plus any layout/header component independently resolving auth on every
route). Idempotent state-setting tolerates that; a **side effect** (starting
checkout, `router.replace`) fires once per path — twice. Wrap the terminal
action in a `useRef(false)` one-shot. Regression test: drive BOTH the event
and the poll, assert `callCount === 1`.

**9. Claim-at-start flips `blocked` mid-play.** When a gate consumes the
play/quota at start, `blocked` becomes true *as a side effect of starting*.
Any "you're out of plays" wall rendered purely off `blocked` will clobber or
flash over the just-started session. Gate walls on
`blocked && <on the pre-game screen> && !startInFlight` — all three.

## Common mistakes

| Mistake | Reality |
|---|---|
| "Login hangs — must be our auth code / env" | Check `navigator.locks.query()` first. A wedged lock reproduces every auth symptom with zero code bugs. |
| "Server logs 200, so the client code is buggy" | The client *timed out* before the response landed. Check timeout ordering vs `AUTH_LOCK_TIMEOUT_MS`. |
| Tightening an RPC timeout "to fail faster" | Below the lock timeout it guarantees spurious failures under contention. Faster ≠ shorter than the lock. |
| Relying on auth-js steal-recovery | Verified ineffective: the frozen holder re-grabs in ms. Bound-then-proceed-without-lock is the fix. |
| Reusing a session-detection scaffold on a page with side effects | The dual detection that was harmless for idempotent state double-fires your checkout. One-shot ref. |
| Returning `{ok:false}` while auth is still resolving | Indistinguishable from denial at the call site → silently dropped clicks. Unknown is its own branch. |

## When NOT to use

Server-side auth (service-role clients, webhook handlers) — no Web Lock
there. RLS/policy/migration questions → see supabase-rls-migrations.
