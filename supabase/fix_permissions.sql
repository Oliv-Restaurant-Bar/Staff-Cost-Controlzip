-- =============================================================
-- SOFORT-FIX: Fehlende Tabellenberechtigungen
-- Dieses Skript im Supabase SQL-Editor ausführen
-- =============================================================

-- Schema-Zugriff gewähren
GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- Vollzugriff für eingeloggte Benutzer auf alle vier Tabellen
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.schedule_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.actual_hours     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings     TO authenticated;

-- Sequenzen (für auto-generierte IDs)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- RLS auf allen Tabellen sicherstellen (falls jemand sie deaktiviert hat)
ALTER TABLE public.employees        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.actual_hours     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings     ENABLE ROW LEVEL SECURITY;

-- Bestehende Policies löschen und neu anlegen (falls doppelt vorhanden)
DROP POLICY IF EXISTS "auth_employees_select"  ON public.employees;
DROP POLICY IF EXISTS "auth_employees_insert"  ON public.employees;
DROP POLICY IF EXISTS "auth_employees_update"  ON public.employees;
DROP POLICY IF EXISTS "auth_employees_delete"  ON public.employees;

DROP POLICY IF EXISTS "auth_schedule_select"   ON public.schedule_entries;
DROP POLICY IF EXISTS "auth_schedule_insert"   ON public.schedule_entries;
DROP POLICY IF EXISTS "auth_schedule_update"   ON public.schedule_entries;
DROP POLICY IF EXISTS "auth_schedule_delete"   ON public.schedule_entries;

DROP POLICY IF EXISTS "auth_actual_select"     ON public.actual_hours;
DROP POLICY IF EXISTS "auth_actual_insert"     ON public.actual_hours;
DROP POLICY IF EXISTS "auth_actual_update"     ON public.actual_hours;
DROP POLICY IF EXISTS "auth_actual_delete"     ON public.actual_hours;

DROP POLICY IF EXISTS "auth_settings_select"   ON public.app_settings;
DROP POLICY IF EXISTS "auth_settings_insert"   ON public.app_settings;
DROP POLICY IF EXISTS "auth_settings_update"   ON public.app_settings;
DROP POLICY IF EXISTS "auth_settings_delete"   ON public.app_settings;

-- Policies neu anlegen
CREATE POLICY "auth_employees_select"  ON public.employees        FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_employees_insert"  ON public.employees        FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_employees_update"  ON public.employees        FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_employees_delete"  ON public.employees        FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_schedule_select"   ON public.schedule_entries FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_schedule_insert"   ON public.schedule_entries FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_schedule_update"   ON public.schedule_entries FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_schedule_delete"   ON public.schedule_entries FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_actual_select"     ON public.actual_hours     FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_actual_insert"     ON public.actual_hours     FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_actual_update"     ON public.actual_hours     FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_actual_delete"     ON public.actual_hours     FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_settings_select"   ON public.app_settings     FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_settings_insert"   ON public.app_settings     FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_settings_update"   ON public.app_settings     FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_settings_delete"   ON public.app_settings     FOR DELETE TO authenticated USING (true);
