-- ============================================================
-- zbericht_inbox: atomarer Claim für den Auto-Import + Checksummen-Backstop
-- Datum: 2026-08-04
-- MANUELL bzw. per Management-API ausführen (DDL läuft nicht automatisch).
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================
--
-- ZWECK
--   Zwei offene Tabs dürfen dasselbe pending-PDF nie beide speichern.
--   1) Claim: UPDATE status 'pending' → 'processing' (+ claimed_at); nur wer
--      die Zeile wirklich umstellt (rows affected = 1), verarbeitet sie.
--      Verwaiste Claims (Tab geschlossen) sind nach 10 Min. wieder claimbar.
--   2) Backstop: pro Mandant darf dieselbe Checksumme nur EINMAL aktiv in
--      gn_imports existieren — selbst wenn zwei Läufe den Checksummen-Check
--      gleichzeitig passieren, scheitert der zweite Insert hart.

ALTER TABLE zbericht_inbox
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz NULL;

ALTER TABLE zbericht_inbox
  DROP CONSTRAINT IF EXISTS zbericht_inbox_status_check;

ALTER TABLE zbericht_inbox
  ADD CONSTRAINT zbericht_inbox_status_check
  CHECK (status IN ('pending', 'processing', 'imported', 'ignored', 'error'));

-- Backstop: aktive Checksummen-Duplikate pro Mandant hart verhindern.
-- (Partiell: nur status 'active' + checksum vorhanden — Ersetzen/Soft-Delete
--  bleibt möglich.) Schlägt die Index-Erstellung wegen Alt-Duplikaten fehl,
--  zuerst Duplikate bereinigen.
CREATE UNIQUE INDEX IF NOT EXISTS gn_imports_tenant_checksum_active_uniq
  ON gn_imports (restaurant_id, checksum)
  WHERE status = 'active' AND checksum IS NOT NULL;
