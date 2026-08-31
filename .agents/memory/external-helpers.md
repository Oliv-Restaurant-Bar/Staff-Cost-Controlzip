---
name: External helpers architecture
description: How aush_* (external cost) people are stored and used — separate table, no employees FK
---

# External helpers (schedule_extra_cost_people)

## Rule
New external cost resources with `aush_*` IDs must NEVER be written to the `employees` table. They live in `schedule_extra_cost_people`.

**Why:** employees table is for permanent staff with contracts/wages. External helpers are session-plannable resources with only a CHF/h rate and no HR data. Also the `aush_*` guard in `upsertEmployee` blocks them anyway.

## Terminology boundary
An analytics panel labelled “Aushilfen” must not assume every qualifying person is stored in `schedule_extra_cost_people`. Existing staff marked for manual time capture can legitimately live in `employees` and still count as an Aushilfe for a week when they have Ist hours but no MIRUS/control-list presence that week.

**Why:** Storage class and reporting classification answer different questions. Restricting detection to `aush_*` resources silently drops manually captured employee-based helpers.

**How to apply:** Keep creation/write paths separated by storage class, but build week-based reporting candidates from every tenant-scoped person referenced by Ist hours and exclude that week’s normalized/name-mapped MIRUS roster.

## How to apply
- `src/lib/extra-cost-people-db.ts` is the only write path for external helpers
- IDs: `aush_<timestamp>` for Oliv, `b-aush_<timestamp>` for Beaulieu
- department stored as `'service'|'kueche'` (no ü) in DB; `extraCostPersonToEmployee` converts to `'küche'` for UI
- SchedulePlanner `handleAddAushilfe` calls `upsertExtraCostPerson` (not `upsertEmployee`)
- `loadMonthData` merges extra cost people into the employee list after loading
- PersonalFix shows them in a dedicated "Externe Aushilfen" section using planHours/istHours keyed by their ID
- Personalstamm ghost panel migrates them via `upsertExtraCostPerson` before archiving in employees

## FK constraints
Migration `20260605_schedule_extra_cost_people.sql` dropped:
- `schedule_entries.employee_id` FK → employees(id)
- `actual_hours.employee_id` FK → employees(id)

Referential integrity is now enforced at app level only. This allows schedule entries for `aush_*` IDs that aren't in `employees`.

## Migration status
SQL script prepared but must be manually run in Supabase SQL Editor. The DB layer (`loadExtraCostPeople`) returns `[]` gracefully if the table doesn't exist yet (catches `42P01`).
