---
name: PostgREST unordered-query row cap
description: Freshness/signal queries against Supabase must order newest-first and limit — PostgREST caps at ~1000 rows in unspecified order.
---

Rule: any Supabase query whose result feeds a freshness/"latest data date" computation must add `.order(<dateCol>, { ascending: false }).limit(1000)` (or paginate like `fetchDistinctDates` in the import-tasks DB layer when ALL rows are needed).

**Why:** PostgREST silently caps responses at ~1000 rows in unspecified order. After a few years of daily rows, the NEWEST days can drop out of an unordered result, making a fresh source look stale/overdue in status displays. Found by architect review on the Gastronovi cockpit signal fetchers.

**How to apply:** When adding a new signal/coverage fetcher, decide: freshness-only → order desc + limit; full coverage (day lists) → paginated range loop. Never leave a status-feeding query unordered and unlimited.
