---
name: Role-based employee visibility
description: Central helper for which employees a manager role may see/select/export/count, plus why render-time scoping is not a hard guarantee.
---

# Role-based employee visibility (Dienstplan / Personalstamm)

Restricted managers (`kueche_manager`, `service_manager`) must NEVER see/select/export/count
the other department's employees. There is ONE chokepoint: `getVisibleEmployeesForRole(role, allowedDepartment, employees)` in `src/lib/employee-visibility.ts`. Every display/select/count/export path reads the scoped list; the raw `employees` list is only for persistence (localStorage load/save/merge), employee CRUD, and import MATCHING (must see the full list or it creates duplicate employees).

**Rule:** the restricted role wins over `allowedDepartment` (`effectiveEmployeeDepartmentScope`) — defense against a stale/mis-computed `allowedDepartment`. admin/`beaulieu_manager` (`allowedDepartment='all'`) is a strict no-op.

**Why render-time scoping is NOT a hard guarantee:**
`AuthContext` initializes `role='admin'` and downgrades to the real role asynchronously
(documented there as intentional — "default admin shows the most content; downgrade is harmless").
So a restricted manager gets a brief frame where `role='admin'` → `allowedDepartment='all'` → the
scoped list is the FULL list. A true "NEVER" guarantee would require a pessimistic role default or a
render gate in the auth bootstrap, which is cross-cutting (affects every role/page) — out of scope for
a UI-scoping fix.

**How to apply:** when adding any new place that lists/counts/selects/exports employees in the
schedule or staff modules, route it through `getVisibleEmployeesForRole`, never the raw `employees`.
If you ever need the hard guarantee (no transient leak), fix it in `AuthContext` role bootstrap, not
by patching individual pages. Also: when a memoized value derives from `roleScopedEmployees`, put
`roleScopedEmployees` (not `employees`) in its dependency array, or it goes stale after role resolves.
