-- ============================================================
-- gn_imports: Backstop gegen doppelte VOLL-Tagesberichte
-- Datum: 2026-08-08
-- MANUELL bzw. per Management-API ausführen (DDL läuft nicht automatisch).
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================
--
-- ZWECK
--   Zwei VERSCHIEDENE PDFs desselben Geschäftstags (Standard + erweitert /
--   Korrektur) aus zwei Tabs passieren beide den Overlap-Check, bevor einer
--   schreibt → beide wären aktiv, der Tagesumsatz zählte doppelt. Die
--   Checksummen-Unique (20260804b) greift nur bei IDENTISCHEM Inhalt.
--
--   Pro Mandant + Tag darf nur EIN Voll-Tagesbericht (ohne Kostenstelle)
--   aktiv sein. Mehrere Kostenstellen-Importe desselben Tags bleiben erlaubt
--   (cost_center gesetzt), ebenso Perioden-Importe (period_from <> period_to).
--
--   Der App-Code (saveGnImport) legt Importe neu mit status='pending' an und
--   aktiviert sie erst am Schluss — der Index wirkt dort als atomarer
--   Aktivierungs-CAS: der zweite konkurrierende Voll-Tagesbericht scheitert
--   hart und wird als «Prüfung nötig» gemeldet, nie zusätzlich aktiv.
--
--   Schlägt die Index-Erstellung wegen Alt-Duplikaten fehl, zuerst die
--   doppelt-aktiven Tage bereinigen (ältere auf status='replaced').

CREATE UNIQUE INDEX IF NOT EXISTS gn_imports_tenant_fullday_active_uniq
  ON gn_imports (restaurant_id, period_from)
  WHERE status = 'active'
    AND period_from IS NOT NULL
    AND period_from = period_to
    AND (cost_center IS NULL OR btrim(cost_center) = '');
