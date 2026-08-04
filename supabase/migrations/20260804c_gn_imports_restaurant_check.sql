-- gn_imports: restaurant_id auf bekannte Mandanten einschränken.
-- (Der partielle UNIQUE-Index gn_imports_tenant_checksum_active_uniq aus
-- 20260804b existiert bereits live — verifiziert via Management API.)
-- HINWEIS: Diese Migration wurde am 2026-08 bereits manuell via Management API
-- ausgeführt; Datei dient als Repo-Nachweis.

ALTER TABLE gn_imports
  ADD CONSTRAINT gn_imports_restaurant_id_check
  CHECK (restaurant_id IN ('oliv', 'beaulieu'));
