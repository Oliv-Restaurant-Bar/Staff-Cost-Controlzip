---
name: Tenant-safe upsert under authenticated-wide RLS
description: Per-tenant tables whose RLS is authenticated-wide must scope UPDATEs by id AND restaurant_id, not id alone.
---
New per-tenant tables (e.g. `positions`) use RLS that allows ANY authenticated user (REVOKE anon); tenant isolation is enforced in the TS data layer via `restaurant_id` filters, NOT by RLS. So a Supabase `.upsert(row, {onConflict:'id'})` or `.update().eq('id', …)` keyed ONLY on id can overwrite or re-stamp a row belonging to another tenant (stale/crafted id).

**Rule:** split create vs update. UPDATE must filter `.eq('id', id).eq('restaurant_id', tenant)`; INSERT always stamps the current `restaurant_id`. Treat "0 rows affected" (`!data`) as a failure (throw), so a cross-tenant id can't silently no-op.

**Why:** RLS is intentionally authenticated-wide; the DB will NOT stop a cross-tenant write. The only boundary is the query filter.
**How to apply:** any write helper for a per-tenant table that a user can pass an arbitrary/stale id into.
