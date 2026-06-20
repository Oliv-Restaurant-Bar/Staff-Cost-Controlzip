---
name: Reservation CRM visit metrics & PII gating
description: How guest visit counts/segments must be computed, and the admin-gating posture for guest/reservation data.
---

## Never mix all-status seen-dates with completed-only counts

`guest_profiles.first_seen_at` / `last_seen_at` are recomputed from **all**
reservation statuses (the import aggregate has no status filter), but
`completed_reservations` is **completed-only**. "Visit" in the CRM = a
completed reservation.

**Rule:** any visit-based metric (visit count, first/last visit, average
interval, segment, the >90-day "Inaktiv" rule) must derive first/last visit
from completed `reservation_records` — never from `first_seen_at`/`last_seen_at`.

**Why:** a guest with old completed visits plus a recent cancelled/confirmed/
pending booking has a recent `last_seen_at` but an old last *completed* visit.
Mixing them made the list page show "active/VIP" while the detail page (which
derives from completed-only rows) showed "Inaktiv" — list and detail disagreed.

**How to apply:** the list page aggregates completed-only visits per guest from
`reservation_records` (paginated to beat the 1000-row select cap) and feeds that
to the segmentation logic, so list and detail use the identical basis.

## Guest/reservation PII is admin-gated at the UI, not at the DB

The reservation/guest tables use authenticated-wide RLS by app convention
(same as other admin-only pages like Personalstamm). Admin-only access is
enforced in React (route redirect + a `if (!isAdmin) return` guard before any
Supabase read), not via row-level role policies.

**Why:** Task scope forbade new migrations; the whole app relies on UI gating.
**How to apply:** if true DB-level admin enforcement is ever required, it needs
an RLS/RPC change (a migration) for `guest_profiles` + `reservation_records` —
a deliberate, app-wide security decision, not a per-page tweak.

## guest_statistics SQL view must track reservation-crm.ts in lockstep

There is an optional read-only view `guest_statistics`
(`supabase/migrations/20260622_guest_statistics_view.sql`) over the existing
tables — the app does NOT use it; it exists only for direct Supabase/SQL
analysis. It re-implements the exact segment thresholds and visit/interval
math from `reservation-crm.ts` (visits = completed only; inactive rule
overrides; same VIP/Stammgast/… cutoffs).

**Rule:** any change to the segment thresholds or visit/metric definitions in
`reservation-crm.ts` must be reflected in this view's SQL in the same change,
or the SQL view and the UI will disagree.
**Why:** the whole point of the view is parity with what the CRM screens show.
**How to apply:** view uses `security_invoker = true` so RLS of the base tables
applies (anon blocked, PII safe); it must stay a pure read-only view (no data
duplication, no migration of the base tables).
