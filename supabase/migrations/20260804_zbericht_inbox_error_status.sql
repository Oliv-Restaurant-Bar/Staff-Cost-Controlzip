-- ============================================================
-- zbericht_inbox: Status «error» + Fehlergrund für den Auto-Import
-- Datum: 2026-08-04
-- MANUELL bzw. per Management-API ausführen (DDL läuft nicht automatisch).
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================
--
-- ZWECK
--   Der Browser-Auto-Import (GastronoviZBerichtPage) verarbeitet alle
--   pending-PDFs automatisch. Schlägt EIN PDF fehl (kein Textlayer, kein
--   Tagesimport, Zeitraum-Überschneidung, Parse-Fehler), wird NUR dieses
--   auf status 'error' gesetzt (mit Grund in error_message) — der Rest
--   läuft weiter. 'error'-Zeilen werden NIE automatisch erneut versucht,
--   sondern manuell geprüft (Importieren/Ignorieren).

ALTER TABLE zbericht_inbox
  ADD COLUMN IF NOT EXISTS error_message text NULL;

ALTER TABLE zbericht_inbox
  DROP CONSTRAINT IF EXISTS zbericht_inbox_status_check;

ALTER TABLE zbericht_inbox
  ADD CONSTRAINT zbericht_inbox_status_check
  CHECK (status IN ('pending', 'imported', 'ignored', 'error'));
