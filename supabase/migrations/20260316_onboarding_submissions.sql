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

-- Explizite Zugriffsrechte (zusätzlich zu RLS-Policies notwendig)
GRANT SELECT, INSERT, DELETE ON TABLE public.onboarding_submissions TO authenticated;
GRANT INSERT ON TABLE public.onboarding_submissions TO anon;

-- RLS aktivieren
ALTER TABLE public.onboarding_submissions ENABLE ROW LEVEL SECURITY;

-- Jeder (auch anonym) darf neue Einträge erstellen
DROP POLICY IF EXISTS "anon_insert" ON public.onboarding_submissions;
CREATE POLICY "anon_insert"
  ON public.onboarding_submissions FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Nur eingeloggte Benutzer dürfen Einträge lesen
DROP POLICY IF EXISTS "auth_select" ON public.onboarding_submissions;
CREATE POLICY "auth_select"
  ON public.onboarding_submissions FOR SELECT
  TO authenticated
  USING (true);

-- Nur eingeloggte Benutzer dürfen Einträge löschen (Aktivieren / Ablehnen)
DROP POLICY IF EXISTS "auth_delete" ON public.onboarding_submissions;
CREATE POLICY "auth_delete"
  ON public.onboarding_submissions FOR DELETE
  TO authenticated
  USING (true);

COMMENT ON TABLE public.onboarding_submissions IS
  'Eingehende Selbst-Anmeldungen neuer Mitarbeiter über /onboarding/new. Admin prüft und aktiviert.';
