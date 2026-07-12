---
name: supabase-rls-migrations
description: >-
  Use when writing, reviewing, or verifying Supabase Postgres migrations, RLS
  policies, SECURITY DEFINER functions/RPCs, grants, or storage-path code.
  Also when debugging: a policy that silently matches nothing, "infinite
  recursion detected in policy" (42P17), "column reference is ambiguous"
  (42702) from an RPC, "could not choose the best candidate function",
  anon able to call a function that should be authenticated-only, rows
  visible/invisible only for some users, a nested embed coming back null, or
  storage objects that 404 after a move. Covers how to actually test RLS
  (role impersonation, pglite) — service-role probes prove nothing.
---

# Supabase RLS, RPCs & migrations — write it safely, prove it works

## Overview

Two facts drive almost every bug in this area:

1. **RLS is per-table and evaluated in the CALLER'S context** — including
   inside policy subqueries, nested embeds, and child tables. Nothing is
   inherited.
2. **Most failures are silent.** Zero rows, a null embed, or a benign-looking
   fallback — not an error. On top of that, Supabase's defaults differ from
   vanilla Postgres (default EXECUTE grants, `extensions` schema), so the
   textbook idiom is often subtly wrong here.

So: route cross-table checks through SECURITY DEFINER helpers, and never call
a policy verified until you've probed it **as the actual roles**.

## Writing policies

**1. Never inline a subquery against an RLS-protected table inside a policy.**
Two failure modes, both from the same rule (the subquery runs under the
caller's RLS):
- Same table → `42P17 infinite recursion detected in policy`.
- A *sealed* table (RLS on, zero policies — the "all access via RPCs" pattern)
  → the subquery returns no rows for anyone, so the branch is **always false,
  silently**.

Fix: a SECURITY DEFINER helper the policy calls instead:

```sql
create or replace function public.is_member(p_thing_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.thing_members
                     where thing_id = p_thing_id and user_id = p_user_id); $$;
revoke all on function public.is_member(uuid, uuid) from public;
revoke execute on function public.is_member(uuid, uuid) from anon;  -- see #4
grant execute on function public.is_member(uuid, uuid) to authenticated;
-- policy: using ( public.is_member(thing_id, auth.uid()) )
```

Reuse the helper across every table that needs the predicate — single source
of truth.

**2. Gate child tables too.** Tightening the parent's SELECT policy does
nothing for a child table carrying its own `USING (true)` — the child's rows
(paths, captions, metadata) stay world-readable to anyone who knows the FK.
Whenever you privacy-gate a parent, sweep its children (and future children)
for independent blanket-read policies and re-point them at the parent:
`using (exists (select 1 from parents p where p.id = child.parent_id and
<parent is visible>))` — or the shared DEFINER helper.

**3. A nested embed is best-effort, not an authorization answer.** In
`select ..., album:albums(visibility)`, the embed is filtered by the *other*
table's RLS: readable child + unreadable parent ⇒ embed is `null` with no
error. Treat a null embed as **unknown**, never as "no"/"private", and never
derive security or visibility decisions from it — when it matters, fall back
to a SECURITY DEFINER RPC that answers authoritatively.

## Writing functions / RPCs

**4. Supabase auto-grants EXECUTE on every new `public` function to `anon`,
`authenticated`, AND `service_role`** (via shipped `ALTER DEFAULT
PRIVILEGES`). The textbook `revoke ... from public; grant ... to
authenticated;` leaves the anon grant intact. Explicitly
`revoke execute on function public.fn(args) from anon;` and verify:
`select has_function_privilege('anon', 'public.fn(args)', 'execute');`
(A DEFINER function that guards on `auth.uid()` is not *vulnerable* with an
anon grant — this is least-privilege hygiene; the in-function check + RLS is
the real boundary.)

**5. Changing an RPC's parameter list needs an explicit DROP of the old
arity.** `CREATE OR REPLACE` only replaces the *same signature*; a new
defaulted param creates a coexisting overload, and PostgREST then fails with
"could not choose the best candidate function" (or silently binds the wrong
one). In one migration: `drop function if exists public.fn(old, types);` then
create. Verify exactly one row per name:
`select proname, count(*) from pg_proc where pronamespace =
'public'::regnamespace and proname = 'fn' group by proname;`

**6. Qualify extension calls: `extensions.gen_random_bytes(16)`.** Supabase
installs pgcrypto/uuid-ossp into the `extensions` schema, and DEFINER
functions should pin `set search_path = public` — so unqualified calls fail
`42883`. Don't widen search_path; qualify.

**7. In plpgsql, `RETURNS TABLE` columns are OUT-params that collide with
same-named table columns** → `42702 column reference "x" is ambiguous` on
EVERY call, before any branch. Alias tables and qualify every column
(`select ai.grants_role from album_invites ai`). Two amplifiers to watch:
a client catch-all that maps RPC errors to a benign state ("invalid/not
found") turns this hard error into "every input looks revoked" — treat
*every-input-hits-the-fallback* as a thrown-error smell; and the fastest
diagnosis is to curl `/rest/v1/rpc/<fn>` directly as anon — the raw PostgREST
error names the real problem instantly.

## Storage

**8. `storage.list()` is non-recursive and returns folder placeholders.**
Nested objects are invisible to a one-level list, and placeholder entries
(`id === null`) break `remove()`. Enumerate paths from your DB when you have
one; otherwise recurse into `id === null` entries and filter them out of
remove lists.

**9. Moving a storage object must update the DB column that names it, in the
same operation** (per-object, inside the move loop — not after the batch). An
object path and its `storage_path`-style column silently diverge otherwise,
and every `getPublicUrl()` 404s. Repair pattern: guarded UPDATE that only
repoints a row when an object actually exists at the rewritten path; then
sweep for rows whose object is missing.

## Verifying — the part that actually catches these

**10. Service-role connections BYPASS RLS.** The Supabase MCP
(`execute_sql`/`apply_migration`) and any service-key client run with
BYPASSRLS and null `auth.uid()` — a "can user X see row Y" probe through them
is meaningless. Impersonate for real:

```sql
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub', '<uuid>', 'role', 'authenticated')::text, true);
  select count(*) from t where id = '<id>';   -- now subject to RLS as <uuid>
rollback;
```

`set local role anon;` (no claims) for logged-out. Probe the *policy*, not
just the DEFINER RPCs (those bypass RLS by design).

**11. Verify migrations locally with pglite — no live project or paid branch
needed.** `@electric-sql/pglite` (Postgres-in-WASM, zero setup) faithfully
runs roles, `set role`, RLS, column-level grants, and SECURITY DEFINER
semantics. Stub the Supabase-managed bits: `create schema auth; create table
auth.users(id uuid primary key);` plus a fake
`auth.uid() → nullif(current_setting('test.uid', true), '')::uuid` so tests
impersonate via `set test.uid = '<uuid>'`. Then `db.exec(stubs)`,
`db.exec(migrationSql)` verbatim, seed, and assert outputs/permission errors
under each role. Catches semantic bugs (ranking, tie-breaks, hidden columns)
that regex-over-SQL tests can't.

**12. Don't trust `list_tables` row counts** — they're planner estimates
(`pg_class.reltuples`), fine for structure, wrong for "is this table empty".
`select count(*)` when the answer matters.

**13. Target the project by URL host, never by name.** Apps can share one
Supabase project under an unrelated name (traderprep lives in the project
named "trade-or-tighten"). Resolve the ref from `NEXT_PUBLIC_SUPABASE_URL` /
`EXPO_PUBLIC_SUPABASE_URL` and confirm before `apply_migration` — and
remember a shared DB means your migration lands in the other app too.

## Common mistakes

| Mistake | Reality |
|---|---|
| "Policy verified — I queried through the MCP and rows looked right" | Service role bypasses RLS. Only a `set local role` + JWT-claims probe (or the real app) verifies a policy. |
| "The parent table is locked down, so the data is private" | Every child table with `USING (true)` still leaks. RLS is per-table. |
| "The embed came back null, so the user can't access it" | Null embed = unknown (other-table RLS), not false. |
| "`revoke from public` + `grant to authenticated` = authenticated-only" | On Supabase, anon keeps its default grant. Revoke anon explicitly. |
| "CREATE OR REPLACE updated my function" | Not if the arity changed — you now have two overloads and ambiguous RPC calls. |
| "The RPC returns 'invalid' so the input is invalid" | A catch-all may be eating a hard error (42702 etc.). Curl the RPC endpoint raw. |
| "I'll test the migration on prod, it's just a policy" | pglite verifies the full semantics locally in seconds. |

## When NOT to use

Browser-side auth/session/lock behavior → supabase-client-auth. Generic SQL
performance → supabase:supabase-postgres-best-practices (plugin).
