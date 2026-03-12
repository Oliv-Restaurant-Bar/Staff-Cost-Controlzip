-- Change default for exclude_walk_in to true (no walk-in for group reservations by default)
ALTER TABLE public.group_reservations 
ALTER COLUMN exclude_walk_in SET DEFAULT true;