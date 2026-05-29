-- ─────────────────────────────────────────────────────────────────────────────
-- schedule_change_log + schedule_publication_snapshots
-- Erstellt: 2026-05-29
--
-- Zweck:
--   schedule_change_log        — pro-Zelle Änderungsprotokoll nach Publikation
--   schedule_publication_snapshots — vollständiger Snapshot jeder Publikation
--
-- Ausführen: Supabase SQL-Editor (einmalig)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. schedule_change_log ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.schedule_change_log (
  id           BIGSERIAL     PRIMARY KEY,
  tenant_id    TEXT          NOT NULL DEFAULT 'oliv',
  employee_id  TEXT          NOT NULL,
  date         DATE          NOT NULL,
  department   TEXT,                          -- 'service' | 'küche'
  field_name   TEXT          NOT NULL,        -- 'frueh_start', 'spaet_end', etc.
  old_value    TEXT,
  new_value    TEXT,
  changed_by   TEXT          NOT NULL,        -- user email
  changed_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  change_type  TEXT          NOT NULL,        -- 'first_publish' | 'update_after_publish'
  note         TEXT,
  revision     INTEGER                        -- Revision der Publikation
);

CREATE INDEX IF NOT EXISTS idx_schedule_change_log_tenant_date
  ON public.schedule_change_log (tenant_id, date);

CREATE INDEX IF NOT EXISTS idx_schedule_change_log_employee
  ON public.schedule_change_log (employee_id, date);

ALTER TABLE public.schedule_change_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_schedule_change_log_select"
  ON public.schedule_change_log FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_schedule_change_log_insert"
  ON public.schedule_change_log FOR INSERT TO authenticated WITH CHECK (true);

GRANT SELECT, INSERT ON public.schedule_change_log TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.schedule_change_log_id_seq TO authenticated;


-- ── 2. schedule_publication_snapshots ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.schedule_publication_snapshots (
  id            BIGSERIAL   PRIMARY KEY,
  tenant_id     TEXT        NOT NULL DEFAULT 'oliv',
  year          INTEGER     NOT NULL,
  month         INTEGER     NOT NULL,
  department    TEXT        NOT NULL DEFAULT 'all',  -- 'all' | 'service' | 'küche'
  published_by  TEXT        NOT NULL,                -- user email
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revision      INTEGER     NOT NULL DEFAULT 1,
  snapshot_json JSONB       NOT NULL,
  UNIQUE (tenant_id, year, month, department, revision)
);

CREATE INDEX IF NOT EXISTS idx_schedule_snapshots_tenant_period
  ON public.schedule_publication_snapshots (tenant_id, year, month);

ALTER TABLE public.schedule_publication_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_schedule_snapshots_select"
  ON public.schedule_publication_snapshots FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_schedule_snapshots_insert"
  ON public.schedule_publication_snapshots FOR INSERT TO authenticated WITH CHECK (true);

GRANT SELECT, INSERT ON public.schedule_publication_snapshots TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.schedule_publication_snapshots_id_seq TO authenticated;
