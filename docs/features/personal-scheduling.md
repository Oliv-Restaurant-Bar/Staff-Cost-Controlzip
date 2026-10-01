# Personal & Dienstplanung (Staff & Scheduling)

This is the operational core of the app. It answers three questions restaurant managers ask every day: **who is working which shift**, **what does that cost**, and **is our staff paperwork compliant** (Swiss L-GAV hospitality labor law). Almost every other domain in the app (P&L, KPI cockpit, daily controlling) ultimately consumes numbers produced here.

## Pages

| Route | File | English name | Purpose | Access |
|---|---|---|---|---|
| `/personal`, `/schedule-planner` | `SchedulePlanner.tsx` | Duty Roster Planner | The main shift-scheduling grid — by far the largest page in the app (~6,000 lines). Build/edit weekly duty rosters, assign employees to shifts/positions, track budget distribution, staffing warnings, day-locking. This is very likely the file with the git changes currently in progress (see git status) | all authenticated (department-filtered — see below) |
| `/personal-stamm` | `Personalstamm.tsx` | Employee Master Data | Employee records with role-based field visibility: **admin** sees all fields incl. wages, can edit/delete/create; **managers** see only their own department, read-only, no wage fields. Includes placeholder contract-upload area, per-employee notes, active/inactive status | admin (full) / service_manager, kueche_manager (own dept, read-only, no wages) / beaulieu_manager |
| `/personaleintritt` | `PersonaleintrittListe.tsx` | Employee Onboarding — Overview | List of all onboarding cases for the tenant with status badges. Actions: new onboarding, delete draft. (An older public invite-link flow `/e/:token` was removed — data is now entered while logged in) | admin (excl. guest sessions) or beaulieu_manager |
| `/personaleintritt/neu` | `PersonaleintrittNeu.tsx` | Employee Onboarding — New (Phase 1) | Mobile-first form where the manager enters baseline data. Wage entry supports 3 transparent modes (base wage / L-GAV minimum wage / target-total), with minimum-wage compliance checking centralized in `lib/personaleintritt/lohn.ts`. Tolerant of a not-yet-run migration (shows a hint instead of crashing) | admin (excl. guest) or beaulieu_manager |
| `/personaleintritt/:id` | `PersonaleintrittDetail.tsx` | Employee Onboarding — Detail | Shows baseline + employee-submitted data (Phase 2), documents via signed URLs. Actions: mark reviewed, generate contract PDF (editable, stored flat in a private bucket), **take over into Personalstamm** (the second sanctioned write path into the `employees` table — see gotcha below), cancel. Digital-signature ("Skribble") integration is prepared but disabled | admin (excl. guest) or beaulieu_manager |
| `/positionen` | `Positionen.tsx` | Positions | Admin page managing job-position/station master data per department (Service/Küche): name, color, icon, order, active flag. Feeds `/personalbedarf` | `canAccessModule('positionen')` |
| `/personalbedarf` | `Personalbedarf.tsx` | Staffing Requirements | Defines the *target* headcount per season × weekday × position: shift start/end, number of staff needed, hierarchical Department → Area → Position. Stored **completely separately** from the actual schedule (`staffing_requirements` table) — deliberately contains no staffing-check/warnings/budget logic, that's a separate concern | `canAccessModule('personalbedarf')` |
| `/besatzung-produktivitaet` | `BesatzungProduktivitaetPage.tsx` | Crew & Productivity | Productivity/crew analysis, appears to include a "control list" import/history/timeline system and helper-role detection | `canAccessModule('besatzung_produktivitaet')` |
| `/analyse` | `SollIstAnalyse.tsx` | Plan vs. Actual Analysis | Compares planned vs. actual hours, personnel cost, revenue, and cost ratio. Filterable by day/week/month × department. Role behavior differs sharply here (see below) | `canAccessModule('soll_ist_analyse')` — admin, service_manager, kueche_manager (**not** beaulieu_manager) |
| `/personal-fix` | `PersonalFix.tsx` | Fixed-Staff Personnel Costs | Second-largest page (~5,600 lines). The detailed personnel-cost engine for salaried ("Fix") staff: reconciliation, flex-hour overrides, overtime analysis, absence handling, wage-history, Excel/PDF export, and integrates with the P&L engine | `canAccessModule('personal_fix')` — admin, beaulieu_manager |
| `/ueberstunden` | `UeberstundenPage.tsx` | Overtime Account | Per-Fix-employee overtime ledger by week/month/running total (since July 2026). Actual = MIRUS hours + absence credits (vacation/sick/accident = workload × 8.4h/day, "Frei" = 0). Follows a strict "empty, not zero" rule for weeks with no data basis. Unmatched MIRUS names surface as a hint | same gate as `/personal-fix` |
| `/personalkosten-neu` | `PersonalkostenNeu.tsx` | Personnel Cost — New (Review) | A verification-only view that exclusively uses the new central calculation source `src/lib/personalkosten.ts`, built to reconcile numbers before the old views are migrated to it ("Etappe 1" = stage 1 of a migration) | same gate as `/personal-fix` |
| `/dienstplan/:department` | `DepartmentSchedule.tsx` | Department Schedule | Department-scoped schedule view | all authenticated |
| `/plan/:department` | `DepartmentPlannerWrapper.tsx` | Department Planner (wrapper) | Wrapper around the department-level planner | all authenticated |
| `/employee-integrity` | `EmployeeIntegrityPanel.tsx` | Employee Integrity Panel | Data-integrity checking tool for employee records | admin only (redirects to `/personal`) |

## Department-based visibility model

Access here isn't just role-based, it's **role + department** based, computed in `src/hooks/usePermissions.ts`:

- `admin` → `allowedDepartment: 'all'`, can see and switch between departments (`canSwitchDepartment: true`).
- `service_manager` → `allowedDepartment: 'service'`, `canSeeDepartment('service')` only.
- `kueche_manager` → `allowedDepartment: 'küche'`, `canSeeDepartment('küche')` only.
- `beaulieu_manager` → `allowedDepartment: 'all'` (sees all departments, but only within the Beaulieu tenant — it's locked there).

Concretely, on `SchedulePlanner.tsx` and `SollIstAnalyse.tsx`, a `service_manager` and a `kueche_manager` looking at the *same week* see different rows/columns — each is filtered to their own department — while `admin` and `beaulieu_manager` see the full picture (for admin: both tenants' departments depending on active tenant; for beaulieu_manager: all Beaulieu departments only, tenant switch is blocked).

## Data flow

- **Scheduling core:** `SchedulePlanner.tsx` touches ~25 `src/lib` files, notably `schedule-save-queue.ts` (write queue), `schedule-daily-totals.ts`, `schedule-templates.ts`, `schedule-export-import.ts`, `staffing-check-utils.ts` / `staffing-comparison-utils.ts` / `staffing-requirements-utils.ts` / `staffing-targets.ts` / `staffing-day-hints.ts` / `staffing-profiles-utils.ts` (staffing-vs-requirement comparison and warnings), `employee-visibility.ts` (department filtering), `employee-rate.ts` + `wage-history.ts` + `social-costs.ts` + `personalkosten.ts` (cost calculation), `ist-day-locks.ts` (day locking), `absence-utils.ts`, `pattern-warnings.ts`, `budgetDistribution.ts`, `supabase-db.ts` / `supabase-kv.ts` for persistence.
- **Employee master data:** `Personalstamm.tsx` → `personalstamm-list.ts`, `employee-id.ts`, `employee-visibility.ts`, `employee-rate.ts`, `contract-history-store.ts`, `salaryCalc.ts`, `generateContract.ts`, `position-utils.ts`, `funktionen.ts` (job functions), `no-time-tracking.ts`, `ueberstunden.ts`, `social-costs.ts`, `personalkosten.ts`.
- **Onboarding:** all three Personaleintritt pages funnel through the `src/lib/personaleintritt/` sub-directory: `db.ts` (data access), `types.ts`, `lohn.ts` (wage calc + L-GAV minimum-wage check), `betriebs-config.ts` (business/property config), `dossier-pdf.ts` / `pdf-fill.ts` (contract PDF generation), `sem-formular.ts` / `behoerden-meldung.ts` (Swiss authority forms/reporting), `mirus-export.ts`, `uebernahme.ts` (the "take over into Personalstamm" write path).
- **Staffing requirements:** `Personalbedarf.tsx` → `staffing-requirements-db.ts` / `staffing-requirements-utils.ts`, `staffing-profiles-db.ts` / `staffing-profiles-utils.ts`, `staffing-week-compare.ts` / `staffing-week-utils.ts`, `station-config.ts`, `schedule-proposal-store.ts`, `position-utils.ts`.
- **Fixed-staff cost engine:** `PersonalFix.tsx` → `personalkosten.ts` / `personalkosten-darstellung.ts` (display formatting) / `personalkosten-excel-export.ts` / `personalkosten-seite-pdf.ts`, `personal-fix-reconciliation.ts`, `personalfix-flex-overrides.ts` / `personalfix-export.ts`, `flex-weekly-ssot.ts`, `overtime-analysis.ts`, `hour-balance-utils.ts`, `ag-soz-flags.ts` (employer social-charge flags), `pl-engine.ts` (P&L integration), `personal-controlling-drilldown.ts`, `staffing-recommendations.ts`, `reservation-analytics.ts` / `reservation-crm-db.ts` (links personnel cost to reservation volume).
- **Overtime ledger:** `UeberstundenPage.tsx` → `ueberstunden.ts` (core calc) + `mirus-open-hours-store.ts`.
- **New cost-calc verification page:** `PersonalkostenNeu.tsx` → exclusively `personalkosten.ts`, by design (no other lib imports besides `utils`), to isolate and verify that one calculation source.

## Key files (src/lib)

| File | Purpose |
|---|---|
| `personalkosten.ts` | The central/emerging single source of truth for personnel-cost calculation (explicitly being migrated toward — see `PersonalkostenNeu.tsx`) |
| `employee-rate.ts` | Per-employee hourly/salary rate resolution |
| `social-costs.ts` | Swiss employer social-charge (AHV/ALV/etc.) calculations |
| `wage-history.ts` | Historical wage-rate tracking |
| `employee-visibility.ts` | Department-based employee filtering |
| `staffing-requirements-db.ts` / `staffing-requirements-utils.ts` | Target-headcount data access and comparison logic |
| `ueberstunden.ts` | Overtime ledger core calculation |
| `schedule-save-queue.ts` | Write-queue for schedule persistence (mentioned by name — worth checking directly if debugging a save/lost-edit issue in the roster) |
| `personaleintritt/lohn.ts` | Onboarding wage calculation + L-GAV minimum-wage compliance check |
| `personaleintritt/uebernahme.ts` | The "take over into employee master data" write path — the *second* sanctioned writer into the `employees` table, per its own header comment |
| `pl-engine.ts` | Shared P&L engine, also consumed by `PersonalFix.tsx` and the goods-cost domain |

## Non-obvious gotchas / rules

- **L-GAV compliance is load-bearing, not decorative.** L-GAV is the Swiss hospitality collective labor agreement. `PersonaleintrittNeu.tsx` enforces a minimum-wage check against it (`lib/personaleintritt/lohn.ts`) as part of the onboarding wage entry — don't treat a wage-validation error there as a generic bug without checking whether it's the L-GAV floor being enforced correctly.
- **Two sanctioned write paths into the `employees` table**, and only two: direct edits from `Personalstamm.tsx`, and the "Übernahme" (take-over) action on `PersonaleintrittDetail.tsx` (`lib/personaleintritt/uebernahme.ts`). `SchedulePlanner.tsx`'s own header comment explicitly states employee auto-seeding is **permanently disabled** and that `upsertAllEmployees`/`seedBeaulieuEmployees` are blocked in production — if you see either of those referenced anywhere as live code, treat it as a red flag, not a normal code path.
- **PII on Personaleintritt**: this whole onboarding flow handles personal employee data (contracts, potentially ID documents via signed URLs) — treat any bug fix here as security-sensitive by default.
- **Wage/hourly-rate visibility is a specific, separate permission** (`canSeeHourlyWages` in `usePermissions.ts`) — true only for admin and beaulieu_manager. `canSeePersonnelCostTotals` (aggregate cost, not individual wages) is true for *everyone*. When testing role-based UI, don't conflate "sees personnel cost totals" with "sees individual salaries" — they're different gates and a manager should see the former but never the latter.
- **`/analyse` (Soll-Ist) deliberately excludes beaulieu_manager** — unlike most other operational modules, this one is admin/service_manager/kueche_manager only, per both `usePermissions.ts` and the page's own header comment.
- **"Empty instead of zero" convention** appears again here on `UeberstundenPage.tsx` (same principle as the KPI catalog's "missing = —, never 0" rule) — weeks with no MIRUS/absence data source stay visually empty rather than showing a misleading 0.
- **`Personalbedarf` (target headcount) and `SchedulePlanner` (actual roster) are stored in completely separate tables** (`staffing_requirements` vs. the schedule tables) by explicit design — don't assume editing one affects the other; they're compared, not merged.
- **Position `key` is immutable once created** (`Positionen.tsx`) — employees reference positions by this stable key, so renaming/changing it after the fact would orphan existing assignments. If a fix needs to "rename" a position, only the display name/color/icon should change, never the key.
- **Migration-tolerant onboarding**: `PersonaleintrittNeu.tsx` checks for the existence of tables from migration `20260724` and shows a hint box instead of crashing if it hasn't run yet — if this page appears "broken" in a given environment, check whether that migration has actually been applied there before assuming it's a code bug.

## Orphaned pages — not reachable in the running app

Two substantive, fully-built pages exist in `src/pages/` but have **no route wired up** in `src/App.tsx` and are not imported anywhere else. They are not stubs or dead experiments — they're real features that appear to be either mid-migration or superseded, simply never had their route added or removed. **Do not navigate to them expecting them to be reachable in the deployed app, and confirm with the client before reviving or deleting either** (per this project's own CLAUDE.md, which already flags both):

- **`ArbeitszeitblaetterPage.tsx`** (~1,900 lines) — Timesheet approval. Imports `import-quality.ts`, `ist-day-locks.ts`, `mirus-excel-parser.ts`, `mirus-name-mapping-store.ts`, `supabase-db.ts`, `timesheet-exclusions-store.ts`, `timesheet-month-status-store.ts`, `timesheet-store.ts`. No header comment block was found at the top of the file (unusual for this codebase — most pages have one), which made its exact intended purpose harder to confirm from static reading alone.
- **`StundenimportPage.tsx`** (~590 lines) — Mirus hours import into `actual_hours`. Its header comment explicitly lists the functions it reuses: `parseMirusExcel()` (from `mirus-excel-parser.ts`), `saveActualHourEntry()` (upsert with duplicate protection), `matchEmployeeByName()` (persistent name-mapping match), `saveNameMappingsBatch()`, `loadEmployees()`.

## Not independently verified

Research was done by reading file header comments and `@/lib/` import lists, not by exercising the pages or reading every function body — `SchedulePlanner.tsx` (~6,000 lines) and `PersonalFix.tsx` (~5,600 lines) in particular were only skimmed at the header/import level, not read in full. The department-visibility explanation is derived directly from `usePermissions.ts` logic (high confidence), but exactly how each page's UI reflects that filtering was not visually confirmed by running the app.
