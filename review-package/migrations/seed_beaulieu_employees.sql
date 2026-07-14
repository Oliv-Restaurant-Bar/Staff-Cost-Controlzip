-- ============================================================
-- Seed: Echte Beaulieu-Mitarbeitende
-- Datum: 2026-04-20
-- Quelle: Mirus Tägliche Stunden + Benutzerdefinierte Korrekturen
--
-- ANLEITUNG:
-- 1. Zuerst sicherstellen, dass 20260420_multi_tenant.sql bereits
--    ausgeführt wurde (restaurant_id-Spalte muss existieren).
-- 2. Dieses Script in Supabase SQL Editor ausführen.
-- 3. Upsert: bei erneutem Ausführen entstehen KEINE Duplikate.
-- 4. Oliv-Mitarbeitende (restaurant_id = 'oliv') bleiben unberührt.
--
-- ABTEILUNGS-MAPPING:
--   1 Küche         → department = 'kueche'
--   3 Hilfsarbeiter → department = 'kueche'  (selbe Personen, gleiche Abt.)
--   2 Service       → department = 'service'
--   4 Geschäftsleit.→ department = 'service' (nur Marcel Krebs)
--
-- IDs: Präfix "b-" verhindert Kollisionen mit Oliv-IDs (1–24)
-- Lohn/Gehalt: auf 0 gesetzt → bitte in der App nachpflegen
-- ============================================================

-- Schritt 1: Sicherstellen dass restaurant_id-Spalte existiert
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS restaurant_id TEXT NOT NULL DEFAULT 'oliv';

-- Schritt 2: Upsert der echten Beaulieu-Mitarbeitenden
INSERT INTO employees (
  id,
  name,
  department,
  employment_type,
  hourly_wage,
  restaurant_id,
  days_off,
  preferred_work_days,
  social_cost_factor,
  has_13th_salary,
  onboarding_status
) VALUES

  -- ── KÜCHE (1 Küche + 3 Hilfsarbeiter) ──────────────────────────────────────
  ('b-1',  'Barrera Hinestroza Jonathan Filipe', 'kueche',  'vollzeit', 0.00, 'beaulieu', '[]', '[]', 1.03, false, 'none'),
  ('b-2',  'Elmazi Fatmire',                     'kueche',  'vollzeit', 0.00, 'beaulieu', '[]', '[]', 1.03, false, 'none'),
  ('b-3',  'Hadzija Hatidze',                    'kueche',  'vollzeit', 0.00, 'beaulieu', '[]', '[]', 1.03, false, 'none'),
  ('b-4',  'Horvath Robert Stefan',               'kueche',  'vollzeit', 0.00, 'beaulieu', '[]', '[]', 1.03, false, 'none'),
  ('b-5',  'Ramadani Naip',                       'kueche',  'vollzeit', 0.00, 'beaulieu', '[]', '[]', 1.03, false, 'none'),
  ('b-6',  'Santana Cristo Barreto',              'kueche',  'vollzeit', 0.00, 'beaulieu', '[]', '[]', 1.03, false, 'none'),

  -- ── SERVICE (2 Service + Marcel Krebs aus 4 Geschäftsleitung) ───────────────
  ('b-7',  'Burkhalter Nadica',                   'service', 'vollzeit', 0.00, 'beaulieu', '[]', '[]', 1.03, false, 'none'),
  ('b-8',  'Filipovic Maja',                      'service', 'teilzeit', 0.00, 'beaulieu', '[]', '[]', 1.03, false, 'none'),
  ('b-9',  'Syvrydovych Varvara',                 'service', 'vollzeit', 0.00, 'beaulieu', '[]', '[]', 1.03, false, 'none'),
  ('b-10', 'Krebs Marcel',                        'service', 'vollzeit', 0.00, 'beaulieu', '[]', '[]', 1.03, false, 'none')

ON CONFLICT (id) DO UPDATE SET
  name              = EXCLUDED.name,
  department        = EXCLUDED.department,
  employment_type   = EXCLUDED.employment_type,
  restaurant_id     = EXCLUDED.restaurant_id,
  social_cost_factor = EXCLUDED.social_cost_factor,
  has_13th_salary   = EXCLUDED.has_13th_salary,
  onboarding_status = EXCLUDED.onboarding_status;
  -- hourly_wage wird NICHT überschrieben, damit nachgepflegte Löhne erhalten bleiben

-- Schritt 3: Bestätigung
SELECT
  id,
  name,
  department,
  employment_type,
  restaurant_id
FROM employees
WHERE restaurant_id = 'beaulieu'
ORDER BY department, name;
