-- ============================================================
-- employee_wages – Lohnhistorie pro Mitarbeiter
-- ============================================================
-- Dieses Script im Supabase SQL Editor ausführen.
--
-- Zweck:
--   Speichert Lohnänderungen mit Gültigkeitsdatum.
--   Alte Einträge in der employees-Tabelle (hourly_wage,
--   monthly_salary) bleiben unverändert als Fallback erhalten.
--
-- Tenant-Trennung:
--   restaurant_id = 'oliv' oder 'beaulieu'
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_wages (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id              TEXT          NOT NULL,
  restaurant_id            TEXT          NOT NULL,  -- 'oliv' | 'beaulieu'
  valid_from               DATE          NOT NULL,  -- ab diesem Datum gültig
  hourly_wage              NUMERIC(10,2) NOT NULL DEFAULT 0,
  monthly_salary           NUMERIC(10,2) NOT NULL DEFAULT 0,
  monthly_salary_with_13th NUMERIC(10,2) NOT NULL DEFAULT 0,
  salary_13                BOOLEAN       NOT NULL DEFAULT false,
  notes                    TEXT          NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Index für schnelle Abfragen: Mitarbeiter + Datum
CREATE INDEX IF NOT EXISTS idx_employee_wages_lookup
  ON employee_wages(restaurant_id, employee_id, valid_from DESC);

-- Row Level Security: gleich wie bestehende Tabellen
ALTER TABLE employee_wages ENABLE ROW LEVEL SECURITY;

-- Alle Operationen erlauben (anon + authenticated)
DO $$
BEGIN
  -- Authenticated
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'employee_wages' AND policyname = 'employee_wages_auth_all'
  ) THEN
    CREATE POLICY "employee_wages_auth_all" ON employee_wages
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  -- Anon (wie andere Tabellen im Projekt)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'employee_wages' AND policyname = 'employee_wages_anon_all'
  ) THEN
    CREATE POLICY "employee_wages_anon_all" ON employee_wages
      AS PERMISSIVE FOR ALL TO anon
      USING (true) WITH CHECK (true);
  END IF;
END;
$$;

-- Prüfung
SELECT 'employee_wages Tabelle bereit.' AS status;
