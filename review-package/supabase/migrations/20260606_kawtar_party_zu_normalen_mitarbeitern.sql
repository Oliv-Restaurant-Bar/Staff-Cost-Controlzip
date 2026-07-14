-- ─── Migration: Kawtar + Party → normale Flex-Mitarbeiter ──────────────────
-- Datum: 2026-06-06
-- Tenant: Oliv (kein b-Präfix → Beaulieu unberührt)
--
-- Zweck:
--   Kawtar existiert bereits als normaler employees-Eintrag (id = 107).
--   Party wird als neuer employees-Eintrag angelegt (id = 'party').
--   Bestehende schedule_entries und actual_hours werden auf die Ziel-IDs
--   umgeschrieben. Alte aush_*-Einträge werden archiviert.
--
-- SUPABASE AKTION ERFORDERLICH: JA
-- Dieses Skript im Supabase SQL-Editor ausführen.
-- Idempotent: ON CONFLICT DO NOTHING + UPDATE WHERE aktiv.
--
-- Bekannte Quell-IDs (aus schedule_extra_cost_people):
--   Kawtar → aush_1780347607805  (Ziel: employees id = '107')
--   Party  → aush_1778236182278  (Ziel: employees id = 'party')
--
-- Beaulieu-Sicherheit:
--   Alle WHERE-Klauseln schliessen b-Präfix-IDs und beaulieu-tenant_id aus.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Schritt 0: Spalten sicherstellen (idempotent) ────────────────────────────
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS is_active   BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ          DEFAULT NULL;

-- ── Schritt 1: Kawtar — bestehenden employees-Eintrag (id=107) sicherstellen ─
-- Kawtar hat bereits eine normale ID 107. Nur sicherstellen dass sie aktiv ist.
UPDATE public.employees
SET
  is_active   = true,
  archived_at = NULL,
  hourly_wage = CASE WHEN COALESCE(hourly_wage, 0) = 0 THEN 20.00 ELSE hourly_wage END
WHERE id = '107'
  AND name ILIKE '%kawtar%';

-- ── Schritt 2: Party — neuen employees-Eintrag anlegen falls noch nicht aktiv ─
INSERT INTO public.employees (id, name, department, employment_type, hourly_wage, is_active)
VALUES ('party', 'Party', 'kueche', 'aushilfe', 25.00, true)
ON CONFLICT (id) DO UPDATE SET
  name            = 'Party',
  department      = 'kueche',
  employment_type = 'aushilfe',
  hourly_wage     = 25.00,
  is_active       = true,
  archived_at     = NULL;

-- ── Schritt 3: schedule_entries migrieren ─────────────────────────────────────

-- Kawtar: bekannte aush_-ID → 107
UPDATE public.schedule_entries
SET employee_id = '107'
WHERE employee_id = 'aush_1780347607805';

-- Kawtar: alle weiteren aush_*-Einträge via schedule_extra_cost_people (Oliv)
UPDATE public.schedule_entries
SET employee_id = '107'
WHERE employee_id IN (
  SELECT id FROM public.schedule_extra_cost_people
  WHERE name ILIKE '%kawtar%'
    AND tenant_id = 'oliv'
    AND id NOT LIKE 'b-%'
)
AND employee_id != '107';

-- Kawtar: aush_*-Einträge in employees-Tabelle (Oliv, kein b-Präfix)
UPDATE public.schedule_entries
SET employee_id = '107'
WHERE employee_id IN (
  SELECT id FROM public.employees
  WHERE name ILIKE '%kawtar%'
    AND id LIKE 'aush_%'
    AND id NOT LIKE 'b-%'
)
AND employee_id != '107';

-- Party: bekannte aush_-ID → 'party'
UPDATE public.schedule_entries
SET employee_id = 'party'
WHERE employee_id = 'aush_1778236182278';

-- Party: alle weiteren aush_*-Einträge via schedule_extra_cost_people (Oliv)
UPDATE public.schedule_entries
SET employee_id = 'party'
WHERE employee_id IN (
  SELECT id FROM public.schedule_extra_cost_people
  WHERE name ILIKE '%party%'
    AND tenant_id = 'oliv'
    AND id NOT LIKE 'b-%'
)
AND employee_id != 'party';

-- Party: aush_*-Einträge in employees-Tabelle (Oliv, kein b-Präfix)
UPDATE public.schedule_entries
SET employee_id = 'party'
WHERE employee_id IN (
  SELECT id FROM public.employees
  WHERE name ILIKE '%party%'
    AND id LIKE 'aush_%'
    AND id NOT LIKE 'b-%'
)
AND employee_id != 'party';

-- ── Schritt 4: actual_hours migrieren ────────────────────────────────────────

-- Kawtar: bekannte aush_-ID → 107
UPDATE public.actual_hours
SET employee_id = '107'
WHERE employee_id = 'aush_1780347607805';

-- Kawtar: alle weiteren via schedule_extra_cost_people
UPDATE public.actual_hours
SET employee_id = '107'
WHERE employee_id IN (
  SELECT id FROM public.schedule_extra_cost_people
  WHERE name ILIKE '%kawtar%'
    AND tenant_id = 'oliv'
    AND id NOT LIKE 'b-%'
)
AND employee_id != '107';

-- Kawtar: aus employees-Tabelle
UPDATE public.actual_hours
SET employee_id = '107'
WHERE employee_id IN (
  SELECT id FROM public.employees
  WHERE name ILIKE '%kawtar%'
    AND id LIKE 'aush_%'
    AND id NOT LIKE 'b-%'
)
AND employee_id != '107';

-- Party: bekannte aush_-ID → 'party'
UPDATE public.actual_hours
SET employee_id = 'party'
WHERE employee_id = 'aush_1778236182278';

-- Party: alle weiteren via schedule_extra_cost_people
UPDATE public.actual_hours
SET employee_id = 'party'
WHERE employee_id IN (
  SELECT id FROM public.schedule_extra_cost_people
  WHERE name ILIKE '%party%'
    AND tenant_id = 'oliv'
    AND id NOT LIKE 'b-%'
)
AND employee_id != 'party';

-- Party: aus employees-Tabelle
UPDATE public.actual_hours
SET employee_id = 'party'
WHERE employee_id IN (
  SELECT id FROM public.employees
  WHERE name ILIKE '%party%'
    AND id LIKE 'aush_%'
    AND id NOT LIKE 'b-%'
)
AND employee_id != 'party';

-- ── Schritt 5: schedule_extra_cost_people archivieren (Oliv) ─────────────────
UPDATE public.schedule_extra_cost_people
SET
  is_active   = false,
  archived_at = COALESCE(archived_at, now())
WHERE (name ILIKE '%kawtar%' OR name ILIKE '%party%')
  AND tenant_id = 'oliv';

-- ── Schritt 6: Alte aush_*-Einträge in employees archivieren (NUR OLIV) ──────
-- Sicherheit: id LIKE 'aush_%' schliesst b-aush_* NICHT aus — daher extra NOT LIKE Guard
UPDATE public.employees
SET
  is_active   = false,
  archived_at = COALESCE(archived_at, now())
WHERE id LIKE 'aush_%'
  AND id NOT LIKE 'b-%'
  AND (name ILIKE '%kawtar%' OR name ILIKE '%party%');

-- ── Schritt 7: Validierung + Migrationsbericht ───────────────────────────────
DO $$
DECLARE
  -- Kawtar
  kawtar_id_found     TEXT;
  kawtar_dept         TEXT;
  kawtar_wage         NUMERIC;
  kawtar_sch_count    INT;
  kawtar_act_count    INT;
  kawtar_extra_arch   INT;

  -- Party
  party_id_found      TEXT;
  party_dept          TEXT;
  party_wage          NUMERIC;
  party_sch_count     INT;
  party_act_count     INT;
  party_extra_arch    INT;

  -- Verbleibende alte aush_* Einträge
  old_sch_kawtar      INT;
  old_sch_party       INT;
  old_act_kawtar      INT;
  old_act_party       INT;
BEGIN
  -- Kawtar: via LIMIT 1 (kein GROUP BY nötig)
  SELECT id, department, hourly_wage
    INTO kawtar_id_found, kawtar_dept, kawtar_wage
    FROM public.employees
   WHERE name ILIKE '%kawtar%'
     AND is_active = true
   ORDER BY id
   LIMIT 1;

  -- Party: via LIMIT 1
  SELECT id, department, hourly_wage
    INTO party_id_found, party_dept, party_wage
    FROM public.employees
   WHERE id = 'party'
     AND is_active = true
   LIMIT 1;

  -- Zählungen nach Migration
  SELECT COUNT(*) INTO kawtar_sch_count FROM public.schedule_entries WHERE employee_id = kawtar_id_found;
  SELECT COUNT(*) INTO party_sch_count  FROM public.schedule_entries WHERE employee_id = 'party';
  SELECT COUNT(*) INTO kawtar_act_count FROM public.actual_hours    WHERE employee_id = kawtar_id_found;
  SELECT COUNT(*) INTO party_act_count  FROM public.actual_hours    WHERE employee_id = 'party';

  SELECT COUNT(*) INTO kawtar_extra_arch
    FROM public.schedule_extra_cost_people
   WHERE name ILIKE '%kawtar%' AND is_active = false;

  SELECT COUNT(*) INTO party_extra_arch
    FROM public.schedule_extra_cost_people
   WHERE name ILIKE '%party%' AND is_active = false;

  -- Verbleibende alte aush_*-IDs in schedule_entries (sollten 0 sein)
  SELECT COUNT(*) INTO old_sch_kawtar
    FROM public.schedule_entries
   WHERE employee_id LIKE 'aush_%'
     AND employee_id NOT LIKE 'b-%'
     AND employee_id IN (
       SELECT id FROM public.employees WHERE name ILIKE '%kawtar%'
       UNION SELECT id FROM public.schedule_extra_cost_people WHERE name ILIKE '%kawtar%'
     );

  SELECT COUNT(*) INTO old_sch_party
    FROM public.schedule_entries
   WHERE employee_id LIKE 'aush_%'
     AND employee_id NOT LIKE 'b-%'
     AND employee_id IN (
       SELECT id FROM public.employees WHERE name ILIKE '%party%'
       UNION SELECT id FROM public.schedule_extra_cost_people WHERE name ILIKE '%party%'
     );

  -- Verbleibende alte aush_*-IDs in actual_hours (sollten 0 sein)
  SELECT COUNT(*) INTO old_act_kawtar
    FROM public.actual_hours
   WHERE employee_id LIKE 'aush_%'
     AND employee_id NOT LIKE 'b-%'
     AND employee_id IN (
       SELECT id FROM public.employees WHERE name ILIKE '%kawtar%'
       UNION SELECT id FROM public.schedule_extra_cost_people WHERE name ILIKE '%kawtar%'
     );

  SELECT COUNT(*) INTO old_act_party
    FROM public.actual_hours
   WHERE employee_id LIKE 'aush_%'
     AND employee_id NOT LIKE 'b-%'
     AND employee_id IN (
       SELECT id FROM public.employees WHERE name ILIKE '%party%'
       UNION SELECT id FROM public.schedule_extra_cost_people WHERE name ILIKE '%party%'
     );

  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════';
  RAISE NOTICE '  KAWTAR / PARTY → NORMALE MITARBEITER — ERGEBNIS';
  RAISE NOTICE '═══════════════════════════════════════════════════════';
  RAISE NOTICE '';
  RAISE NOTICE '  Kawtar:';
  RAISE NOTICE '    Ziel-ID (aktiv):       %  (soll: 107)', COALESCE(kawtar_id_found, 'NICHT GEFUNDEN!');
  RAISE NOTICE '    Abteilung:             %  (soll: service)', COALESCE(kawtar_dept, '-');
  RAISE NOTICE '    Stundenlohn:           % CHF', COALESCE(kawtar_wage::TEXT, '-');
  RAISE NOTICE '    schedule_entries:      % auf Ziel-ID migriert', kawtar_sch_count;
  RAISE NOTICE '    actual_hours:          % auf Ziel-ID migriert', kawtar_act_count;
  RAISE NOTICE '    extra_cost archiviert: %', kawtar_extra_arch;
  RAISE NOTICE '    alte aush_* in sched.: % (soll: 0)', old_sch_kawtar;
  RAISE NOTICE '    alte aush_* in actual: % (soll: 0)', old_act_kawtar;
  RAISE NOTICE '';
  RAISE NOTICE '  Party:';
  RAISE NOTICE '    Ziel-ID (aktiv):       %  (soll: party)', COALESCE(party_id_found, 'NICHT GEFUNDEN!');
  RAISE NOTICE '    Abteilung:             %  (soll: kueche)', COALESCE(party_dept, '-');
  RAISE NOTICE '    Stundenlohn:           % CHF  (soll: 25.00)', COALESCE(party_wage::TEXT, '-');
  RAISE NOTICE '    schedule_entries:      % auf Ziel-ID migriert', party_sch_count;
  RAISE NOTICE '    actual_hours:          % auf Ziel-ID migriert', party_act_count;
  RAISE NOTICE '    extra_cost archiviert: %', party_extra_arch;
  RAISE NOTICE '    alte aush_* in sched.: % (soll: 0)', old_sch_party;
  RAISE NOTICE '    alte aush_* in actual: % (soll: 0)', old_act_party;
  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════';

  IF kawtar_id_found IS NULL THEN
    RAISE WARNING 'FEHLER: Kein aktiver Kawtar-Eintrag in employees gefunden!';
  END IF;
  IF party_id_found IS NULL THEN
    RAISE WARNING 'FEHLER: Party nicht in employees angelegt!';
  END IF;
  IF old_sch_kawtar > 0 THEN
    RAISE WARNING 'WARNUNG: % alte aush_*-Einträge für Kawtar noch in schedule_entries!', old_sch_kawtar;
  END IF;
  IF old_sch_party > 0 THEN
    RAISE WARNING 'WARNUNG: % alte aush_*-Einträge für Party noch in schedule_entries!', old_sch_party;
  END IF;
  IF old_act_kawtar > 0 THEN
    RAISE WARNING 'WARNUNG: % alte aush_*-Einträge für Kawtar noch in actual_hours!', old_act_kawtar;
  END IF;
  IF old_act_party > 0 THEN
    RAISE WARNING 'WARNUNG: % alte aush_*-Einträge für Party noch in actual_hours!', old_act_party;
  END IF;
END $$;

COMMIT;
