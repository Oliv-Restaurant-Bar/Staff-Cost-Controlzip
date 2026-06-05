---
name: seedBeaulieuEmployees delete scope
description: The seed function must only delete known old placeholder IDs, not all non-seed b-* employees.
---

## Rule
`seedBeaulieuEmployees` in `supabase-db.ts` deletes Beaulieu employees before re-seeding. The delete scope **must be limited to the 10 original placeholder IDs** (`b-1` through `b-10`). It must NEVER delete any `b-*` employee whose ID is not in that whitelist, even if it's not in the seed array.

**Why:** Any manually-added Beaulieu employee (e.g. `b-210`, `b-emp_1748...`) would be wiped if the delete step targets all non-seed `b-*` IDs. The function can be triggered from ImportHub ("Beaulieu Mitarbeitende importieren" button), which runs after real employees already exist.

**How to apply:**
```typescript
const OLD_PLACEHOLDER_IDS = new Set(['b-1','b-2',...,'b-10']);
const oldToDelete = existingBIds.filter(r => !newIds.has(r.id) && OLD_PLACEHOLDER_IDS.has(r.id));
```
Manually-added employees (not in `OLD_PLACEHOLDER_IDS` and not in seed) must be logged as "preserving" and left untouched.
