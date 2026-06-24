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

## Reusing an EXISTING DB profile: phone → email only (never name)
Two distinct concerns, do not conflate them:
- **Within-import clustering** (`clusterGuests`, union-find over email/mobile/name)
  merges the *same import's* rows — name is fine here.
- **Matching against EXISTING db guests** (`resolveExisting`) reuses a stored
  profile *before creating a new one*. This matches **only normalized phone, then
  email** (phone first), tenant-scoped via `fetchExistingGuests`. A new guest is
  created when neither phone nor email hits.

**Rule:** `resolveExisting` must NOT match on name or `match_key`. Phone has
priority over email (only matters when phone and email point to different stored
guests — phone wins).

**Why:** name equality is not identity (two people share "Thomas Müller"); using
it to reuse a contact-identified profile silently merges different people. Phone
is the most reliable identifier; email second (shared/changed more often). This
is the explicit product spec for import dedup.

**How to apply:** keep name-only de-dup working via the `(restaurant_id,
match_key)` UNIQUE upsert (a name-only booking with no phone/email still converges
on re-import) — that is idempotency, not a `resolveExisting` match. Don't "fix"
the lost name-matching by re-adding a name branch to `resolveExisting`.

## RLS / PII convention for new tables
PII tables use `authenticated`-only policies `USING (true)` + `service_role`
grants + `REVOKE ALL ... FROM anon` — mirroring the `gn_*` RLS-fix migration.
Tenant isolation and admin-only access are enforced in app code (ID-prefix
tenancy + `usePermissions`), NOT via DB-level policies. Do not add
tenant/admin RLS to match an "ideal" model; it diverges from the project pattern.

## Real-file validation & status mapping (Foratable export)
The authoritative regression fixture is the real May-2026 export, frozen in the
repo and asserted by a dedicated real-file test. Parser changes are validated
against it, not only synthetic fixtures.

Durable facts about the real Foratable export that synthetic fixtures missed:
- Status rohwerte include more than the obvious ones. Beyond
  Abgeschlossen/Storniert/No-show, the real file contains **"Abgelehnt"**
  (restaurant declined) and **"Nicht beantwortet"** (request never answered).
  Decision: `Abgelehnt → cancelled` (lost cover, did not take place) and
  `Nicht beantwortet → pending` (unresolved request), so they leave the
  `unknown` bucket. **Why:** unmapped statuses silently land in `unknown` and
  distort the cancellation/active-reservation analytics. This mapping is a
  judgement call — overridable if the operator wants declined tracked separately.
- The export uses **multiline quoted fields** (e.g. a multi-line address inside
  Gästeinformationen). The state-machine `parseDelimited` must handle embedded
  newlines inside quotes — a naive line split corrupts the row count.
- **Name-only guests collapse**: rows with no email/mobile and a generic name
  (e.g. "walk-in") share a single `name:<x>` key. Known limitation of name-based
  matching; not a bug, but it understates distinct-guest counts for anonymous
  walk-ins.

## Save lifecycle is idempotent, not transactional
`saveReservationImport` runs header `processing` → guests → records → recompute
aggregates → `active` (or `failed` + error_message). There is no single DB
transaction (no RPC infra; migrations are run manually). This is acceptable
because every write is an upsert keyed on a UNIQUE constraint, so re-running a
failed import converges. Aggregate recompute is scoped to affected guest_ids via
chunked `.in()` — never a global recompute, never deletes of unrelated rows.

## Reporting inserted-vs-updated needs a read-before-write
Supabase' `.upsert(..., { onConflict })` does NOT tell you which rows were
INSERTed vs UPDATEd. To produce honest "neu eingefügt / aktualisiert" import
stats, pre-fetch the existing conflict keys for the incoming (deduped) set with a
chunked, tenant-filtered `.select('external_reservation_id').eq('restaurant_id',…)
.in('external_reservation_id', part)` before the upsert; `updated` = keys already
present, `inserted` = rest. Race conditions are irrelevant here — the UNIQUE
constraint still prevents duplicates; the numbers are display-only statistics.

## UNIQUE constraint lives inside CREATE TABLE IF NOT EXISTS — add it standalone too
The `(restaurant_id, external_reservation_id)` UNIQUE constraint that makes the
import idempotent is declared *inside* `CREATE TABLE IF NOT EXISTS` in the
original reservations migration. If the table already existed when that line was
added, `IF NOT EXISTS` is a no-op and the constraint silently never gets created.
**Always ship a separate idempotent `ADD CONSTRAINT` migration** (guarded by a
`pg_constraint` existence check, with a pre-dedup keeping the newest row per key)
so older environments converge. Verify the constraint empirically — you cannot
assume the in-CREATE-TABLE declaration actually ran.
