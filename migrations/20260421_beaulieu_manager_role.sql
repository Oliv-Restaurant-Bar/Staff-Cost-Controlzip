-- =============================================================
-- BEAULIEU MANAGER ROLE – Neue Rolle beaulieu_manager
-- =============================================================
-- Dieses Skript im Supabase SQL-Editor ausführen (einmalig).
-- Erweitert die user_profiles-Tabelle um die neue Rolle.
-- =============================================================

-- 1. CHECK-Constraint erweitern um beaulieu_manager
ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_role_check;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_role_check
  CHECK (role IN ('admin', 'service_manager', 'kueche_manager', 'beaulieu_manager'));

-- 2. Beaulieu-Geschäftsführer anlegen
--    Schritt 1: Supabase Dashboard → Authentication → Users → Add user
--               E-Mail + Passwort eingeben (z.B. gf@beaulieu-thalwil.ch)
--    Schritt 2: Dieses Skript ausführen:

-- SELECT set_user_role('gf@beaulieu-thalwil.ch', 'beaulieu_manager');
-- (Kommentar entfernen und echte E-Mail eintragen)

-- 3. Was dieser User erhält:
--    • Rolle: beaulieu_manager
--    • Tenant-Lock: immer Beaulieu, kein Wechsel zu Oliv
--    • Erlaubte Module: Dienstplanung, Personal FIX, Tagesansicht, Tages-Controlling
--    • Kein: Dashboard, Reporting, Budget, Import, Personalstamm, Einstellungen
--    • Kein Tenant-Switcher sichtbar
