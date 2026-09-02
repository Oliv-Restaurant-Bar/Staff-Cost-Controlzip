-- =============================================================
-- BENUTZERROLLEN – Einmalig im Supabase SQL-Editor ausführen
-- =============================================================
-- Dieses Skript erstellt die Rollen-Tabelle und weist dem Admin
-- sofort die Admin-Rolle zu.
-- =============================================================

-- 1. Tabelle erstellen
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id      UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL DEFAULT 'admin'
            CHECK (role IN ('admin', 'service_manager', 'kueche_manager',
                            'beaulieu_manager', 'beaulieu_viewer')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 2. Zugriff gewähren
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_profiles TO authenticated;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Jeder eingeloggte User darf sein eigenes Profil lesen
CREATE POLICY "User can read own profile"
  ON public.user_profiles FOR SELECT
  USING (auth.uid() = id);

-- Nur admins dürfen Profile anlegen/ändern (Kontrolle erfolgt im App-Layer)
CREATE POLICY "Authenticated can manage profiles"
  ON public.user_profiles FOR ALL
  USING (auth.role() = 'authenticated');

-- 3. Admin-Profil automatisch anlegen (für den aktuell eingeloggten User)
--    Führen Sie diesen Block ALS ADMIN-USER eingeloggt aus:
INSERT INTO public.user_profiles (id, role)
SELECT id, 'admin'
FROM auth.users
WHERE email = 'admin@olivbern.ch'
ON CONFLICT (id) DO UPDATE SET role = 'admin';

-- =============================================================
-- So erstellen Sie einen neuen Manager-Account:
--
-- 1. In Supabase → Authentication → Users → "Add User"
--    Beispiel: service@olivbern.ch  /  [Passwort wählen]
--              kueche@olivbern.ch   /  [Passwort wählen]
--
-- 2. Nach Erstellung den folgenden SQL ausführen:
--
-- INSERT INTO public.user_profiles (id, role)
-- SELECT id, 'service_manager'
-- FROM auth.users WHERE email = 'service@olivbern.ch'
-- ON CONFLICT (id) DO UPDATE SET role = 'service_manager';
--
-- INSERT INTO public.user_profiles (id, role)
-- SELECT id, 'kueche_manager'
-- FROM auth.users WHERE email = 'kueche@olivbern.ch'
-- ON CONFLICT (id) DO UPDATE SET role = 'kueche_manager';
-- =============================================================
