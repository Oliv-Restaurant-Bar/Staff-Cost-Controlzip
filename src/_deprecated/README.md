# Deprecated — confirmed dead code, do not build on or extend

Everything under this folder has **zero importers anywhere in the live `src/` tree** and is
**not registered in `src/App.tsx`'s routes**. None of it runs in the deployed app. Verified
2026-10-01 by tracing exact `import ... from '<file>'` lines (not name-based grep) for every file,
checked after the move via a full `tsc --noEmit -p tsconfig.app.json` (219 pre-existing errors,
unchanged) and `npm run build` (succeeds, no new warnings). Full investigation and evidence:
`docs/dev/personal-cost-tracker-missing-tables.md` (issue #11 in `docs/dev/personal-cost-tracker-issues.md`).

**If you're a future session (human or AI agent): do not import from this folder, do not treat
these files as a starting point to extend, and do not assume the database tables they reference
exist.** They're kept for reference/possible revival only — see "Open decision" below.

## Contents

### Events/Reservations settings module (two separate orphaned trees, not one cluster)

- `components/ReservationsOverview.tsx`, `components/ReservationsBudgetCalculator.tsx` — standalone,
  zero importers, don't import each other or anything else in this folder.
- `components/tabs/EventsTab.tsx` + all of `components/events/*.tsx` (14 files: calendar, IMAP
  email import settings, external API import settings, Fortelable sync settings, event
  notification settings, department email settings, file import, week/year views, manual email
  dialogs) — a self-contained tree, `EventsTab.tsx` itself has zero importers anywhere.

Together these reference 7 of the 19 tables missing from production (`fortelable_reservations`,
`imap_email_settings`, `external_api_settings`, `external_api_import_log`,
`department_notification_emails`, `event_notification_settings`, `event_notifications_log`), plus
`group_reservations`/`fortelable_settings` (shared with the still-live `/overview` route — see
below, not moved here).

**Resolved — backend checked too, not just frontend:** 6 Supabase Edge Functions
(`fetch-imap-emails`, `send-event-notifications`, `sync-fortelable`, `send-department-notification`,
`import-reservations`, `parse-reservation-email`) reference 10 of the 19 tables in source, all
configured `verify_jwt = false` (the unattended/cron-invocation pattern) — real deployed code, not
hypothetical risk. `pg_cron` is enabled project-wide but no `cron.schedule(...)` call is tracked in
any applied migration, so this couldn't be resolved from source alone. **Client confirmed directly:
no cron jobs or active Edge Function deployments exist.** On that basis, the 9 tables that only fed
this dead cluster (all of the above except `group_reservations`/`fortelable_settings`, needed by
`/overview`) were removed from the migration files entirely rather than created-then-ignored — see
`supabase/migrations_pending/missing_tables/not_applying_confirmed_dead/README.md`.

### Orphaned pages (already documented in the project's CLAUDE.md before this move)

- `pages/ArbeitszeitblaetterPage.tsx` (timesheet approval) + `lib/timesheet-exclusions-store.ts`
  (used only by this page) — references `timesheet_month_exclusions`/`timesheet_month_inclusions`.
- `pages/StundenimportPage.tsx` (Mirus hours import).

Both are substantive, real features — not stubs — either mid-migration or superseded by something
else, simply never had their route wired up (or had it removed) in `App.tsx`.

## What's deliberately NOT here

`/overview` (`src/pages/Index.tsx` → `RevenueTab.tsx` → `SimpleRevenueInput.tsx`) is **not** moved
here even though it has zero nav entry and zero in-app links (same "nobody can reach it by
clicking" profile as everything above) — because it still has a live, registered route in
`App.tsx` and would render real, working UI once the missing tables exist. Moving it would mean
deleting a working route, a feature-removal decision, not a dead-code cleanup. Left in place,
flagged in `docs/dev/personal-cost-tracker-missing-tables.md` Tier 2.

### General dead-code sweep, 2026-10-14 (22 files, unrelated to the missing-tables tables above)

Separate from the table-driven findings above — these were found via a repo-wide reachability
sweep (per request: "move all things deprecated or not used into that folder, so nothing gets
lost but it doesn't get used either") rather than during the missing-tables investigation. Each
verified by exact import-line tracing (no bare grep): built a list of every `.ts`/`.tsx` file
under `src/` with zero real importers, excluded known hidden-but-live cases
(`/overview`'s `Index.tsx`→`RevenueTab.tsx`→`SimpleRevenueInput.tsx`, the `GaesteImportPage`/
`ReservationenImportPage` embedded-not-standalone pages), then confirmed each remaining candidate
by hand — some turned out to be name collisions with an unrelated same-named symbol defined
locally elsewhere (`StatCard`, `NavLink` — see below), not real usage.

None of these 22 import each other, and all of them reach live code only via absolute `@/...`
aliases (which stay valid regardless of a file's own location) — except
`PkKostenentstehung.tsx`, which had one relative import (`./pk-colors`) fixed to
`@/components/personalkosten/pk-colors` after the move (that sibling file stays in place, it's
still used by the live `PkVerlaufChart.tsx`). Verified safe: `tsc --noEmit -p tsconfig.app.json`
shows the same 219 pre-existing errors as before the move (zero new), `npm run build` succeeds.

| File | Why it's dead |
|---|---|
| `components/EmployeeTimesheetDetailDrawer.tsx` | Zero importers anywhere. |
| `components/LaborCostQuoteDisplay.tsx` | Zero importers anywhere. |
| `components/StartMonthOverview.tsx` | Zero importers; a comment in the live `pages/StartOverview.tsx` notes the card it replaced "entfällt" (no longer applies). |
| `components/TenantBanner.tsx` | Zero importers anywhere. |
| `components/MonthlyOvertimeOverview.tsx` | Zero importers anywhere. |
| `components/KPIDashboard.tsx` | Zero importers anywhere. |
| `components/ScheduleImport.tsx` | Zero importers anywhere. |
| `components/StatCard.tsx` | Zero importers — `pages/MirusReview.tsx` defines its own local `function StatCard(...)`, an unrelated same-named component; this export is never imported. |
| `components/RevenueInput.tsx` | Zero importers — not the same component as the live `SimpleRevenueInput.tsx` used by `/overview`. |
| `components/schedule-planner/SchedulePDFDialog.tsx` | Zero importers anywhere. |
| `components/NavLink.tsx` | Zero importers — `AppNav.tsx` imports `NavLink` directly from `react-router-dom`, not this wrapper. |
| `components/personalkosten/PkKostenentstehung.tsx` | Zero importers anywhere. |
| `components/TimeEntriesEditor.tsx` | Zero importers anywhere. |
| `components/BudgetComparison.tsx` | Zero importers anywhere. |
| `components/PlannedLaborCostCalculator.tsx` | Zero importers anywhere. |
| `components/WeeklyOvertimeOverview.tsx` | Zero importers anywhere. |
| `components/personal-fix/OvertimeCostCard.tsx` | Zero importers anywhere. |
| `components/UnifiedCostOverview.tsx` | Zero importers anywhere. |
| `hooks/useScheduleViewMode.ts` | Zero importers anywhere. |
| `hooks/useMaisonExclude.ts` | Zero importers anywhere. |
| `lib/connectors/gastronovi-connector.ts` | Zero references anywhere, including as a bare string. |
| `lib/schedule-pdf-parser.ts` | Zero references anywhere, including as a bare string. |

**If reviving any of these:** just move the file back out and `git mv` it to its original path —
none of them need an import-path fix on the way back out (same reasoning as above), except
`PkKostenentstehung.tsx`, which would need its `pk-colors` import reverted to the relative form.

## Open decision for the client, not a code question

Was the Events/Reservations cluster abandoned mid-build (in which case: delete this folder
permanently) or meant to be finished (restore its 9 tables into the migration — see
`not_applying_confirmed_dead/README.md` — create the route, move the code back out)? Not something
to guess at. Doesn't block anything in the meantime — its tables are already excluded from what
gets applied either way. See `docs/dev/personal-cost-tracker-missing-tables.md`.
