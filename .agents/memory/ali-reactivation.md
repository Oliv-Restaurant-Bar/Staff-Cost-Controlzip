---
name: Ali reactivation root cause
description: Why archived employees (Ali) kept reappearing — two root causes found and fixed.
---

## Root Cause 1: employeeToDb cleared employment_end_date
`employeeToDb` had `employment_end_date: emp.employmentEndDate ?? null`. When `employmentEndDate` is `undefined` (field not in form), this sent `null` to Supabase and CLEARED the existing archived date.

**Fix:** Changed to conditional spread:
```typescript
...(emp.employmentEndDate !== undefined
  ? { employment_end_date: emp.employmentEndDate || null }
  : {}),
```
`undefined` = field not in form → don't send (preserve existing DB value)
`null`/`''` = explicitly cleared → send null (allow reactivation)
`'2026-03-31'` = date → send date

Same fix applied to `contract_end`.

## Root Cause 2: upsertAllEmployees auto-sync
`usePersonnelData.ts` had `upsertAllEmployees(employees, tenantId)` in a `useEffect` that fired on every employee state change after initialization. The employees state could be loaded from localStorage (which might have Ali without employment_end_date) → writes cleared date to Supabase.

**Fix:** Removed the `upsertAllEmployees` call from the effect. localStorage write kept (cache only).

## Additional protection: is_active field
Migration `20260605_employee_integrity_fields.sql` adds `is_active BOOLEAN DEFAULT true` and `archived_at TIMESTAMPTZ`. `archiveEmployee()` now sets both fields. `isEmployeeActiveInMonth()` checks `isActive === false` first.
