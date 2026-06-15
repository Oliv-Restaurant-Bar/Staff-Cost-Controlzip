---
name: Reporting safe-upsert pattern
description: saveAll() in reporting-store.ts used to do a naive kvSet (full replace) to Supabase, causing data loss for other months when localStorage was stale.
---

## The Rule
Never write the full `reporting_v1` blob to Supabase via `kvSet()`. Always use
`safeUpsertReportingMonth` / `safeDeleteReportingMonth` to update only the
affected month while preserving all other months.

**Why:** `saveAll()` reads from localStorage and writes the whole dict to Supabase
(`kvSet` = upsert on `key`). If localStorage was stale at that moment (fresh login,
different browser, race-condition during startup sync where `syncSupabaseToLocal`
hasn't finished yet), Supabase gets overwritten with an incomplete picture — months
like April disappear permanently.

This is the same root cause as the `dailyBudgets` bug that was fixed earlier with
`safeUpsertDailyBudgets`.

**How to apply:**
- `saveMonth()` → calls `safeUpsertReportingMonth(id, saved, storeKey)` after localStorage write
- `deleteMonth()` → calls `safeDeleteReportingMonth(id, storeKey)` after localStorage delete
- `saveAll()` now only writes localStorage (synchronous fast path)
- Both safe functions live in `src/lib/supabase-kv.ts`

**Pattern:**
1. `kvGet(storeKey)` → get current Supabase state
2. Spread remote as base, set only `[monthId]` = new record
3. `kvSet(storeKey, merged)` + `localStorage.setItem(storeKey, merged)`
