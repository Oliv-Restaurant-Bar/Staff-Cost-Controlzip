-- ═══════════════════════════════════════════════════════════════════════════
-- Employee Self-Registration (Selbst-Anmeldung)
-- Datum: 2026-03-15
-- Zweck: Neuer Mitarbeiter kann sich selbst registrieren ohne vorbefüllten Record
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. employee_status Spalte hinzufügen
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS employee_status VARCHAR DEFAULT 'active'
  CHECK (employee_status IN ('active', 'pending_review'));

COMMENT ON COLUMN public.employees.employee_status IS
  'active = normaler Mitarbeiter | pending_review = neue Selbst-Anmeldung, wartet auf Admin-Aktivierung';

-- 2. Optional: RLS-Policy für anon INSERT (damit neue MA sich registrieren können)
--    Nur nötig wenn RLS auf employees-Tabelle aktiv ist

DROP POLICY IF EXISTS "Anon self-register new employee" ON public.employees;
CREATE POLICY "Anon self-register new employee"
  ON public.employees FOR INSERT
  TO anon
  WITH CHECK (employee_status = 'pending_review');
