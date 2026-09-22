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

---

## Open

### 5. App trusts the device more than the database (root cause)
**What it means:** Saves are considered "done" once they reach the device, before the database confirms them. This is the underlying cause behind issues #1–#3 above.
**Plan:** Rework the save flow so the database is the source of truth; device-local storage becomes a cache, not the point of truth.
**How to test once fixed:** Save something, then immediately kill the browser tab or lose network before the save could reach the database. Reload — data should reflect what's actually in the database (either the save completed, or it visibly failed), never a false "saved" state that later disappears.

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
