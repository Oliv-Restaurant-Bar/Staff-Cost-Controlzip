---
name: Reporting multi-month KV backup race
description: Parallel fire-and-forget blob upserts from saveMonth loops overwrite each other with stale month values; multi-month writes must back up sequentially.
---

# Reporting multi-month KV backup race

**Rule:** Never call `saveMonth` in a multi-month loop with its default fire-and-forget KV backup. Pass `skipKvBackup: true` and afterwards run ONE sequential `retryReportingMonthsBackup(monthIds, storeKey)`; surface failures via `notifyKVBackupProblem` with a retry action.

**Why:** `safeUpsertReportingMonth` → `mergeAndWriteReportingBlob` has NO internal queue. Each call reads the remote blob, applies the base union (`{...localBase, ...remote}` — remote wins per month), mutates only its own target month, and writes the WHOLE blob. N parallel calls all read the old remote state: each write carries its own month new but every OTHER month at the stale remote value. The last writer wins — leaving up to N−1 months stale in the KV backup (silent divergence from localStorage). Months never disappear (base union), but values silently revert remotely.

**How to apply:** Any flow writing multiple reporting months in one action (year transfers, annual cost imports, bulk edits). Precedent: `replaceAnnualCostYear` writes localStorage itself and runs its own sequential KV backup; the vj_daily→Erfolgsrechnung transfer uses `saveMonth(..., {skipKvBackup:true})` + sequential `retryReportingMonthsBackup`. Single-month saves keep the default behavior. Note: `retryReportingMonthsBackup` reads local state fresh (never stale snapshots) and is a silent no-op offline (availability gate) — consistent with offline = hint, not error.
