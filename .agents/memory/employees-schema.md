---
name: Employees table schema
description: Column layout of the employees table — what exists and what doesn't (critical for upserts).
---

## Rule
The `employees` table has **NO `restaurant_id` column**. Adding it to any upsert payload (e.g. `employeeToDb`) will cause all upserts to fail silently or with a 42703 PostgreSQL error.

**Tenant discrimination is done exclusively via ID prefix:**
- `b-*` → Beaulieu
- anything else (numeric, `emp_*`) → Oliv

**Why:** The schema was designed without `restaurant_id` for backwards compatibility (see replit.md architecture decisions). The `restaurant_id` column exists only in `produkte_kosten`, `employee_wages`, and `daily_revenues`.

**How to apply:** In `employeeToDb` (supabase-db.ts), never include `restaurant_id`. In `loadEmployees`, filter by `.like('id', 'b-%')` for beaulieu.
