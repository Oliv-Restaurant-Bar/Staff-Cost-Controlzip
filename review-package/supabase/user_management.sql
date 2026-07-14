-- =============================================================
-- BENUTZER-VERWALTUNG – Mehrere Admin-Accounts
-- =============================================================
-- Dieses Skript im Supabase SQL-Editor ausführen.
-- Es kann beliebig oft ausgeführt werden (idempotent).
-- =============================================================

-- 1. E-Mail-Spalte ergänzen (falls noch nicht vorhanden)
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS email TEXT;

CREATE INDEX IF NOT EXISTS idx_user_profiles_email
  ON public.user_profiles (email);

-- 2. Bestehende Zeilen mit E-Mail aus auth.users befüllen
UPDATE public.user_profiles p
SET    email = u.email
FROM   auth.users u
WHERE  p.id = u.id
  AND  (p.email IS NULL OR p.email = '');

-- 3. Trigger: Neuen Auth-User automatisch in user_profiles eintragen
--    (Standard-Rolle: kueche_manager — Admin kann danach ändern)
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email, role)
  VALUES (NEW.id, NEW.email, 'kueche_manager')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- 4. Hilfsfunktion: Rolle per E-Mail setzen
--    Verwendung: SELECT set_user_role('name@beispiel.ch', 'admin');
CREATE OR REPLACE FUNCTION public.set_user_role(
  p_email TEXT,
  p_role  TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  SELECT id INTO v_user_id
  FROM   auth.users
  WHERE  lower(email) = lower(p_email)
  LIMIT  1;

  IF v_user_id IS NULL THEN
    RETURN 'FEHLER: ' || p_email || ' nicht in auth.users gefunden.'
        || ' Zuerst in Supabase Auth anlegen.';
  END IF;

  INSERT INTO public.user_profiles (id, email, role)
  VALUES (v_user_id, lower(p_email), p_role)
  ON CONFLICT (id)
  DO UPDATE SET role  = EXCLUDED.role,
                email = EXCLUDED.email;

  RETURN 'OK: ' || p_email || ' → ' || p_role;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_user_role(TEXT, TEXT) TO authenticated;

-- 5. View: Alle Benutzer mit Rollen anzeigen (nur für Admins sichtbar)
CREATE OR REPLACE VIEW public.user_profiles_with_email AS
  SELECT p.id, u.email, p.role, p.created_at
  FROM   public.user_profiles p
  JOIN   auth.users u ON u.id = p.id
  ORDER  BY p.role, u.email;

GRANT SELECT ON public.user_profiles_with_email TO authenticated;

-- =============================================================
-- ANLEITUNG: NEUEN ADMIN ANLEGEN (2 Schritte)
-- =============================================================
--
-- SCHRITT 1 – Supabase Dashboard:
--   Authentication → Users → "Add user" → "Create new user"
--   E-Mail + Passwort eingeben → "Create User"
--   (Der Benutzer erhält automatisch die Rolle kueche_manager)
--
-- SCHRITT 2 – Hier im SQL-Editor:
--   SELECT set_user_role('neuer-admin@olivbern.ch', 'admin');
--
-- ODER: Direkt in der App unter Einstellungen → Benutzer-Verwaltung
--   → Rolle des Benutzers auf "Admin" ändern
--
-- =============================================================
-- ALLE BENUTZER MIT ROLLEN ANZEIGEN:
-- =============================================================
--
--   SELECT * FROM public.user_profiles_with_email;
--
-- =============================================================
-- ROLLE ÄNDERN:
-- =============================================================
--
--   SELECT set_user_role('benutzer@beispiel.ch', 'admin');
--   SELECT set_user_role('benutzer@beispiel.ch', 'service_manager');
--   SELECT set_user_role('benutzer@beispiel.ch', 'kueche_manager');
--
-- =============================================================
