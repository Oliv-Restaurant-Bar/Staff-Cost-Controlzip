-- ═══════════════════════════════════════════════════════════════════════════
-- Onboarding Submissions Tabelle
-- Datum: 2026-03-16
-- Zweck: Separate, standalone Tabelle für neue Mitarbeiter-Selbstanmeldungen.
--        Unabhängig von employees-Tabelle, eigene offene RLS für anon INSERT.
--        Admin prüft Einträge und legt daraus echte Mitarbeiterdatensätze an.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.onboarding_submissions (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  name         TEXT         NOT NULL,
  form_data    JSONB        NOT NULL DEFAULT '{}'::jsonb
);

-- RLS aktivieren
ALTER TABLE public.onboarding_submissions ENABLE ROW LEVEL SECURITY;

-- Jeder (auch anonym) darf neue Einträge erstellen
DROP POLICY IF EXISTS "Anon und Auth dürfen Einträge erstellen" ON public.onboarding_submissions;
CREATE POLICY "Anon und Auth dürfen Einträge erstellen"
  ON public.onboarding_submissions FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Nur eingeloggte Benutzer dürfen Einträge lesen
DROP POLICY IF EXISTS "Auth darf lesen" ON public.onboarding_submissions;
CREATE POLICY "Auth darf lesen"
  ON public.onboarding_submissions FOR SELECT
  TO authenticated
  USING (true);

-- Nur eingeloggte Benutzer dürfen Einträge löschen (Aktivieren / Ablehnen)
DROP POLICY IF EXISTS "Auth darf löschen" ON public.onboarding_submissions;
CREATE POLICY "Auth darf löschen"
  ON public.onboarding_submissions FOR DELETE
  TO authenticated
  USING (true);

COMMENT ON TABLE public.onboarding_submissions IS
  'Eingehende Selbst-Anmeldungen neuer Mitarbeiter über /onboarding/new. Admin prüft und aktiviert.';
