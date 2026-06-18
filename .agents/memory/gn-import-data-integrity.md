---
name: Gastronovi gn_imports data integrity
description: Non-obvious data-integrity rules for the gn_imports import path (overlap detection, replace verification, batch keying).
---

# gn_imports import data-integrity rules

These are constraints that caused (or would cause) double-counted revenue or lost
imports if violated. They are not obvious from reading the happy-path code.

## Cost-center overlap filter must only apply when cost center is non-empty
`checkOverlappingImports` takes an optional `costCenter`. Apply the cost-center
filter ONLY when the normalized value is a non-empty string; otherwise fall back to
date-only overlap.

**Why:** A batch file whose parser yields `costCenter === null` would, if filtered,
only match existing imports with an empty `cost_center` and MISS same-day active
imports that DO have a cost center → the same day gets a second active import →
double revenue. The single-file path passes no argument (→ empty → date-only), which
keeps its historical behavior unchanged.

**How to apply:** Two same-day imports with different real cost centers (e.g.
Oliv vs Beaulieu) are independent. A same-day import with no/blank cost center must
be treated as overlapping ALL same-day imports.

## A Supabase `.update().eq()` can "succeed" with 0 rows affected
When marking overlapping imports `status:'replaced'`, do
`.update(...).eq('id', id).select('id')` and treat BOTH an error AND zero returned
rows as failure.

**Why:** A stale id, RLS invisibility, or already-changed row makes the update a
no-op that returns no error. Trusting `error == null` alone would leave the OLD
import active alongside the new one → double revenue. On failure, roll back
(reactivate already-replaced ids, mark the new import `deleted`); collect rollback
errors and surface them as a hard "manual reconciliation" error — never swallow.

**Caveat:** This is best-effort client-side compensation, not a DB transaction;
concurrent writers can still race. A server-side RPC/transaction would be the real fix.

## Batch import must key by a stable id, not fileName
Per-file overlaps, plans, save items/results, and UI state must be keyed by a stable
batch id (parser assigns one per file), not by `fileName`.

**Why:** A user can upload two files with the SAME name; keying by fileName collides
and one file's overlaps/plan/result silently overwrites the other's.

## Cumulative multi-day Z-reports are never auto-split
Multi-day (period) reports are flagged with a warning and imported as-is, never
split into per-day rows.
