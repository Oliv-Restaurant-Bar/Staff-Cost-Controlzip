-- Add field to track if a reservation's revenue has been applied to the planned budget
ALTER TABLE public.group_reservations 
ADD COLUMN applied_to_budget BOOLEAN NOT NULL DEFAULT false;