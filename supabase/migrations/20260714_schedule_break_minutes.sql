-- Manuelle Pausen im Dienstplan (Schnellauswahl: Keine/30/60 Min)
-- break_minutes: manuelle Pause in Minuten pro Tag (0 = explizit keine Pause,
-- 30, 60). NULL = keine manuelle Angabe → automatische Pausenregel gilt
-- (>9h Brutto → 30 Min Abzug). Reduziert nur die Arbeitszeit, nie Start/Ende.
--
-- MANUELL im Supabase SQL-Editor ausführen (DDL läuft nicht automatisch).

ALTER TABLE schedule_entries
  ADD COLUMN IF NOT EXISTS break_minutes integer;

COMMENT ON COLUMN schedule_entries.break_minutes IS
  'Manuelle Pause in Minuten (0/30/60); NULL = automatische Pausenregel (>9h → 30 Min)';
