-- ============================================================
-- Migration: Mandantenfähigkeit (Multi-Tenant)
-- Datum: 2026-04-20
-- Zweck: restaurant_id-Spalte zu employees hinzufügen
--
-- ANLEITUNG:
-- 1. Supabase-Dashboard öffnen > SQL Editor
-- 2. Dieses Skript einfügen und ausführen
-- 3. Alle bestehenden Oliv-Mitarbeiter werden automatisch
--    auf restaurant_id = 'oliv' gesetzt
--
-- SICHERHEIT:
-- - Bestehende Daten bleiben vollständig erhalten
-- - Die Spalte hat DEFAULT 'oliv' → keine bestehende Zeile wird gelöscht
-- - schedule_entries und actual_hours benötigen KEINE Änderung,
--   da sie über employee_id implizit mandantengetrennt sind
-- ============================================================

-- Schritt 1: Spalte hinzufügen (IF NOT EXISTS = sicher bei Mehrfachausführung)
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS restaurant_id TEXT NOT NULL DEFAULT 'oliv';

-- Schritt 2: Bestehende Zeilen ohne restaurant_id auf 'oliv' setzen
UPDATE employees
  SET restaurant_id = 'oliv'
  WHERE restaurant_id IS NULL OR restaurant_id = '';

-- Schritt 3: Index für Performance bei Mandanten-Filterung
CREATE INDEX IF NOT EXISTS idx_employees_restaurant_id
  ON employees (restaurant_id);

-- Schritt 4: KV-Store — keine Schemaänderung nötig
-- Die App nutzt Schlüssel-Präfixe ("beaulieu:dailyBudgets" usw.)
-- Die app_settings-Tabelle bleibt unverändert.

-- Fertig. Bestätigung ausgeben:
SELECT
  restaurant_id,
  COUNT(*) AS mitarbeiter_anzahl
FROM employees
GROUP BY restaurant_id
ORDER BY restaurant_id;
