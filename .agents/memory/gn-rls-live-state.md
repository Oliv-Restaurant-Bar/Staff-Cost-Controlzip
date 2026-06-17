---
name: gn_* RLS live-DB state & diagnosis
description: How the live Supabase DB RLS state for gn_* tables diverged from migration files, and how to diagnose RLS vs GRANT failures empirically.
---

# gn_* tables: live RLS state diverged from migration files

The live Supabase DB had **RLS ENABLED on `gn_imports` (and the other `gn_*`
Z-Bericht tables) with ZERO policies** → Postgres default-denies every access.
This happened even though `20260617_gn_zbericht.sql` contains
`ALTER TABLE ... DISABLE ROW LEVEL SECURITY`. That DISABLE was **never effective
on the live DB** (table created with RLS on / RLS re-enabled), while the
`GRANT ... TO authenticated, anon` from `20260617_gn_grants.sql` **was** applied.

**Why this matters:** migration files are NOT a reliable picture of the live DB.
Supabase enables RLS by default on new tables; a `DISABLE RLS` line in a setup
script can silently not take effect. Always verify RLS state empirically before
trusting the SQL on disk.

## Diagnostic recipe (distinguish RLS-deny vs missing-GRANT)
Insert a throwaway row via PostgREST with different keys and read the error code
(both are SQLSTATE `42501`, but the message differs):
- **anon / authenticated key** → `new row violates row-level security policy`
  ⇒ GRANT exists, RLS is enabled with no permissive policy.
- **service_role key** → `permission denied for table ...`
  ⇒ that role simply lacks a table GRANT (service_role had NO grant here, because
  the grants only targeted authenticated/anon).
Postgres checks **GRANT before RLS**, so the message tells you which layer blocks.

## Credentials reality (this repl)
- `SUPABASE_ACCESS_TOKEN` (`sbp_…`) is **rejected (401)** by the Management API
  (`api.supabase.com/v1/projects`), so DDL/pg_catalog cannot be run
  programmatically. DDL must be pasted into the Supabase SQL Editor (the project's
  standard manual-migration workflow).
- `SUPABASE_SERVICE_ROLE_KEY` is the new `sb_secret_…` format (not a JWT). It
  works for PostgREST data ops (bypasses RLS) but cannot run DDL and needs a
  table GRANT to write.
- `PG*` / `DATABASE_URL` secrets are Replit's built-in DB, **not** Supabase; there
  is no Supabase DB password available, so no direct psql/pooler DDL path either.

**Fix shipped:** `supabase/migrations/20260619_gn_rls_fix.sql` — enables RLS,
drops all old policies, creates authenticated-only SELECT/INSERT/UPDATE/DELETE
policies, grants authenticated+service_role, REVOKEs the over-broad anon grants,
and self-tests an authenticated insert (`SET LOCAL ROLE authenticated`) that
fails hard if RLS still blocks. Mirrors the `employee_wages` RLS-fix pattern.
