---
name: Employees write gate
description: Only Personalstamm form + sanctioned Personaleintritt-Übernahme may write employees to Supabase — all other auto-write paths are blocked.
---

## Rule
The `employees` table is a master record and must ONLY be written from:
1. `Personalstamm.tsx` form (handleSave) — create/edit employee
2. `archiveEmployee()` — deactivate employee
3. `activateSubmissionAsEmployee()` — approve onboarding submission
4. Personaleintritt-Übernahme (`PersonaleintrittDetail` → `buildEmployeeFromEintritt` + `upsertEmployee`) — sanctioned 2nd create path: fresh Employee object (never stale localStorage state), presence-guarded fields, central ID allocation via `employee-id.ts`, duplicate-name warning before write

**All other write paths are permanently blocked/commented out.**

## Blocked paths (with reason)
- `usePersonnelData.ts` effect line ~678: `upsertAllEmployees(employees, tenantId)` — fired on every state change, writes stale localStorage data to Supabase → could reactivate archived employees or create ghost records
- `SchedulePlanner.tsx` handleSaveSchedule: `upsertAllEmployees` — bulk overwrites employees on schedule save
- `SchedulePlanner.tsx` auto-seed block: `seedBeaulieuEmployees(defaultEmployeesBeaulieu)` — triggers when employees.length === 0, deletes/recreates data
- `SchedulePlanner.tsx` handleAddAushilfe: `upsertEmployee(newEmployee)` — new employees created from schedule view
- `SchedulePlanner.tsx` handleEmployeeFormSubmit ADD: `upsertEmployee(newEmployee)` — blocked, redirect to Personalstamm
- `SchedulePlanner.tsx` import safeToSave: `upsertEmployee` — import auto-creates employees

## What IS still allowed in SchedulePlanner
- `upsertEmployee` for `handleSaveDaysOff` and `handleConfirm8Hours` — these only write schedule-specific fields (daysOff, preferredWorkDays) for EXISTING employees

**Why:** employees state in localStorage can be stale (loaded from cache without employment_end_date). Writing it back to Supabase clears the archived dates, reactivating employees like Ali.

**How to apply:** If adding a new write path for employees, it MUST go through Personalstamm form or be explicitly justified with a code comment citing this rule.
