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
