-- Add department confirmation checklist columns to group_reservations
ALTER TABLE public.group_reservations 
ADD COLUMN IF NOT EXISTS dekoration_ready boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS service_ready boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS bar_ready boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS kueche_ready boolean NOT NULL DEFAULT false;