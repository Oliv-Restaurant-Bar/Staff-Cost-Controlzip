-- Add group_type column to store whether it's a Laufzettel or À la carte reservation
ALTER TABLE public.group_reservations 
ADD COLUMN group_type text DEFAULT 'laufzettel' CHECK (group_type IN ('laufzettel', 'alacarte'));