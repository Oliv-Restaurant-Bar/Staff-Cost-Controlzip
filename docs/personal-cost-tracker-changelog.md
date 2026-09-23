# Personal/Staff Cost Tracker — Phase 1 Changelog

Tracks what's done vs. pending against `docs/personal-cost-tracker-issues.md` and CRM Task #38589.

## 2026-09-08

**Done:**
- **Issue #4 — navigation crash near charts/dialogs.** Root cause: mobile "Mehr" nav sheet (Radix Dialog) stayed open while `navigate()` ran, racing the route unmount against the dialog's own portal cleanup.
  - `src/components/AppNav.tsx` — nav items in `AppBottomNav`/`SheetNavGroup` now close the sheet synchronously before navigating (`handleNavigate`), instead of relying on a reactive `useEffect` that fired after the route had already changed.
  - `src/components/ErrorBoundary.tsx` + `src/App.tsx` — added a `resetKey` (keyed to route path) so the error screen self-recovers on navigation instead of trapping the user on the fallback.
  - `src/pages/MonatsreportPage.tsx` — the PDF export flow no longer touches component state after the user has navigated away mid-export; guarded via a new reusable `src/hooks/useMountedRef.ts` hook.
  - Verified: no other component in the codebase combines a Radix Dialog/Sheet with unguarded `navigate()`, and no other component shares the long-running unmount-unsafe async pattern — confirmed via repo-wide search, so this fix is complete for the bug class, not partial.
- CRM Task #38589 created (project 655, billable) as the umbrella tracker for all Phase 1 items; issues #1–#3 (already fixed pre-session) and #4 checked off.

**Pending:** Issues #5–#8 (see issues doc) — not yet started.

**Next step:** Issue #5 (device-vs-database save priority rework) — this is the root cause behind issues #1–#3, and issues #6–#8 don't depend on it, so it can be picked up independently or first.

## 2026-09-16

**Done:**
- **Issue #4b — a second, different `removeChild` crash in Personalstamm.** Repro: **Personalstamm** → "Neuer Mitarbeiter" → click an existing employee in the left list → app-wide crash. Not the same code path as #4 (that was `AppNav.tsx`'s mobile "Mehr" sheet).
  - Root cause: `src/pages/Personalstamm.tsx`'s detail panel (`<main>` right after `{detailOpen && (`) renders many Radix `Select`s and had no `key` tied to which employee/mode was shown. Switching `selectedId`/`editMode` in one click (e.g. new-employee edit form → an existing employee's view) let React patch the existing DOM in place instead of unmounting it first; if a Select's portal was mid-cleanup, React and Radix could race to remove the same node.
  - Fix: added `key={selectedId}|{editMode}` to that `<main>` block, forcing a full unmount/remount on every employee/mode switch.
  - **Not confirmed against a live repro** — the crash is timing-dependent and did not reproduce on demand (tried plain clicks, clicks with a Select dropdown left open, and double-clicking "Neuer Mitarbeiter"), before or after the fix. The fix closes a real, identified reconciliation hazard, but please retest the original repro in the panel and flag it if it still happens.

**Pending:** Issues #5–#8 unchanged (see issues doc).

## 2026-09-23

**Done:**
- **Issue #5 — app trusted the device more than the database (root cause).** Design: `feature-plans/device-db-save-priority/01-initial-plan.md`.
  - `src/lib/supabase-kv.ts`: `safeUpsertDailyBudgets` now writes to Supabase first and only caches to `localStorage` after that write is confirmed (previously wrote `localStorage` first, unconditionally, with no rollback on a failed Supabase write). Added `kvSetConfirmed()`, a database-first replacement for the widespread `localStorage.setItem(...); kvSet(...).catch(...)` fire-and-forget pattern, for incremental adoption elsewhere later.
  - `src/hooks/useSyncStore.ts`: on tenant switch, now pulls from Supabase before pushing local data (was push-then-pull) — the device is brought up to the authoritative remote state first.
  - Audited `safeUpsertReportingMonth`/`safeDeleteReportingMonth`: already database-first, no change needed there.
  - Verified: `tsc --noEmit` passes. Full test suite (`npx vitest run`) re-run before and after the change — identical failing-test set (the pre-existing baseline documented in `CLAUDE.md`), confirming no regression. One existing test (`round27-safe-blob-persistence.test.ts`, "F07 Daily: Remote-Lesefehler...") initially broke because it locks in a *different*, intentional pre-existing behavior (cache the user's edit locally when the remote *read* fails, since there's no write attempt to roll back) — this was preserved, not the test changed.
- **Issue #5 follow-up — migrated the remaining KV-layer call sites** (full list and reasoning in `docs/personal-cost-tracker-issues.md` under issue #5):
  - Reordered to database-first: `season-definitions-db.ts`, `kpi-targets-db.ts`, `kpi-comments-db.ts`, `import-settings-db.ts` (2 functions), `import-undo-store.ts`, `reporting-store.ts`'s `saveJournalEntriesStrict`.
  - Migrated to the new `kvSetConfirmed()` helper: `ta-gaeste-store.ts`, `artikel-store.ts`, `rezeptur-store.ts`, `basiskomponenten-store.ts`, `maison-store.ts` (all 4 save functions), `gaeste-store.ts`, `kreditoren-abgleich.ts`, `personalfix-flex-overrides.ts`, `annual-cost-imports-store.ts`, `lieferanten-profile.ts`.
  - Bugfix found in passing: `maison-store.ts`'s `saveMaisonDailyMergeStrict` used non-throwing `kvGet` despite its own doc comment promising strict (throw-on-read-failure) semantics — a failed read could have silently wiped every day outside the current import. Fixed to use `kvGetStrict`.
  - Made previously fully-silent failures visible (toast+retry): `social-costs-db.ts`, `ziel-warenquote.ts`, `ziel-personalquote.ts`, `useShiftConfig.ts`, `account-mapping-store.ts` (kept optimistic-local for its 6+ synchronous UI call sites, but no longer swallows errors with zero signal).
  - Deliberately left as-is, with reasoning logged in the issues doc: `reporting-store.ts`'s `saveMonth`/`clearManualUmsatzField`/`replaceAnnualCostYear` (synchronous, ~19+ diffuse call sites — but the previously-silent failure paths were still fixed to show a toast), `import-cockpit-checks-db.ts` (documented by design as local-primary, no financial impact), `waren-db.ts` (~30 sites, already has a deliberate per-call strict/non-strict split), page/hook-level files with large `localStorage` usage that mostly mirror already-DB-confirmed table writes (`SchedulePlanner.tsx`, `usePersonnelData.ts`, `TagesansichtPage.tsx`, `Warenrechnungen.tsx`).
  - Verified: `tsc --noEmit` passes (see caveat below); full test suite re-run after every round — same pre-existing failing-test baseline, no regressions. 5 test files' `vi.mock('@/lib/supabase-kv', ...)` blocks needed updating for the new `kvSetConfirmed` export (`lieferanten-profile-lernen`, `marketing-import`, `personalfix-flex-overrides`, `tagesdaten-regression`, `verkaufsdaten-import`).
- **Issue #5 follow-up, part 2 — `budget-store.ts` fully converted to database-first** (same day, user asked to continue further than the initial follow-up):
  - **Real bug found first:** `Budget.tsx`/`PLView.tsx`'s top-down allocation and undo/restore features called `savePLLineItem()` once per account in a `for` loop, silently relying on each call's synchronous `localStorage` read seeing the *previous* iteration's just-written state — no actual merge logic tied them together. Added `savePLLineItems()` (one batched read-modify-write) and switched all 5 loop sites to it (`Budget.tsx`: `applyTopDown`, `applyTopDownMonth`, `restoreTopDownSnapshot`; `PLView.tsx`: `applyBplTopDownMonth`, `restoreBplSnapshot`).
  - Converted the entire `budget-store.ts` save chain to async/database-confirmed (`saveAll`, `saveBudgetYear`, `deleteBudgetYear`, `copyBudgetYear`, `updateBudgetPosition`, `addBudgetRule`, `removeBudgetRule`, `restoreMissingDefaultPLItems`, `resetPLToDefaults`, `deletePLLineItem`, `savePLLineItem(s)`, `addCustomPLLineItem`, `removeCustomPLLineItem`, `resetBudget2026ToSeed`) and threaded `await` through all ~30 call sites in `Budget.tsx`/`PLView.tsx`, including two real regressions caught only by this: `Budget.tsx`'s copy-year and delete-year handlers read `availableBudgetYears()`/`reload()` (both synchronous, localStorage-backed) immediately after the now-async save — fixed by awaiting the save first.
  - Backup failures now distinguish "Supabase unreachable" (still caches locally — no database to disagree with the device) from "Supabase reachable but rejected the write" (does not cache locally) — same exception already established for `safeUpsertDailyBudgets`'s read-failure case. Updated 3 tests (`budget-store-kv-backup.test.ts` ×2, `round27-safe-blob-persistence.test.ts` ×1) that had locked in the old "always cache locally, even on a real write failure" behavior as correct; a 4th (genuinely-offline) test needed no change since the new logic already agrees with it.
  - Fixed a subtle same-promise race while building this: the local-cache write must be chained *inside* the same queued step as the Supabase backup, not as a separate `.then()` after it — otherwise `kvBackupQueue`/`flushBudgetKVBackups()` could resolve one microtask before the local write actually ran, an intermittent race for any caller/test awaiting the queue.
  - **Significant tooling discovery:** `npm run typecheck` (bare `tsc --noEmit`) is a no-op — the root `tsconfig.json`'s `"files": []` + project-references setup means it checks nothing without `--build`, confirmed by deliberately introducing a type error and getting zero output. All verification in this session (this fix and the item above) was redone against the real check, `npx tsc --noEmit -p tsconfig.app.json`, which reports a pre-existing baseline of ~252 errors unrelated to this work (confirmed via before/after diff, not just count). Documented in `CLAUDE.md`. **Recommend flagging this to the client/team** — any CI or pre-deploy gate relying on `npm run typecheck` has not actually been checking anything.
  - Verified: real `tsc --noEmit -p tsconfig.app.json` shows zero new errors (252 before and after, same set via diff); full test suite shows zero new failures (same pre-existing baseline via diff, one confirmed-flaky test aside).

**Pending:** Issues #6–#8 unchanged (see issues doc).
