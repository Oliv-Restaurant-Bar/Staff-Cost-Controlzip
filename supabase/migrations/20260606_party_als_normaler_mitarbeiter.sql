-- ─── Migration: Party als normaler Flex-Mitarbeiter anlegen ─────────────────
-- Datum: 2026-06-06
-- Tenant: Oliv (ID ohne 'b-' Präfix)
--
-- Zweck:
--   Party wird als normaler Aushilfe-Mitarbeiter in employees eingetragen.
--   Kawtar existiert bereits als Mitarbeiter ID 107 — keine Aktion nötig.
--
-- SUPABASE AKTION ERFORDERLICH: JA
-- Dieses Skript im Supabase SQL-Editor ausführen.
-- Idempotent: ON CONFLICT DO NOTHING
--
-- Mandanten-Sicherheit:
--   ID 'party' hat kein 'b-' Präfix → wird nur für Oliv geladen
--   Beaulieu-Abfragen filtern id LIKE 'b-%' → betrifft Beaulieu nicht
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Schritt 0: Spalten sicherstellen (idempotent, falls Migration 20260605 noch nicht ausgeführt)
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS is_active   BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ          DEFAULT NULL;

-- Schritt 1: Party als normalen Mitarbeiter eintragen (idempotent)
INSERT INTO public.employees (id, name, department, employment_type, hourly_wage, is_active)
VALUES ('party', 'Party', 'kueche', 'aushilfe', 25.00, true)
ON CONFLICT (id) DO UPDATE SET
  name            = 'Party',
  department      = 'kueche',
  employment_type = 'aushilfe',
  hourly_wage     = 25.00,
  is_active       = true,
  archived_at     = NULL;

-- Schritt 2: Kawtar (ID 107) sicherstellen — aktiv, korrekte Werte
-- Falls Kawtar als ID '107' existiert, sicherstellen dass sie aktiv ist und CHF 20/h hat
UPDATE public.employees
SET
  is_active   = true,
  archived_at = NULL,
  hourly_wage = COALESCE(NULLIF(hourly_wage, 0), 20.00)
WHERE id = '107'
  AND name ILIKE '%kawtar%';

-- Schritt 3: Alle aush_* Einträge von Party/Kawtar in schedule_extra_cost_people archivieren
-- (falls noch aktiv — sie sind jetzt normale Mitarbeiter)
UPDATE public.schedule_extra_cost_people
SET
  is_active   = false,
  archived_at = COALESCE(archived_at, now())
WHERE (name ILIKE '%party%' OR name ILIKE '%kawtar%')
  AND tenant_id = 'oliv'
  AND is_active = true;

-- Schritt 4: Validierungsbericht
DO $$
DECLARE
  party_exists   BOOLEAN;
  party_dept     TEXT;
  party_wage     NUMERIC;
  kawtar_exists  BOOLEAN;
  kawtar_id      TEXT;
  kawtar_dept    TEXT;
  kawtar_wage    NUMERIC;
  archived_count INT;
BEGIN
  SELECT (COUNT(*) > 0), department, hourly_wage
    INTO party_exists, party_dept, party_wage
    FROM public.employees WHERE id = 'party' AND is_active = true;

  SELECT (COUNT(*) > 0), id, department, hourly_wage
    INTO kawtar_exists, kawtar_id, kawtar_dept, kawtar_wage
    FROM public.employees WHERE name ILIKE '%kawtar%' AND is_active = true LIMIT 1;

  SELECT COUNT(*) INTO archived_count
    FROM public.schedule_extra_cost_people
    WHERE (name ILIKE '%party%' OR name ILIKE '%kawtar%')
      AND tenant_id = 'oliv'
      AND is_active = false;

  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════';
  RAISE NOTICE '  PARTY + KAWTAR → NORMALE MITARBEITER — ERGEBNIS';
  RAISE NOTICE '═══════════════════════════════════════════════════════';
  RAISE NOTICE '';
  RAISE NOTICE '  Party:';
  RAISE NOTICE '    In employees (aktiv):  %', party_exists;
  RAISE NOTICE '    Abteilung:             % (soll: kueche)', party_dept;
  RAISE NOTICE '    Stundenlohn:           % CHF (soll: 25.00)', party_wage;
  RAISE NOTICE '';
  RAISE NOTICE '  Kawtar:';
  RAISE NOTICE '    In employees (aktiv):  %', kawtar_exists;
  RAISE NOTICE '    ID:                    %', kawtar_id;
  RAISE NOTICE '    Abteilung:             % (soll: service)', kawtar_dept;
  RAISE NOTICE '    Stundenlohn:           % CHF (soll: 20.00)', kawtar_wage;
  RAISE NOTICE '';
  RAISE NOTICE '  In schedule_extra_cost_people archiviert: %', archived_count;
  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════';

  IF NOT party_exists THEN
    RAISE WARNING 'FEHLER: Party nicht in employees!';
  END IF;
  IF NOT kawtar_exists THEN
    RAISE WARNING 'HINWEIS: Keine aktive Kawtar in employees gefunden — bitte prüfen.';
  END IF;
END $$;

COMMIT;
