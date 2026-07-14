-- Add location field to group_reservations and exclude_walk_in flag
ALTER TABLE public.group_reservations
ADD COLUMN IF NOT EXISTS location text DEFAULT 'EG Restaurant',
ADD COLUMN IF NOT EXISTS exclude_walk_in boolean DEFAULT false;