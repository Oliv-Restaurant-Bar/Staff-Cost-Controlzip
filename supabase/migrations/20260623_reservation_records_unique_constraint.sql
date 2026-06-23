-- ============================================================================
-- Reservationen-Import — Idempotenz absichern
-- Eindeutiger Constraint auf (restaurant_id, external_reservation_id)
-- Datum: 2026-06-23
-- Ausführen im Supabase SQL-Editor. Idempotent — mehrfaches Ausführen ist sicher.
-- ============================================================================
--
-- HINTERGRUND
--   `reservation_records` darf pro Mandant (restaurant_id) und Foratable-Res.Nr.
--   (external_reservation_id) nur GENAU EINE Zeile führen. Der Import nutzt
--   `ON CONFLICT (restaurant_id, external_reservation_id) DO UPDATE` (siehe
--   src/lib/reservation-import-db.ts), damit ein erneuter Import dieselbe
--   Reservation AKTUALISIERT statt sie zu duplizieren.
--
--   Der Constraint ist bereits in 20260621_reservations.sql als Teil von
--   `CREATE TABLE IF NOT EXISTS` deklariert. `CREATE TABLE IF NOT EXISTS` tut
--   jedoch NICHTS, wenn die Tabelle bereits existierte — in Umgebungen, in denen
--   die Tabelle VOR Einführung dieser Constraint-Zeile angelegt wurde, kann er
--   deshalb fehlen. Dieses Skript ergänzt ihn sauber und idempotent.
--
-- SICHERHEIT
--   - restaurant_id bleibt Teil des Schlüssels: ein Mandant kann NIE die
--     Reservation eines anderen Mandanten treffen oder überschreiben.
--   - Vor dem Anlegen werden eventuelle Alt-Duplikate entfernt (neueste Zeile je
--     Schlüssel bleibt erhalten). Ist die Tabelle bereits eindeutig (Normalfall,
--     weil der Constraint produktiv schon greift), betrifft die Bereinigung
--     0 Zeilen.
-- ============================================================================

-- 1. Eventuelle Alt-Duplikate entfernen — pro (restaurant_id, external_reservation_id)
--    bleibt die zuletzt aktualisierte Zeile erhalten. No-op, wenn bereits eindeutig.
DELETE FROM public.reservation_records r
WHERE r.id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY restaurant_id, external_reservation_id
             ORDER BY COALESCE(updated_at, created_at) DESC, ctid DESC
           ) AS rn
    FROM public.reservation_records
  ) ranked
  WHERE ranked.rn > 1
);

-- 2. Eindeutigen Constraint anlegen, falls er noch nicht existiert.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reservation_records_restaurant_extid_uq'
      AND conrelid = 'public.reservation_records'::regclass
  ) THEN
    ALTER TABLE public.reservation_records
      ADD CONSTRAINT reservation_records_restaurant_extid_uq
      UNIQUE (restaurant_id, external_reservation_id);
    RAISE NOTICE 'Constraint reservation_records_restaurant_extid_uq wurde hinzugefügt.';
  ELSE
    RAISE NOTICE 'Constraint reservation_records_restaurant_extid_uq existiert bereits — nichts zu tun.';
  END IF;
END $$;

-- 3. PostgREST-Schema-Cache neu laden, damit der Constraint sofort greift.
NOTIFY pgrst, 'reload schema';

-- 4. Verifizierung — sollte genau eine UNIQUE-Constraint-Zeile zurückgeben.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.reservation_records'::regclass
  AND contype = 'u'
ORDER BY conname;
