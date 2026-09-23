# Personal/Staff Cost Tracker — Issue List (Phase 1)

Source: code review + roadmap doc (https://crmai.enacton.com/artifacts/625/personal-cost-tracker-code-review-and-fixes-plan), verified against the actual codebase (`Oliv-Staff-Control`). CRM tracking: Task #38589, project 655 ("Phase 1 — Bug Fixes & Reliability").

The app UI is German. Each item below gives the exact screen/menu path and German labels to use when testing in the panel, plus the English meaning.

---

## Fixed

### 1. Editing two shifts at once could lose one
**What happened:** Editing two shifts for the same day/employee close together could cause one edit to silently overwrite the other.
**Fix:** Saves are now handled per full day as one unit instead of per individual shift cell.
**How to test in panel:**
1. Go to **Dienstplanung** (`/personal`) — nav label "Dienstplanung", short label "Dienst".
2. Pick an employee's day, open two shift cells for the same day in quick succession, edit both, save both.
3. Reload the page — both edits should be present. Before the fix, one could vanish.

### 2. Saving one month's report could wipe another
**What happened:** Saving a monthly report under certain conditions replaced a different month's saved file instead of writing its own.
**Fix:** Saves now merge into existing data instead of replacing the whole file.
**How to test in panel:**
1. Go to **Cockpit** (`/` or `/monatsreport`).
2. Save/export a report for one month (e.g. via the PDF-export menu), then switch month and save again.
3. Go back to the first month and confirm its data is still intact.

### 3. Employee records disappearing and reappearing
**What happened:** Employee records could vanish from lists and later reappear, from four separate causes (including connection-drop artifacts).
**Fix:** All four causes addressed.
**How to test in panel:**
1. Go to **Personalstamm** (`/personal-stamm`) — nav label "Personalstamm".
2. Browse the employee list under a flaky/throttled connection (or refresh repeatedly while switching tabs).
3. Confirm no employee rows disappear or duplicate across reloads.

### 4. App could crash while switching pages (near a chart or open dialog)
**What happened:** On mobile, the bottom "Mehr" (More) menu is a dialog/sheet. Tapping a nav link inside it triggered navigation while the sheet was still open, racing against React's page unmount — most visible when leaving a page with a chart open.
**Fix:** The "Mehr" sheet now closes synchronously before navigating, for every nav item (`src/components/AppNav.tsx`). Also hardened: the error screen now recovers automatically on route change instead of getting stuck (`src/components/ErrorBoundary.tsx`), and the Cockpit's PDF export no longer touches page state after you've navigated away mid-export (`src/pages/MonatsreportPage.tsx`).
**How to test in panel:**
1. On a mobile-width browser window (or phone), open any chart-bearing page, e.g. **Cockpit** (`/`).
2. Tap **Mehr** in the bottom nav bar to open the full navigation sheet.
3. Tap any nav item (e.g. "Dienstplanung") to navigate away.
4. Confirm the page switches cleanly — no crash screen ("Seite konnte nicht geladen werden").
5. Repeat a few times switching between different chart pages (Cockpit, Produktanalyse) via "Mehr".

### 4b. App could crash in Personalstamm when switching employee/mode mid-click
**What happened:** A different "removeChild" crash than #4, in **Personalstamm** (`/personal-stamm`): clicking **"Neuer Mitarbeiter"** and then clicking an existing employee in the left list (or otherwise switching which employee/mode the detail panel shows) could crash the whole app with `Failed to execute 'removeChild' on 'Node'`. Root cause: the detail panel's edit form contains many Radix `Select` dropdowns, and the panel had no `key` tied to which employee/mode it was showing — so React tried to patch the existing DOM in place across the switch instead of tearing it down first. If a Select's portal had anything mid-cleanup at that moment, React and Radix could race to remove the same DOM node, crashing the app.
**Fix:** The detail panel (`src/pages/Personalstamm.tsx`, the `<main>` block right after `{detailOpen && (`) now has `key={selectedId}|{editMode}`, forcing a full remount whenever the shown employee or edit/view mode changes, instead of an in-place patch.
**Caveat:** This is a timing-dependent race — it could not be reliably reproduced on demand (several manual and scripted repro attempts, including with a Select dropdown left open, did not trigger it), so the fix is based on identifying and closing the reconciliation hazard in the code, not on watching the crash reproduce and then disappear. Please retest the original repro (Personalstamm → "Neuer Mitarbeiter" → click an existing employee in the left list, a few times in a row) and flag it if it still happens.
**How to test in panel:**
1. Go to **Personalstamm** (`/personal-stamm`).
2. Click **"Neuer Mitarbeiter"**.
3. Click on an existing employee in the left list. Repeat a few times with different employees, including quickly.
4. Confirm no crash screen ("Seite konnte nicht geladen werden") appears.

### 5. App trusts the device more than the database (root cause)
**What happened:** Saves were considered "done" once they reached the device, before the database confirmed them. This was the underlying cause behind issues #1–#3 above. Confirmed in two places: `src/lib/supabase-kv.ts`'s `safeUpsertDailyBudgets` wrote to `localStorage` *before* attempting the Supabase write, with no rollback on failure; and `src/hooks/useSyncStore.ts` pushed local data to Supabase *before* pulling the authoritative remote state down on every tenant switch.
**Fix:**
- `safeUpsertDailyBudgets` now writes to Supabase first and only caches the result to `localStorage` after that write is confirmed. If the write fails, `localStorage` is left untouched (last confirmed state) instead of caching a value the database never accepted. (One exception, intentionally unchanged: if the *read* used to compute the merge basis fails, there is nothing to write against, so the write is skipped but the user's own edit is still cached locally — this was a pre-existing, separately-tested behavior from an earlier fix round and is a different case from a save being rejected.)
- Added a new `kvSetConfirmed()` helper in `supabase-kv.ts` as a database-first replacement for the common `localStorage.setItem(...); kvSet(...).catch(...)` pattern used elsewhere in the codebase, for future migration of individual call sites.
- `useSyncStore.ts` now pulls from Supabase before pushing local data on a tenant switch, so the device is brought up to the authoritative remote state first.
- `safeUpsertReportingMonth`/`safeDeleteReportingMonth` were audited and found to already be database-first (the `localStorage` write there already only happens after the Supabase write succeeds) — no change needed.
**Follow-up migration of the other call sites:** the initial pass above fixed the root-cause code paths, then the remaining ~50 files that write through the KV layer were audited and migrated where it was safe and proportionate to do so:
- **Reordered to database-first** (write Supabase first, cache to `localStorage` only after confirmed): `season-definitions-db.ts`, `kpi-targets-db.ts`, `kpi-comments-db.ts`, `import-settings-db.ts` (both `saveImportSettings` and `saveInventurChecks`), `import-undo-store.ts`, `reporting-store.ts`'s `saveJournalEntriesStrict` (the undo/restore path).
- **Migrated to the new `kvSetConfirmed()` helper** (was `localStorage.setItem` + fire-and-forget `kvSet(...)`, now confirmed-write-then-cache): `ta-gaeste-store.ts`, `artikel-store.ts`, `rezeptur-store.ts`, `basiskomponenten-store.ts`, `maison-store.ts` (all four save functions), `gaeste-store.ts`, `kreditoren-abgleich.ts`, `personalfix-flex-overrides.ts`, `annual-cost-imports-store.ts`, `lieferanten-profile.ts`.
- **Bugfix found while touching `maison-store.ts`:** `saveMaisonDailyMergeStrict`'s own doc comment already promised "read failure ≠ empty, aborts instead of wiping" (matching its `safeUpsertDailyBudgets`-style intent), but the code used the non-throwing `kvGet` instead of `kvGetStrict` — a failed read silently looked like "remote is empty" and could have replaced the whole blob with only the newly-imported days, deleting every other day. Fixed to actually use `kvGetStrict`.
- **Fully-silent failures made visible** (write already went through `kvSet`, which never throws — a failure had literally no signal anywhere, not even a console warning users would see; now shows the same toast+retry as everywhere else): `social-costs-db.ts`, `ziel-warenquote.ts`, `ziel-personalquote.ts`, `useShiftConfig.ts`.
- **`account-mapping-store.ts`:** kept optimistic-local writes (its 6+ call sites across `CSVImport.tsx`/`PLView.tsx`/`AccountMapping.tsx` read the value back synchronously right after saving — a full async/confirmed rewrite would ripple through all of them for a low-stakes settings type), but the previously fully-silent `.catch(() => {})` now shows a visible error toast.
- **`budget-store.ts` — fully converted to database-first** (2026-09-23, follow-up session): unlike `reporting-store.ts` below, this one *was* converted, because the loop-based chaining bug (next item) made leaving it alone untenable. Full details in the changelog's 2026-09-23 entry; summary:
  - **Real correctness bug found and fixed first:** `Budget.tsx`'s and `PLView.tsx`'s top-down-allocation/undo features called `savePLLineItem()` once per affected account in a `for` loop. Each call re-reads the budget from `localStorage` fresh, so the loop only "worked" because everything was synchronous — item 2's save silently depended on item 1's write having already landed. Fixed by adding `savePLLineItems()` (one batched read-modify-write for N items) and switching all 5 loop sites (`applyTopDown`, `applyTopDownMonth`, `restoreTopDownSnapshot` in `Budget.tsx`; `applyBplTopDownMonth`, `restoreBplSnapshot` in `PLView.tsx`) to it.
  - **Then converted the whole save chain to async/database-confirmed:** `saveAll` (internal), `saveBudgetYear`, `deleteBudgetYear`, `copyBudgetYear`, `updateBudgetPosition`, `addBudgetRule`, `removeBudgetRule`, `restoreMissingDefaultPLItems`, `resetPLToDefaults`, `deletePLLineItem`, `savePLLineItem`, `savePLLineItems`, `addCustomPLLineItem`, `removeCustomPLLineItem`, `resetBudget2026ToSeed` — all now `Promise`-returning, awaited at every one of their ~30 call sites in `Budget.tsx`/`PLView.tsx` (converting the enclosing handlers to `async` where needed).
  - **Offline is NOT treated as a write failure:** matching the existing exception already established for `safeUpsertDailyBudgets`'s read-failure case, `backupBudgetsToKV` now distinguishes "Supabase unreachable/not configured" (still caches locally — there's no database to disagree with the device) from "Supabase reachable but rejected the write" (does NOT cache locally — this is the actual bug). Getting this distinction right mattered: three existing tests explicitly asserted the *old* "always cache locally" behavior as correct, including for genuine write failures — those were updated to the new, intentionally different behavior (see changelog for exact list); a fourth (the genuinely-offline case) needed no change because the new logic already produces the same result for that case.
  - **Found the real fix for a subtle same-promise race** while building this: naively attaching the local-cache write as a separate `.then()` after the backup promise (rather than inside the same queued step) would let `kvBackupQueue`/`flushBudgetKVBackups()` resolve one microtask before the local write actually happened — an intermittent race for any caller awaiting the queue. Both are now chained inside one step (`queueBudgetsBackup`).
- **`reporting-store.ts`'s `saveMonth`/`clearManualUmsatzField`/`replaceAnnualCostYear` — deliberately left synchronous/optimistic-local:** unlike `budget-store.ts` above, converting these would ripple through a genuinely large, diffuse set of ~19+ fire-and-forget call sites across many pages (not a small, contained set of loops), for less proportional benefit right now. What *was* a real gap — `saveMonth`/`clearManualUmsatzField` only `console.error`'d a failed backup with **no signal to the user at all** — is fixed regardless (visible toast+retry), independent of the ordering question.
  - `import-cockpit-checks-db.ts` — its own header comment explicitly documents localStorage-as-primary/KV-as-best-effort-backup by design, for manual checklist checkmarks (no financial impact). Left as documented.
  - `waren-db.ts` (~30 KV call sites) — already has a deliberate `options?.strict ? kvSetStrict : kvSet` split per call site (caller opts into strict where it matters) and almost no local-caching pattern to reorder; a full sweep here is lower-priority follow-up, not a live "device vs. DB" bug.
  - Page/hook-level files with large embedded `localStorage` usage (`SchedulePlanner.tsx`, `usePersonnelData.ts`, `TagesansichtPage.tsx`, `Warenrechnungen.tsx`) — most of their `localStorage.setItem` calls mirror data already confirmed via direct Supabase table writes in `supabase-db.ts` (schedule/actual-hours), which is a different, already-safe persistence path (see issue #3). These were not touched in this pass; a dedicated review is recommended before assuming they share this issue.
  - `tenant-utils.ts`'s `tkvSet` — unused (zero callers), left alone.
**Verification:** ⚠️ discovered mid-session that `npm run typecheck` (bare `tsc --noEmit`) is a **no-op** — the root `tsconfig.json` has `"files": []` with project references, so running `tsc` without `--build` checks nothing at all (confirmed by deliberately introducing a type error and seeing it produce zero output). The real check is `npx tsc --noEmit -p tsconfig.app.json`, which surfaces a pre-existing backlog of ~252 type errors across the codebase (unrelated to this fix — a stashed-vs-working-tree diff confirmed none of them were introduced here). This is a significant, separate finding — see the note added to this project's `CLAUDE.md` "Commands" section. All work in this issue was verified against the real command: zero new errors beyond the pre-existing 252 (confirmed by diffing before/after error lists, not just counts). Full test suite re-run before/after every round of changes — identical failing-test baseline (pre-existing, documented in this project's `CLAUDE.md`; one additional diff was a confirmed-flaky test, reproduced as flaky independent of these changes), no new failures introduced. Several test mocks (`vi.mock('@/lib/supabase-kv', ...)`) needed updating to include the new `kvSetConfirmed` export — done in `lieferanten-profile-lernen.test.ts`, `marketing-import.test.ts`, `personalfix-flex-overrides.test.ts`, `tagesdaten-regression.test.ts`, `verkaufsdaten-import.test.ts`. Three `budget-store-kv-backup.test.ts`/`round27-safe-blob-persistence.test.ts` tests that locked in the old "always cache locally, even on a real write failure" behavior were updated to assert the new, intentionally different behavior (see changelog).
**How to test in panel:** Save something (e.g. a daily budget entry on **Tagesansicht**, or a Budget/P&L edit on **Budget**/**Kennzahlenbericht**), then immediately kill the browser tab or lose network before the save could reach the database. Reload — data should reflect what's actually in the database (either the save completed, or it visibly failed via the existing error toast), never a false "saved" state that later disappears. Also: on **Budget**, use the top-down allocation ("Verteilen") across several accounts at once and confirm ALL accounts actually got the new value (this is the loop-chaining bug fix — previously a race could theoretically have dropped some accounts' values within one such action). Also: switch tenants (Oliv ↔ Beaulieu) and confirm data still loads correctly on both sides.

---

## Open

### 6. Guest links can be created outside the app
**What it means:** Read-only shared schedule links (`department_access_tokens`, used by pages like `DepartmentSchedule.tsx` / `/dienstplan/:department`, `/plan/:department`) can currently be generated by anyone who knows the API shape — not restricted to being created from inside the app's UI (`DepartmentTokenManager.tsx`).
**Plan:** Restrict token creation to authenticated in-app actions only (e.g. database-level policy, not just UI hiding).
**How to test once fixed:** Attempt to create a department access token directly against the backend (outside the app's own "create link" button) — it should be rejected. Creating one via the in-app **Dienstplanung** → share/link feature should still work normally.

### 7. Kitchen staff logins have a narrow path to wage data
**What it means:** UI screens hide wage data from `kueche_manager` (kitchen manager) logins, but the database layer itself doesn't enforce this — so there's a path around the UI restriction.
**Plan:** Add database-level (row/column) restrictions for wage-related tables, not just UI-level hiding.
**How to test once fixed:** Log in as a kitchen-manager account. Confirm wage figures are inaccessible both through every UI screen AND via a direct API/database query using that account's credentials — not just visually hidden.

### 8. Old data looks "stale" on dashboard screens
**What it means:** On "latest data" style dashboard views (e.g. **Cockpit** / `Dashboard.tsx`), once the underlying tables accumulate years of history, the newest rows become hard to distinguish/track.
**Plan:** Fix sorting/highlighting so the most recent data is always clearly surfaced regardless of table size.
**How to test once fixed:** On **Cockpit** (`/dashboard`), with a dataset spanning multiple years, confirm the most recent entries are immediately visible/obvious without manual sorting or scrolling to find them.

---

## Out of scope for Phase 1

- **Offline capability** (optional enhancement, ~10–12 additional hours per the roadmap doc) — depends on issue #5 being fixed first, tracked separately as a future phase.
