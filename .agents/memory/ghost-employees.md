---
name: Ghost employee prevention
description: How duplicate/phantom employees get created and where dedup guards were added.
---

## Problem
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

## How to apply
- Any new employee creation path must check name uniqueness before calling `upsertEmployee`.
- The Personalstamm duplicate banner is always visible to admins — auto-dismisses once no duplicates remain.
