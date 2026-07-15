---
name: app_settings typed wrapper
description: How app_settings table access is typed despite missing from generated Supabase types; rules for extending or reusing the pattern.
---

# app_settings typed wrapper (Runde 2.8)

**Rule:** All `app_settings` access goes through `appSettingsTable()` in `src/lib/app-settings-table.ts`. Never write `(supabase as any).from('app_settings')` or `supabase.from('app_settings')` anywhere else.

**Why:** `app_settings` is missing from the auto-generated Supabase types (`types.ts`), which must never be hand-edited (regenerated/overwritten). Untyped access forced `supabase as any` at every call site. The wrapper isolates exactly ONE double-cast `(supabase as unknown as SupabaseClient<AppSettingsDatabase>)` with a local, narrow `AppSettingsDatabase` type — no `any` reaches callers.

**How to apply:**
- `AppSettingsRow` is `{key: string; value: unknown}` — `value` is deliberately `unknown`, NOT `Json`: domain interfaces without index signatures would need `as unknown as Json` double-casts with zero safety gain. Domain guards (`asRecordBlob` etc.) stay responsible for shape checks. `updated_at` is deliberately untyped (never read anywhere).
- Wrapper is parameterless and imports the singleton client, so existing test mocks of `@/integrations/supabase/client` keep intercepting.
- Same pattern (local table-type wrapper, Option B) is the preferred fix for the many remaining `supabase as any` casts on OTHER live-only tables (artikel-store, sales-db, wage-history, gn-*-db, guest-*-db, import-runs-db, …) — migrate per table, never edit types.ts.
- Supabase query builders are Thenables (PromiseLike), not Promises: helpers like `withTimeout` must accept `PromiseLike<T>` when a builder is passed directly (runtime-neutral, `Promise.race` handles thenables).
