---
name: Bulk upsert must dedupe by the onConflict key
description: Postgres rejects a single upsert batch that touches the same conflict-key row twice; dedupe in app code before upserting.
---

# Bulk upsert must dedupe by the onConflict key

Any Supabase/Postgres bulk `.upsert(rows, { onConflict: '<cols>' })` must
contain at most ONE row per distinct conflict-key value within the same batch.
If two rows in one batch resolve to the same target row, Postgres throws:
`ON CONFLICT DO UPDATE command cannot affect row a second time`.

**Why:** Source data (e.g. a Foratable CSV export) can legitimately repeat the
same business key — for reservations that is `external_reservation_id` (Res.Nr.),
whose DB conflict key is `(restaurant_id, external_reservation_id)`. A user hit
this importing a real file with duplicate Res.Nr. rows; the whole import aborted.

**How to apply:**
- Before building the upsert payload, collapse rows by the exact value used in the
  `onConflict` clause (restaurant_id is constant per import, so dedupe by the
  business key alone is sufficient).
- Make the dedupe deterministic. Pattern used: a `Map` keyed by the conflict key
  (`Map.set` keeps first-insertion order but replaces the value → last row wins,
  stable order). Report how many rows were merged so the UI/stats can surface it.
- Recompute any per-import aggregate stats (counts/sums) from the DEDUPED list, not
  the raw parsed rows, or the import header becomes internally inconsistent
  (e.g. reservation_count=1 but persons counted from 2 duplicate rows).
- NULL conflict-key values do NOT collide in Postgres (NULL != NULL), so they
  never trigger this error — but a NOT NULL business key always will.
- This applies to every bulk upsert in this codebase (guest_profiles by
  match_key, reservation_records by external_reservation_id, guest_crm_profiles,
  etc.), not just reservations.
