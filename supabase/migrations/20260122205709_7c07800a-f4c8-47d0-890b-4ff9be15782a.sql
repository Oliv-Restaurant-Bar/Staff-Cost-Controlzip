-- Add confirmation and runsheet status to group_reservations
ALTER TABLE public.group_reservations 
ADD COLUMN IF NOT EXISTS is_confirmed boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS laufzettel_done boolean NOT NULL DEFAULT false;