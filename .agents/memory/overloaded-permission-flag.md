---
name: Overloaded permission flag widening leaks confidential surfaces
description: Before adding a new role to an existing permission boolean, audit every usage — the flag often also gates wages/PII/admin surfaces.
---

When you widen an existing permission flag to admit a NEW role, the flag may
already gate more than the capability you intend to grant. Adding the role leaks
every surface that flag controls.

**Concrete case:** `canEditEmployees` in `Personalstamm.tsx` was historically
`isAdmin || isBeaulieuManager` and gated NOT ONLY add/edit buttons but also
confidential admin surfaces: the duplicate-employee warning (renders
hourlyWage/monthlySalary of ALL employees), the onboarding "Ausstehende
Anmeldungen"/pending_review panels (guest/applicant PII + accept/reject), and the
"Persönliche Daten" (AHV/IBAN), "Vertragliche Grundlagen" and "Arbeitsvertrag"
cards. Simply adding `kueche_manager` to `canEditEmployees` exposed all of that to
the kitchen manager.

**Fix pattern:** keep the broad flag for the genuinely-shared capability, and
introduce a narrower local gate that equals the OLD value for the
admin/confidential surfaces — e.g. `const canManageAllEmployees = isAdmin ||
isBeaulieuManager;` — then swap only the sensitive usages to it. This keeps
admin/manager behavior byte-for-byte identical (both still satisfy the narrow
gate) and only the new role loses the confidential surfaces.

**Why:** a single overloaded boolean conflates "can do basic edits" with "is a
full admin"; the two diverge the moment a partial role is introduced.

**How to apply:** before editing a permission hook to add a role, grep EVERY
usage of the flag in the consuming pages and classify each as basic-capability vs
admin/PII/wage. Split rather than widen. Wage fields here stay under the separate
`canEditWages` gate, which is intentionally NOT widened.
