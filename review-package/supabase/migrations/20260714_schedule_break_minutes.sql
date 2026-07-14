-- Manuelle Pausen im Dienstplan — PRO EINSATZ (Schnellauswahl: Keine/30/60 Min)
-- frueh_break_minutes / spaet_break_minutes: manuelle Pause in Minuten je Einsatz
-- (0 = explizit keine Pause, 30, 60). NULL = keine manuelle Angabe.
-- Sind BEIDE NULL, gilt die automatische Tagesregel (>9h Brutto → 30 Min Abzug).
-- Pausen reduzieren nur die Arbeitszeit, nie Start/Ende.
--
-- Zusätzlich: actual_hours.source markiert die Herkunft eines Ist-Eintrags
-- ('plan_sync' = automatisch aus Plan-Absenz übernommen, 'manual', 'import').
--
-- MANUELL im Supabase SQL-Editor ausführen (DDL läuft nicht automatisch).

ALTER TABLE schedule_entries
  ADD COLUMN IF NOT EXISTS frueh_break_minutes integer;

ALTER TABLE schedule_entries
  ADD COLUMN IF NOT EXISTS spaet_break_minutes integer;

COMMENT ON COLUMN schedule_entries.frueh_break_minutes IS
  'Manuelle Pause 1. Einsatz in Minuten (0/30/60); NULL = keine manuelle Angabe';
COMMENT ON COLUMN schedule_entries.spaet_break_minutes IS
  'Manuelle Pause 2. Einsatz in Minuten (0/30/60); NULL = keine manuelle Angabe';

-- Falls die frühere Tages-Pausen-Spalte (break_minutes) bereits angelegt wurde:
-- Wert als Pause des 1. Einsatzes übernehmen (Tagessumme bleibt identisch),
-- danach Spalte entfernen.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'schedule_entries' AND column_name = 'break_minutes'
  ) THEN
    UPDATE schedule_entries
      SET frueh_break_minutes = break_minutes
      WHERE break_minutes IS NOT NULL AND frueh_break_minutes IS NULL;
    ALTER TABLE schedule_entries DROP COLUMN break_minutes;
  END IF;
END $$;

-- Herkunfts-Markierung für Ist-Einträge (Plan→Ist-Sync idempotent + auditierbar)
ALTER TABLE actual_hours
  ADD COLUMN IF NOT EXISTS source text;

COMMENT ON COLUMN actual_hours.source IS
  'Herkunft des Ist-Eintrags: plan_sync (automatisch aus Plan-Absenz), manual, import; NULL = unbekannt/Bestand';
