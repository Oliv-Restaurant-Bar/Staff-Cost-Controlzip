-- Personaleintritt — Erweiterungen (Anpassungen 1/2/5)
-- =====================================================
-- MANUELL im Supabase SQL-Editor ausführen (DDL läuft nie automatisch).
-- Voraussetzung: 20260724_personaleintritt.sql wurde bereits ausgeführt.

-- Anpassung 2: Grundlohn-Eingabe «inkl. 13.» (nur ML, Modus grundlohn).
-- Anpassung 5: GF-Kontrollfrage Arbeitsbewilligung + Audit der Behörden-Meldung.
ALTER TABLE public.personaleintritt
  ADD COLUMN IF NOT EXISTS grundlohn_inkl13 boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bewilligung_erforderlich boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS behoerde_meldung_am timestamptz,
  ADD COLUMN IF NOT EXISTS behoerde_meldung_von text;

-- Anpassung 1: Alt-Funktionen «Service»/«Servicemitarbeiterin» → «Serviceangestellte»
-- (zentrale Funktionsliste src/lib/funktionen.ts; betrifft beide Betriebe —
-- employees ist über das ID-Präfix mandantengetrennt, die Umbenennung ist
-- fachlich für beide gewollt).
UPDATE public.employees
   SET position_title = 'Serviceangestellte'
 WHERE position_title IN ('Service', 'Servicemitarbeiterin');
