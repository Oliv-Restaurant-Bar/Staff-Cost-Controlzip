---
name: Ghost employee prevention
description: Duplicate and disappearing employees in SchedulePlanner; dedup by name and tenant-prefixed IDs required.
---

## Problem 1 — Ghost duplicates via Date.now() IDs
`applyImportResult`, `handleAddAushilfe`, and `handleEmployeeFormSubmit` in SchedulePlanner.tsx all create new employees using `id: \`emp_${Date.now()}\`` / `id: \`aush_${Date.now()}\``. If the same import runs N times, N separate employee records with the same name but different IDs are created.

**Why:** Timestamp IDs are unique, so upsertEmployee never overwrites — each call inserts a new row.

## Fix (applied)
All three creation paths now do a name-dedup check first (case-insensitive):
```typescript
const existing = employees.find(e => e.name.toLowerCase().trim() === name.toLowerCase().trim());
if (existing) { toast.warning(...); return; }
```

`applyImportResult` filters `newEmployees` array before inserting — skipped names get a warning toast.

## Cleanup UI
`Personalstamm.tsx` now shows a red banner ("Doppelte Mitarbeiter gefunden") for any group of employees with the same name. Each row has a "Duplikat löschen" button that triggers the existing `deleteEmployee` + `deleteTarget` AlertDialog flow.

---

## Problem 2 — Beaulieu Aushilfen disappear after reload

**Rule:** All employees belonging to the Beaulieu tenant MUST have IDs starting with `b-`.

**Why:** `loadEmployees('beaulieu')` queries Supabase with `id LIKE 'b-%'`. Any employee saved with a non-prefixed ID (e.g. `aush_1717496000000`) is invisible after page reload because Supabase filters it out.

**How to apply:** In every employee creation path, check `tenantId === 'beaulieu'` and prepend `b-`:
- Aushilfe dialog → `b-aush_${Date.now()}`
- Employee form → `b-emp_${Date.now()}`
- Import / seed paths already use explicit `b-` IDs from the seed data.

---

## How to apply (general)
- Any new employee creation path must check name uniqueness before calling `upsertEmployee`.
- Any new employee creation path must use tenant-aware IDs (`b-` prefix for Beaulieu).
- The Personalstamm duplicate banner is always visible to admins — auto-dismisses once no duplicates remain.
