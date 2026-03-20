-- =============================================================
-- FIX: Rolle kann nicht gelesen werden (RLS blockiert Abfrage)
-- =============================================================
-- Dieses Skript im Supabase SQL-Editor ausführen.
-- Es ist idempotent – kann beliebig oft ausgeführt werden.
-- =============================================================

-- 1. Alle alten Policies auf user_profiles entfernen und neu setzen
--    (robust, explizit für 'authenticated', mit WITH CHECK)

DROP POLICY IF EXISTS "User can read own profile"          ON public.user_profiles;
DROP POLICY IF EXISTS "Authenticated can manage profiles"  ON public.user_profiles;
DROP POLICY IF EXISTS "user_profiles_select"               ON public.user_profiles;
DROP POLICY IF EXISTS "user_profiles_insert"               ON public.user_profiles;
DROP POLICY IF EXISTS "user_profiles_update"               ON public.user_profiles;
DROP POLICY IF EXISTS "user_profiles_delete"               ON public.user_profiles;

-- Saubere Policies: jede Operation einzeln, explizit für 'authenticated'
CREATE POLICY "user_profiles_select"
  ON public.user_profiles FOR SELECT
  TO authenticated
  USING (true);                        -- alle eingeloggten User dürfen lesen

CREATE POLICY "user_profiles_insert"
  ON public.user_profiles FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "user_profiles_update"
  ON public.user_profiles FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "user_profiles_delete"
  ON public.user_profiles FOR DELETE
  TO authenticated
  USING (true);

-- 2. GRANT sicherstellen
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_profiles TO authenticated;

-- 3. SECURITY DEFINER Funktion: liest Rolle direkt, umgeht RLS komplett
--    Der App-Frontend ruft diese Funktion per supabase.rpc('get_my_role') auf.
--    Läuft als DB-Owner → sieht immer die Zeile, egal welche RLS-Policies aktiv sind.

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM   public.user_profiles
  WHERE  id = auth.uid()
  LIMIT  1;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated, anon;

-- =============================================================
-- PRÜFEN (nach Ausführung im SQL-Editor):
--
-- SELECT * FROM public.user_profiles;               -- alle Zeilen
-- SELECT get_my_role();                             -- eigene Rolle (als Admin ausführen)
--
-- Policies prüfen:
-- SELECT schemaname, tablename, policyname, roles, cmd, qual
-- FROM   pg_policies
-- WHERE  tablename = 'user_profiles';
-- =============================================================
