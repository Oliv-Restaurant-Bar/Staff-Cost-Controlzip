-- Personaleintritt — Erweiterungen v2 (10-Punkte-Auftrag, Punkte 1 + 4)
-- =====================================================================
-- MANUELL im Supabase SQL-Editor ausführen (DDL läuft nie automatisch).
-- Voraussetzung: 20260724_personaleintritt.sql + 20260724b wurden ausgeführt.
-- Idempotent: kann mehrfach ausgeführt werden.

-- ── Punkt 1: Mindestlohn-Korrektur ───────────────────────────────────────────
-- Der Basis-Stundenlohn rechnet sich ×12: Monatslohn × 12 / (52 × Wochenstunden).
-- Die OFFIZIELLEN L-GAV-Stundenwerte je Wochenmodell (42 / 43.5 / 45 h) weichen
-- teilweise von der reinen Formel ab (z. B. 43.5 h) — deshalb werden sie EXPLIZIT
-- als Tabellenwerte geführt und NIE berechnet (autoritative Quelle, kein
-- Formel-Fallback; fehlende Spaltenwerte ⇒ keine Mindestlohn-Prüfung möglich).
ALTER TABLE public.lgav_mindestlohn
  ADD COLUMN IF NOT EXISTS stunde_42   numeric,   -- CHF/Std. bei 42-h-Woche (beide Betriebe)
  ADD COLUMN IF NOT EXISTS stunde_43_5 numeric,   -- CHF/Std. bei 43.5-h-Woche
  ADD COLUMN IF NOT EXISTS stunde_45   numeric;   -- CHF/Std. bei 45-h-Woche

-- Seed 2026: offizielle L-GAV-Werte (Monat inkl. 13. + Stundenwerte je Modell).
INSERT INTO public.lgav_mindestlohn (jahr, klasse, monat_x13, stunde_42, stunde_43_5, stunde_45) VALUES
  (2026, 'Ia',   3713, 20.40, 19.65, 19.04),
  (2026, 'Ib',   3943, 21.66, 20.86, 20.22),
  (2026, 'II',   4070, 22.36, 21.53, 20.87),
  (2026, 'IIIa', 4528, 24.88, 23.96, 23.22),
  (2026, 'IIIb', 4635, 25.47, 24.52, 23.77),
  (2026, 'IV',   5293, 29.08, 28.01, 27.14)
ON CONFLICT (jahr, klasse) DO UPDATE SET
  monat_x13   = EXCLUDED.monat_x13,
  stunde_42   = EXCLUDED.stunde_42,
  stunde_43_5 = EXCLUDED.stunde_43_5,
  stunde_45   = EXCLUDED.stunde_45;

-- ── Punkt 4: Arbeitsbewilligung als Mehrfachauswahl ──────────────────────────
-- Statt der Ja/Nein-Frage (bewilligung_erforderlich, 20260724b) drei ankreuzbare
-- Optionen. Die Alt-Spalte bleibt als Legacy-Input bestehen (Alt-Datensätze) und
-- wird in der Logik weiterhin ODER-verknüpft — NICHT droppen.
-- F/S steuern die SEM-Meldung; alle drei den Gültigkeits-Zusatz im Vertrag.
ALTER TABLE public.personaleintritt
  ADD COLUMN IF NOT EXISTS bewilligung_ausweis_f boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bewilligung_ausweis_s boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bewilligung_arbeitsbewilligung boolean NOT NULL DEFAULT false;

-- Alt-Datensätze mit pauschalem «Ja» auf die neue Option «Arbeitsbewilligung»
-- übertragen (konservativ: welcher Ausweis, ist unbekannt — kein F/S raten).
UPDATE public.personaleintritt
   SET bewilligung_arbeitsbewilligung = true
 WHERE bewilligung_erforderlich = true
   AND bewilligung_ausweis_f = false
   AND bewilligung_ausweis_s = false
   AND bewilligung_arbeitsbewilligung = false;
