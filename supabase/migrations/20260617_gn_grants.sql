-- ============================================================
-- Gastronovi: Zugriffsrechte für authenticated + anon Role
-- Ausführen im Supabase SQL-Editor
-- Hintergrund: DISABLE ROW LEVEL SECURITY reicht nicht —
-- PostgREST benötigt zusätzlich explizite GRANT-Berechtigungen.
-- ============================================================

-- Z-Bericht Tabellen (20260617_gn_zbericht.sql)
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_imports           TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_revenue_summary   TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_tax_summary       TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_cost_centers      TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_waiters           TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_payment_methods   TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_product_groups    TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_discounts         TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_cancellations     TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_accounting_lines  TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_payment_accounts  TO authenticated, anon;

-- Personen Tabellen (20260617_gn_personen.sql + 20260617_gn_analysis.sql)
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_person_imports    TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_person_metrics    TO authenticated, anon;

-- Hinweis: gn_analysis_imports + gn_analysis_metrics sind in
-- 20260617_gn_analysis_create_missing_tables.sql bereits mit GRANT versehen.
