---
name: Kawtar/Party employee migration
description: Former external cost people migrated into the employees table; how loadEmployees hides leftover aush_* ghosts.
---

Kawtar and Party were migrated from `schedule_extra_cost_people` into the regular `employees` table (stable IDs: `kawtar`, `party`). The SQL lives in `supabase/migrations/20260606_kawtar_party_zu_normalen_mitarbeitern.sql`.

**Why:** they needed full employee features (scheduling, hour tracking) that extra-cost people don't get; keeping them external caused divergent handling.

**How to apply:** treat `kawtar`/`party` as normal employees everywhere. `loadEmployees` filters `isActive !== false`, which hides archived `aush_*` ghost entries left over from the old external-helper era — do not "fix" that filter away, and never re-create these two as extra-cost people.
