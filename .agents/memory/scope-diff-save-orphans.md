---
name: Scope-diff save & orphan preservation
description: RLS-safe load→update→insert→delete save helpers must not rewrite caller-provided ordering, or preserved rows for hidden entities get mutated.
---

# Scope-diff save under authenticated-wide RLS + orphan preservation

This codebase uses an app-enforced tenant-isolation convention: several tables
(`positions`, `staffing_requirements`, `employees`) have authenticated-wide RLS
(`USING true`/`WITH CHECK true`) and tenant separation is done in the TS layer
(`restaurant_id` predicate, or ID-prefix for `employees`). The DB does NOT
enforce per-tenant isolation. This is accepted for trusted authenticated staff.

## Save-by-scope pattern (the safe shape)
For "replace everything in a scope" saves under authenticated-wide RLS, do NOT
bulk-upsert on the PK (a client could pass a foreign id and overwrite another
tenant's row). Instead, per scope:
1. load existing ids for the EXACT tenant + scope predicates,
2. UPDATE only ids found in that set (eq id + eq restaurant_id + scope preds),
3. INSERT the rest with a fresh id,
4. DELETE stale ids (in scope, no longer desired), tenant+scope-filtered.

**Why:** authenticated-wide RLS does not stop a crafted foreign id; routing
unknown ids to INSERT (not UPDATE) makes cross-tenant clobbering impossible
through the helper.

## Two non-obvious traps
- **Orphan preservation:** when the editing UI only shows a SUBSET of entities
  (e.g. active positions only), rows belonging to hidden/inactive/deleted
  entities in the same scope must be re-submitted unchanged in the save payload,
  or the diff-delete step silently destroys them. Mirrors the project-wide
  "no silent delete" principle (deactivate, don't delete).
- **Do NOT normalize caller-provided `sort_order` (or similar incidental fields)
  inside the save helper.** If the helper rewrites ordering by a global draft
  index, it mutates the preserved orphan rows too (and can break per-entity
  ordering semantics). Let the caller assign ordering per entity; the helper
  should only force the scope-identity fields (scope_type/season/weekday/scope_ref).

**How to apply:** any new "save all rows of a scope" path (staffing, positions,
future holiday/event scopes) — keep update/insert/delete split, preserve hidden
rows verbatim, and trust the caller's ordering.
