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

## Hardening (Jahresimport-Schreibschutz, Juli 2026)
- `safeUpsertReportingMonth` had a destructive catch-fallback (`kvSet` with a
  ONE-month blob = full blob replace) — removed; errors now throw. Never
  reintroduce a "write just this month as the whole blob" fallback.
- Supabase doesn't throw on write errors: always check the returned `{ error }`
  from `.upsert()` explicitly, or failures pass silently as success.
- `kvGet` returns `null` on read errors (indistinguishable from "no blob yet"):
  merge localStorage months as base-union (`{...local, ...remote, [monthId]: rec}`,
  remote wins per month) so a failed remote read never shrinks the store.
- Year-scoped bulk writes (`replaceAnnualCostYear`/`removeAnnualCostYear`) must
  run `assertYearScopedChanges(before, after, targetYear)` BEFORE any write —
  aborts if any foreign-year record would change; KV backup runs SEQUENTIALLY
  (parallel safeUpserts on the same blob race last-writer-wins) and reports
  `failedMonths` for a visible user warning.

## Runde 2.7: Delete braucht dieselbe Basis-Union wie der Upsert
- The DELETE path lacked the local base-union: a silently failed `kvGet` (→ null)
  made the base `{}`, and writing `rest` of `{}` wiped ALL months remotely.
  Upsert and delete now share one internal merge core so the invariants
  (base-union, explicit `{error}` check, localStorage AFTER remote success,
  notifyKV AFTER setItem, throw without destructive fallback) can never diverge
  again. **Rule:** any scoped mutation of a shared blob (add OR remove) needs the
  identical read→union→mutate→verify write pipeline — deletes are not exempt.
- Decision (Entscheid B, Runde 2.7): NO generic cross-domain `safeBlobUpsert`.
  Merge granularity/ordering/error policy are domain-critical and differ
  (Budget year-merge newer-wins+tombstones; Daily field-merge remote>0-wins,
  localStorage BEFORE remote; Reporting month-replace, localStorage AFTER remote;
  Budget/Daily notify+retry vs. Reporting throws). Only dependency-free technical
  guards live centrally in `kv-blob-utils` (`asRecordBlob`, `readLocalRecord` —
  Supabase-free so load paths don't pull a static Supabase import).
- Documented limit (pre-existing, accepted): reporting has NO tombstones — a
  stale device's localStorage can re-add a month deleted elsewhere via the union.
  Correct tradeoff vs. the remote-wipe alternative; don't "fix" by dropping the union.
