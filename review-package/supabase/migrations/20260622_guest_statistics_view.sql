-- ============================================================================
-- Gäste-CRM — read-only View `guest_statistics`
-- ============================================================================
-- Ergänzt die bestehenden Tabellen `guest_profiles` + `reservation_records`
-- (KEINE Migration, KEINE Umstrukturierung) um eine reine Lese-View, damit die
-- CRM-Kennzahlen auch direkt in Supabase (SQL) abgefragt werden können.
--
-- WICHTIG — Semantik 1:1 wie `src/lib/reservation-crm.ts`:
--   * „Besuch" = ABGESCHLOSSENE Reservation (status_normalized = 'completed').
--     Stornos/No-Shows zählen NICHT als Besuch.
--   * Erster/letzter Besuch, Ø-Intervall, Segment leiten sich ausschliesslich
--     aus den abgeschlossenen Reservationen ab — NICHT aus
--     guest_profiles.first_seen_at/last_seen_at (die alle Status umfassen).
--   * Segment-Schwellen: VIP ≥ 20, Stammgast 8–19, Wiederkehrend 3–7,
--     Neukunde 1–2, Inaktiv (≥ 3 Besuche, aber > 90 Tage kein Besuch),
--     Ohne Besuch (0 abgeschlossene Besuche).
-- Ändert sich `reservation-crm.ts`, MUSS diese View im Gleichschritt angepasst
-- werden, sonst weichen UI und SQL-Auswertung voneinander ab.
--
-- DATENSCHUTZ: security_invoker = true → die View nutzt die RLS/Rechte des
-- abfragenden Benutzers. Da `anon` auf den Basistabellen keine Rechte hat
-- (REVOKE ALL … FROM anon), kann anon die View nicht lesen. PII bleibt
-- ausschliesslich für `authenticated`/`service_role` zugänglich.
--
-- Ausführen: einmalig im Supabase SQL-Editor (idempotent, CREATE OR REPLACE).
-- ============================================================================

CREATE OR REPLACE VIEW public.guest_statistics
WITH (security_invoker = true) AS
WITH agg AS (
  SELECT
    r.guest_id,
    -- alle Reservationen (alle Status) — reines Infofeld, KEIN „Besuch"
    COUNT(*)                                                           AS total_reservations,
    -- nur abgeschlossene Reservationen = „Besuche"
    COUNT(*) FILTER (WHERE r.status_normalized = 'completed')          AS completed_visit_count,
    COUNT(*) FILTER (WHERE r.status_normalized = 'cancelled')          AS cancellation_count,
    COUNT(*) FILTER (WHERE r.status_normalized = 'noshow')             AS no_show_count,
    MIN(r.reservation_date) FILTER (WHERE r.status_normalized = 'completed') AS first_visit_date,
    MAX(r.reservation_date) FILTER (WHERE r.status_normalized = 'completed') AS last_visit_date,
    COALESCE(
      SUM(r.party_size) FILTER (
        WHERE r.status_normalized = 'completed' AND r.party_size IS NOT NULL
      ), 0)                                                            AS total_party_size,
    AVG(r.party_size::numeric) FILTER (
      WHERE r.status_normalized = 'completed' AND r.party_size IS NOT NULL
    )                                                                  AS average_party_size
  FROM public.reservation_records r
  WHERE r.guest_id IS NOT NULL
  GROUP BY r.guest_id
)
SELECT
  g.id                                          AS guest_id,
  g.restaurant_id,
  -- „Besuch" = abgeschlossene Reservation → total_visits == completed_visit_count.
  COALESCE(a.completed_visit_count,  0)         AS total_visits,
  -- alle Reservationen (alle Status), reines Infofeld, fliesst NICHT ins Segment.
  COALESCE(a.total_reservations,     0)         AS total_reservations,
  a.first_visit_date,
  a.last_visit_date,
  -- Ø Tage zwischen Besuchen = (letzter − erster) / (Besuche − 1);
  -- NULL bei < 2 Besuchen oder Spanne ≤ 0 (z. B. mehrere Besuche am selben Tag).
  CASE
    WHEN COALESCE(a.completed_visit_count, 0) >= 2
         AND a.first_visit_date IS NOT NULL
         AND a.last_visit_date  IS NOT NULL
         AND (a.last_visit_date - a.first_visit_date) > 0
    THEN (a.last_visit_date - a.first_visit_date)::numeric / (a.completed_visit_count - 1)
    ELSE NULL
  END                                           AS average_days_between_visits,
  -- Tage seit letztem Besuch (nie negativ); NULL ohne abgeschlossenen Besuch.
  CASE
    WHEN a.last_visit_date IS NOT NULL
    THEN GREATEST(CURRENT_DATE - a.last_visit_date, 0)
    ELSE NULL
  END                                           AS days_since_last_visit,
  COALESCE(a.total_party_size, 0)               AS total_party_size,
  a.average_party_size,
  COALESCE(a.cancellation_count,     0)         AS cancellation_count,
  COALESCE(a.no_show_count,          0)         AS no_show_count,
  COALESCE(a.completed_visit_count,  0)         AS completed_visit_count,
  -- Segment exakt wie classifySegment(visits = completed_visit_count, daysSinceLastVisit).
  -- Inaktiv-Regel überschreibt die zahlbasierten Segmente.
  CASE
    WHEN COALESCE(a.completed_visit_count, 0) <= 0 THEN 'ohne_besuch'
    WHEN a.completed_visit_count >= 3
         AND a.last_visit_date IS NOT NULL
         AND (CURRENT_DATE - a.last_visit_date) > 90 THEN 'inaktiv'
    WHEN a.completed_visit_count >= 20 THEN 'vip'
    WHEN a.completed_visit_count >= 8  THEN 'stammgast'
    WHEN a.completed_visit_count >= 3  THEN 'wiederkehrend'
    ELSE 'neukunde'
  END                                           AS guest_segment
FROM public.guest_profiles g
LEFT JOIN agg a ON a.guest_id = g.id;

-- ── Rechte: nur authenticated/service_role, kein anon (PII-Schutz) ───────────
REVOKE ALL ON public.guest_statistics FROM PUBLIC;
REVOKE ALL ON public.guest_statistics FROM anon;
GRANT  SELECT ON public.guest_statistics TO authenticated, service_role;

-- PostgREST Schema-Cache neu laden (View sofort über die API verfügbar).
NOTIFY pgrst, 'reload schema';

-- ── Selbsttest 1: Konsistenz der View ───────────────────────────────────────
DO $$
DECLARE
  v_view_rows         bigint;
  v_profile_rows      bigint;
  v_view_completed    bigint;
  v_view_total_visits bigint;
  v_view_total_res    bigint;
  v_rec_completed     bigint;
  v_rec_total         bigint;
  v_null_segments     bigint;
BEGIN
  SELECT count(*) INTO v_view_rows    FROM public.guest_statistics;
  SELECT count(*) INTO v_profile_rows FROM public.guest_profiles;
  IF v_view_rows <> v_profile_rows THEN
    RAISE EXCEPTION 'guest_statistics: % Zeilen, erwartet % (= guest_profiles).',
      v_view_rows, v_profile_rows;
  END IF;

  SELECT COALESCE(sum(completed_visit_count), 0),
         COALESCE(sum(total_visits),          0),
         COALESCE(sum(total_reservations),    0)
  INTO   v_view_completed, v_view_total_visits, v_view_total_res
  FROM public.guest_statistics;

  SELECT count(*) FILTER (WHERE status_normalized = 'completed'),
         count(*)
  INTO   v_rec_completed, v_rec_total
  FROM public.reservation_records
  WHERE guest_id IS NOT NULL;

  IF v_view_completed <> v_rec_completed THEN
    RAISE EXCEPTION 'guest_statistics: Summe completed_visit_count % <> % (reservation_records completed).',
      v_view_completed, v_rec_completed;
  END IF;
  -- total_visits muss completed-only sein („Besuch" = abgeschlossen).
  IF v_view_total_visits <> v_rec_completed THEN
    RAISE EXCEPTION 'guest_statistics: Summe total_visits % <> % (muss = completed sein).',
      v_view_total_visits, v_rec_completed;
  END IF;
  -- total_reservations zählt alle Status.
  IF v_view_total_res <> v_rec_total THEN
    RAISE EXCEPTION 'guest_statistics: Summe total_reservations % <> % (alle reservation_records mit guest_id).',
      v_view_total_res, v_rec_total;
  END IF;

  SELECT count(*) INTO v_null_segments
  FROM public.guest_statistics WHERE guest_segment IS NULL;
  IF v_null_segments > 0 THEN
    RAISE EXCEPTION 'guest_statistics: % Zeilen mit NULL guest_segment.', v_null_segments;
  END IF;

  RAISE NOTICE '=== Selbsttest OK: guest_statistics konsistent (% Gaeste, % abgeschlossene Besuche). ===',
    v_view_rows, v_view_completed;
END $$;

-- ── Selbsttest 2: anon darf die View NICHT lesen (PII-Leck-Schutz) ───────────
DO $$
BEGIN
  SET LOCAL ROLE anon;
  PERFORM 1 FROM public.guest_statistics LIMIT 1;
  RESET ROLE;
  RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: anon konnte guest_statistics lesen (PII-Leck!).';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '=== Selbsttest OK: anon-Zugriff auf guest_statistics blockiert. ===';
END $$;

-- ── Verifikation: Segment-Verteilung anzeigen ───────────────────────────────
SELECT guest_segment, count(*) AS guests
FROM public.guest_statistics
GROUP BY guest_segment
ORDER BY guests DESC;
