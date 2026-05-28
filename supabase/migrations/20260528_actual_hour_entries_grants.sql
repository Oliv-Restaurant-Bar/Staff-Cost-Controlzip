-- ─── Schnell-Fix: GRANTs für actual_hour_entries ─────────────────────────────
-- Dieses Script nur ausführen wenn die Tabelle bereits existiert
-- (d.h. 20260528_actual_hour_entries.sql wurde schon ausgeführt),
-- aber der Fehler "permission denied for table actual_hour_entries" auftritt.
--
-- Ursache: RLS-Policy allein reicht nicht — explizite GRANTs fehlen.

GRANT ALL ON TABLE actual_hour_entries TO authenticated;
GRANT ALL ON TABLE actual_hour_entries TO service_role;
GRANT SELECT ON TABLE actual_hour_entries TO anon;
