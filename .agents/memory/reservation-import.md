---
name: Reservationen Import (Foratable)
description: Design decisions for the Foratable reservation-CSV import feature (guest recognition, RLS/PII, save lifecycle).
---

# Reservationen Import (Foratable CSV)

Self-contained feature (parser/analytics/db/page) for importing Foratable
reservation-tool CSV exports. Completely separate from the Gastronovi (`gn_*`)
imports — those must never be touched by reservation work.

## Guest recognition is cluster-based, not just match_key dedup
Resolving guests only by canonical `match_key` (email→mobile→name priority) is
NOT enough. Within a single import the same physical guest can appear with
different completeness (email+mobile in one row, mobile-only or name-only in
another) and would produce multiple `guest_profiles`.

**Rule:** cluster the import's distinct guests with union-find over shared
identity (normalized email / mobile / name, transitive), pick one canonical
identity per cluster, and map every member match_key to the resolved/created
guest id. When an existing profile is matched but lacks an identifier the import
now reveals, **upgrade** the profile (fill missing normalized_email/mobile/name)
so a later partial booking re-matches it. Do not rewrite an existing `match_key`
(risk of UNIQUE collision) — only fill empty normalized fields.

**Why:** without this, guest aggregates and return-rate analytics double-count
returning guests as new ones.

## RLS / PII convention for new tables
PII tables use `authenticated`-only policies `USING (true)` + `service_role`
grants + `REVOKE ALL ... FROM anon` — mirroring the `gn_*` RLS-fix migration.
Tenant isolation and admin-only access are enforced in app code (ID-prefix
tenancy + `usePermissions`), NOT via DB-level policies. Do not add
tenant/admin RLS to match an "ideal" model; it diverges from the project pattern.

## Save lifecycle is idempotent, not transactional
`saveReservationImport` runs header `processing` → guests → records → recompute
aggregates → `active` (or `failed` + error_message). There is no single DB
transaction (no RPC infra; migrations are run manually). This is acceptable
because every write is an upsert keyed on a UNIQUE constraint, so re-running a
failed import converges. Aggregate recompute is scoped to affected guest_ids via
chunked `.in()` — never a global recompute, never deletes of unrelated rows.
