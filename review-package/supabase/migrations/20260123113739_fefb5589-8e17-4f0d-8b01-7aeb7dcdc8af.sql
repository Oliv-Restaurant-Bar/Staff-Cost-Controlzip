-- Add revenue_mode column to group_reservations
-- 'offset' = counts against budget first, then adds once exceeded
-- 'additional' = immediately adds to total revenue
ALTER TABLE public.group_reservations 
ADD COLUMN revenue_mode text DEFAULT 'offset' CHECK (revenue_mode IN ('offset', 'additional'));