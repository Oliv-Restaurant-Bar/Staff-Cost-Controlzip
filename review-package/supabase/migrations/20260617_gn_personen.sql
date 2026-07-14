-- ============================================================
-- Gastronovi Personen-Bericht Import Tables
-- Ausführen im Supabase SQL-Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS gn_person_imports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  period_from   DATE,
  period_to     DATE,
  import_type   TEXT NOT NULL DEFAULT 'personen',
  checksum      TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  raw_csv_json  JSONB,
  imported_at   TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gn_person_imports_restaurant ON gn_person_imports(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_gn_person_imports_period     ON gn_person_imports(period_from, period_to);
CREATE INDEX IF NOT EXISTS idx_gn_person_imports_checksum   ON gn_person_imports(checksum);

CREATE TABLE IF NOT EXISTS gn_person_metrics (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id        UUID NOT NULL REFERENCES gn_person_imports(id) ON DELETE CASCADE,
  date             DATE,
  period_label     TEXT,
  guests_count     INTEGER NOT NULL DEFAULT 0,
  revenue_per_person NUMERIC,
  revenue_total    NUMERIC,
  source_row_json  JSONB,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gn_person_metrics_import ON gn_person_metrics(import_id);
CREATE INDEX IF NOT EXISTS idx_gn_person_metrics_date   ON gn_person_metrics(date);

ALTER TABLE gn_person_imports DISABLE ROW LEVEL SECURITY;
ALTER TABLE gn_person_metrics DISABLE ROW LEVEL SECURITY;
