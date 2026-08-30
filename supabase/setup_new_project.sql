-- =============================================================
-- Personalkostentracker – Datenbankeinrichtung (neues Projekt)
-- Dieses Skript einmalig im Supabase SQL-Editor ausführen
-- =============================================================

-- Mitarbeitertabelle
CREATE TABLE IF NOT EXISTS public.employees (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT NOT NULL CHECK (department IN ('service', 'kueche')),
  employment_type TEXT NOT NULL DEFAULT 'aushilfe'
    CHECK (employment_type IN ('vollzeit', 'teilzeit', 'minijob', 'aushilfe')),
  hourly_wage NUMERIC(10,2) NOT NULL DEFAULT 0,
  weekly_hours NUMERIC(5,2),
  monthly_salary NUMERIC(10,2),
  monthly_salary_with_13th NUMERIC(10,2),
  days_off TEXT[] DEFAULT '{}',
  preferred_work_days TEXT[] DEFAULT '{}',
  hours_balance NUMERIC(8,2),
  vacation_balance NUMERIC(8,2),
  vacation_days_per_year NUMERIC(5,1),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Dienstplantabelle (Soll-Stunden pro Mitarbeiter und Tag)
CREATE TABLE IF NOT EXISTS public.schedule_entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  frueh_start TEXT,
  frueh_end TEXT,
  frueh_absence TEXT,
  spaet_start TEXT,
  spaet_end TEXT,
  spaet_absence TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, date)
);

-- Ist-Stunden-Tabelle (tatsächlich geleistete Stunden)
CREATE TABLE IF NOT EXISTS public.actual_hours (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  hours NUMERIC(5,2),
  start_time TEXT,
  end_time TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, date)
);

-- App-Einstellungen (geteilte Konfiguration für alle Benutzer)
CREATE TABLE IF NOT EXISTS public.app_settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Row Level Security aktivieren
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.actual_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Berechtigungen: nur angemeldete Benutzer dürfen lesen/schreiben
CREATE POLICY "auth_employees_select" ON public.employees FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_employees_insert" ON public.employees FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_employees_update" ON public.employees FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_employees_delete" ON public.employees FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_schedule_select" ON public.schedule_entries FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_schedule_insert" ON public.schedule_entries FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_schedule_update" ON public.schedule_entries FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_schedule_delete" ON public.schedule_entries FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_actual_select" ON public.actual_hours FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_actual_insert" ON public.actual_hours FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_actual_update" ON public.actual_hours FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_actual_delete" ON public.actual_hours FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_settings_select" ON public.app_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_settings_insert" ON public.app_settings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_settings_update" ON public.app_settings FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_settings_delete" ON public.app_settings FOR DELETE TO authenticated USING (true);

-- Zugriffsrechte für eingeloggte Benutzer (GRANT muss immer gesetzt werden!)
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.schedule_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.actual_hours     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings     TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Indizes für schnellere Abfragen
CREATE INDEX IF NOT EXISTS idx_schedule_employee_date ON public.schedule_entries(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_schedule_date ON public.schedule_entries(date);
CREATE INDEX IF NOT EXISTS idx_actual_employee_date ON public.actual_hours(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_actual_date ON public.actual_hours(date);

-- Standardmitarbeiter eintragen (können später im Tool angepasst werden)
INSERT INTO public.employees (id, name, department, employment_type, hourly_wage, weekly_hours, monthly_salary, monthly_salary_with_13th) VALUES
  ('1',  'Mendim',             'service', 'vollzeit', 36.92, 42, 5538.45, 6203.06),
  ('2',  'Artin',              'service', 'vollzeit', 33.85, 42, 5076.95, 5686.18),
  ('3',  'Joana',              'service', 'teilzeit', 28.00, NULL, NULL, NULL),
  ('4',  'Husein',             'service', 'vollzeit', 31.33, 42, 5000.00, 5264.00),
  ('5',  'Eduard',             'service', 'vollzeit', 34.46, 42, 5169.25, 5789.56),
  ('6',  'Nahuel',             'service', 'vollzeit', 28.31, 42, 4246.50, 4756.08),
  ('7',  'Carlos',             'service', 'teilzeit', 24.70, NULL, NULL, NULL),
  ('8',  'Arber',              'service', 'vollzeit', 30.77, 42, 4615.40, 5169.25),
  ('9',  'Marion',             'service', 'vollzeit', 28.67, 42, 4576.95, 4816.00),
  ('10', 'Isabel',             'service', 'teilzeit', 26.37, NULL, NULL, NULL),
  ('11', 'David',              'service', 'vollzeit', 31.33, 42, 4700.00, 5264.00),
  ('12', 'Saad',               'service', 'vollzeit', 26.00, 42, 3900.00, 4368.00),
  ('13', 'Aushilfe Service',   'service', 'teilzeit', 20.50, NULL, NULL, NULL),
  ('14', 'Mejdi',              'kueche',  'vollzeit', 0.00, 42, 7400.00, 8288.00),
  ('15', 'Miro',               'kueche',  'vollzeit', 34.46, 42, 5169.00, 5789.28),
  ('16', 'Culi',               'kueche',  'vollzeit', 47.33, 42, 7100.00, 7952.00),
  ('17', 'Karel',              'kueche',  'vollzeit', 30.67, 42, 4600.00, 5152.00),
  ('18', 'Micky',              'kueche',  'vollzeit', 27.69, 42, 4153.85, 4652.31),
  ('19', 'Asim',               'kueche',  'vollzeit', 28.92, 42, 4338.45, 4859.06),
  ('20', 'Ali',                'kueche',  'teilzeit', 20.36, NULL, NULL, NULL),
  ('21', 'Sadete',             'kueche',  'teilzeit', 20.36, NULL, NULL, NULL),
  ('24', 'Sajed',              'kueche',  'vollzeit', 20.36, NULL, NULL, NULL),
  ('22', 'Aushilfe 1 Küche F', 'kueche', 'teilzeit', 30.00, NULL, NULL, NULL),
  ('23', 'Aushilfe 2 Küche A', 'kueche', 'teilzeit', 30.00, NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;
