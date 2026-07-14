-- ═══════════════════════════════════════════════════════════════════════════
-- Onboarding-Flow Erweiterung
-- Datum: 2026-03-15
-- Zweck: Onboarding-Link, Dokumenten-Upload, in_progress Status
-- HINWEIS: Dieses Skript NACH 20260315_hr_fields_extension.sql ausführen
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. onboarding_status Constraint aktualisieren: 'in_progress' hinzufügen
--    (das bestehende Constraint aus Migration 1 wird ersetzt)
ALTER TABLE public.employees
  DROP CONSTRAINT IF EXISTS employees_onboarding_status_check;

ALTER TABLE public.employees
  ADD CONSTRAINT employees_onboarding_status_check
  CHECK (onboarding_status IN ('none', 'prepared', 'sent', 'in_progress', 'completed'));

COMMENT ON COLUMN public.employees.onboarding_status IS
  'Status-Fluss: none → prepared → sent → in_progress → completed';

-- 2. Dokument-Metadaten speichern (JSON-Array mit Datei-Infos)
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS onboarding_documents TEXT;

COMMENT ON COLUMN public.employees.onboarding_documents IS
  'JSON-Array: [{type, name, path, url, uploadedAt}] — Hochgeladene Onboarding-Dokumente';

-- 3. Storage Bucket für Onboarding-Dokumente anlegen
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'onboarding-docs',
  'onboarding-docs',
  false,
  10485760,
  ARRAY['image/jpeg','image/png','image/webp','application/pdf','image/heic']
)
ON CONFLICT (id) DO NOTHING;

-- 4. RLS-Policies für Storage (Test-Phase: anon darf hochladen)
--    DROP zuerst damit das Skript idempotent ist
DROP POLICY IF EXISTS "Anon upload onboarding docs" ON storage.objects;
CREATE POLICY "Anon upload onboarding docs"
  ON storage.objects FOR INSERT
  TO anon
  WITH CHECK (bucket_id = 'onboarding-docs');

DROP POLICY IF EXISTS "Anon read own onboarding docs" ON storage.objects;
CREATE POLICY "Anon read own onboarding docs"
  ON storage.objects FOR SELECT
  TO anon
  USING (bucket_id = 'onboarding-docs');

-- 5. employees-Tabelle: anon darf via Token lesen + Onboarding-Felder schreiben
--    Nur relevant wenn RLS auf der employees-Tabelle aktiviert ist.
--    Wenn RLS nicht aktiviert ist, sind diese Policies wirkungslos aber harmlos.

DROP POLICY IF EXISTS "Anon read employee by token" ON public.employees;
CREATE POLICY "Anon read employee by token"
  ON public.employees FOR SELECT
  TO anon
  USING (onboarding_token IS NOT NULL);

DROP POLICY IF EXISTS "Anon update employee by token (onboarding)" ON public.employees;
CREATE POLICY "Anon update employee by token (onboarding)"
  ON public.employees FOR UPDATE
  TO anon
  USING (onboarding_token IS NOT NULL AND onboarding_status IN ('prepared', 'sent', 'in_progress'))
  WITH CHECK (onboarding_status IN ('in_progress', 'completed'));
