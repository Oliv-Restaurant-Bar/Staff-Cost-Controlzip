-- ─────────────────────────────────────────────────────────────────────────────
-- SICHERHEITS-FIX: user_profiles — Selbst-Eskalation der Rolle unterbinden
--
-- Befund (Architect-Review 16.07.2026): Ein authentifizierter Benutzer kann
-- aktuell per Upsert auf user_profiles seine EIGENE role auf 'admin' setzen
-- (nur mit Anon-Key + eigener Session live verifiziert). Damit ist jedes
-- Rollen-Gate der App aushebelbar.
--
-- Prinzip: Benutzer dürfen ihr eigenes Profil anlegen/aktualisieren
-- (id + email), aber die role NUR dann setzen/ändern, wenn sie bereits
-- admin sind. Neue Profile erhalten role-Werte nur als Nicht-Admin-Default.
--
-- WICHTIG: Manuell im Supabase SQL-Editor ausführen (DDL läuft nicht
-- automatisch). Danach empirisch verifizieren (siehe Prüfblock unten).
-- ─────────────────────────────────────────────────────────────────────────────

-- Hilfsfunktion: aktuelle Rolle des eingeloggten Users (SECURITY DEFINER,
-- damit die Policy-Prüfung nicht selbst an RLS scheitert).
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.user_profiles WHERE id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.current_user_role() FROM anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated;

-- Trigger statt Spalten-RLS (RLS kann einzelne Spalten nicht schützen):
-- role-Änderungen sind nur erlaubt, wenn der ausführende User admin ist.
CREATE OR REPLACE FUNCTION public.protect_user_profile_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_role text;
BEGIN
  -- service_role / Migrationen (kein auth.uid()) bleiben unangetastet
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  actor_role := (SELECT role FROM public.user_profiles WHERE id = auth.uid());

  IF TG_OP = 'INSERT' THEN
    -- Neue Profile: role darf nur ein harmloser Default sein, ausser Admin legt an
    IF actor_role IS DISTINCT FROM 'admin'
       AND NEW.role IS DISTINCT FROM 'kueche_manager' THEN
      NEW.role := 'kueche_manager';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: role-Änderung nur durch Admins
  IF NEW.role IS DISTINCT FROM OLD.role
     AND actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Rollenänderung nur durch Administratoren';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_user_profile_role ON public.user_profiles;
CREATE TRIGGER trg_protect_user_profile_role
  BEFORE INSERT OR UPDATE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_user_profile_role();

-- ─────────────────────────────────────────────────────────────────────────────
-- PRÜFBLOCK (nach dem Einspielen als Nicht-Admin-Testuser ausführen):
--   1. UPDATE der eigenen role auf 'admin'  → muss mit Exception scheitern.
--   2. Upsert {id, email} OHNE role         → muss weiterhin funktionieren.
--   3. Admin ändert fremde role             → muss funktionieren.
-- Hinweis: Der bestehende Self-Upsert im AuthContext sendet die role mit —
-- falls Schritt 2 scheitert, AuthContext-Upsert auf {id, email} reduzieren.
-- ─────────────────────────────────────────────────────────────────────────────
