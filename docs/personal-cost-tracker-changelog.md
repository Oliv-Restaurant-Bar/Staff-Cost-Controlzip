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
