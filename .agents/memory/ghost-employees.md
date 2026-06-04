---
name: Ghost employee prevention
description: Root causes of phantom/disappearing employees and all fixes applied.
---

## Root causes identified

1. **`defaultEmployees` fallback** (`usePersonnelData.ts`): 21 hardcoded Oliv employees (IDs 1–24) returned when Supabase empty/error → ghost employees when connectivity lost.

2. **`loadEmployeesFromStorage` merged `defaultEmployees`**: Added any missing default-ID employees to every localStorage load — ghost employees on every load.

3. **Physical `deleteEmployee`** (`supabase-db.ts`): Hard-delete on employees table. Schedule entry references became orphaned.

4. **Auto-creation from schedule import** (`schedule-export-import.ts` + `applyImportResult`): Unmatched names created `imported-{timestamp}-{random}` IDs and persisted to Supabase without user confirmation.

5. **Tenant-prefixed IDs** (earlier fix): Beaulieu employees need `b-` prefix or they're invisible after reload (`loadEmployees('beaulieu')` filters by `id LIKE 'b-%'`).

## Fixes applied (data-integrity audit session)

### Fix 1 — defaultEmployees fallback removed
`loadEmployeesFromSupabase`: returns `[]` on empty/error. Never uses `defaultEmployees`.  
`loadEmployeesFromStorage`: returns only stored employees; actively filters IDs 1–24 (demo guard + auto-cleanup).

### Fix 2 — Soft delete replaces physical delete
`archiveEmployee(id)` in `supabase-db.ts`: sets `employment_end_date = today` (UPDATE, no DELETE).  
`deleteEmployee()` redirects non-test IDs to `archiveEmployee()` with console.error.  
`handleRemoveEmployee` in `SchedulePlanner.tsx` uses `dbArchiveEmployee`.

### Fix 3 — Auto-import guard in applyImportResult
Employees with `id.startsWith('imported-')` are blocked from Supabase upsert — error toast shown.  
Preview dialog already required explicit "Neu erfassen" confirmation; this is a final backstop.

## Diagnostic panel
Route: `/employee-integrity` — admin-only.  
Checks: Demo IDs in Supabase, `imported-*` IDs, missing dept/type, tenant isolation violations, name duplicates, localStorage-only employees, demo data in localStorage.  
Each critical issue has an "Archivieren" button.

## How to apply (general rules)
- Any new employee creation path: name-dedup check first (case-insensitive).
- Any new employee creation path: tenant-aware IDs (`b-` prefix for Beaulieu, `aush_` for Oliv).
- Never call `deleteEmployee()` from UI — always `archiveEmployee()`.
- Never use `defaultEmployees` as fallback — Supabase empty result is valid.
