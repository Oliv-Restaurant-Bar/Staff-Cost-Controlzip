-- ============================================================
-- Gastronovi Analysis: fehlende Analyse-Tabellen erstellen
-- Ausführen im Supabase SQL-Editor
-- Berührt KEINE bestehenden Tabellen.
-- ============================================================

-- ── 1. gn_analysis_imports ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gn_analysis_imports (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID,
  file_name     TEXT        NOT NULL,
  analysis_type TEXT        NOT NULL,
  period_from   TIMESTAMPTZ,
  period_to     TIMESTAMPTZ,
  checksum      TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'completed',
  raw_csv_json  JSONB,
  imported_at   TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gn_analysis_imports_checksum
  ON gn_analysis_imports(checksum);

CREATE INDEX IF NOT EXISTS idx_gn_analysis_imports_type_period
  ON gn_analysis_imports(analysis_type, period_from, period_to);

-- ── 2. gn_analysis_metrics ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gn_analysis_metrics (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id        UUID    REFERENCES gn_analysis_imports(id) ON DELETE CASCADE,
  metric_type      TEXT    NOT NULL,
  date             DATE,
  period_label     TEXT,
  value            NUMERIC,
  amount           NUMERIC,
  source_row_json  JSONB,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gn_analysis_metrics_import
  ON gn_analysis_metrics(import_id);

CREATE INDEX IF NOT EXISTS idx_gn_analysis_metrics_type_date
  ON gn_analysis_metrics(metric_type, date);

-- ── 3. RLS deaktivieren (analog gn_zbericht.sql + gn_personen.sql) ───────────

ALTER TABLE gn_analysis_imports DISABLE ROW LEVEL SECURITY;
ALTER TABLE gn_analysis_metrics DISABLE ROW LEVEL SECURITY;

-- ── 4. Zugriffsrechte ─────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON gn_analysis_imports TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_analysis_metrics TO authenticated, anon;
