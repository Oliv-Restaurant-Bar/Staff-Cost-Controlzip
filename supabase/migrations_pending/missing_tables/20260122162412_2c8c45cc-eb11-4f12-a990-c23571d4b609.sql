-- update_updated_at_column() is defined in 20260121224141_...sql, which predates
-- this migration and should already exist on any database with the full
-- history applied. Redefined here (idempotent, identical body) as a guard —
-- this staging/dev database errored "function does not exist" on first apply
-- attempt (2026-10-14), meaning its applied-migration history has a gap
-- somewhere before 2026-01-22 despite otherwise matching production's table
-- list. CREATE OR REPLACE is a safe no-op anywhere it already exists.
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Table for group reservations (manual entries)
CREATE TABLE public.group_reservations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL,
  shift TEXT NOT NULL CHECK (shift IN ('mittag', 'abend')),
  group_name TEXT,
  guest_count INTEGER NOT NULL DEFAULT 1,
  revenue_per_person NUMERIC(10,2) NOT NULL DEFAULT 35.00,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Table for Fortelable integration settings
CREATE TABLE public.fortelable_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  api_key TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  walk_in_percentage NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  default_revenue_per_person NUMERIC(10,2) NOT NULL DEFAULT 35.00,
  last_sync_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- fortelable_reservations REMOVED 2026-10-01: only consumers were
-- ReservationsOverview.tsx/ReservationsBudgetCalculator.tsx (zero importers,
-- confirmed dead, moved to src/_deprecated/) and sync-fortelable Edge
-- Function (confirmed not deployed/no active cron, per client). Does not
-- affect group_reservations/fortelable_settings above, which are still
-- queried live by /overview (Index.tsx -> RevenueTab -> SimpleRevenueInput.tsx).
-- See src/_deprecated/README.md.

-- Enable RLS
ALTER TABLE public.group_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fortelable_settings ENABLE ROW LEVEL SECURITY;

-- Public access policies (no auth required for this app)
CREATE POLICY "Allow all operations on group_reservations" ON public.group_reservations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations on fortelable_settings" ON public.fortelable_settings FOR ALL USING (true) WITH CHECK (true);

-- Insert default settings
INSERT INTO public.fortelable_settings (walk_in_percentage, default_revenue_per_person, is_enabled)
VALUES (20.00, 35.00, false);

-- Trigger for updated_at
CREATE TRIGGER update_group_reservations_updated_at
BEFORE UPDATE ON public.group_reservations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_fortelable_settings_updated_at
BEFORE UPDATE ON public.fortelable_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();