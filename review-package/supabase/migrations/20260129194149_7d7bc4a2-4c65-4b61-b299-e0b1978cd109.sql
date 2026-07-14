-- Add GF (Geschäftsführer) confirmation fields to group_reservations
ALTER TABLE public.group_reservations 
ADD COLUMN IF NOT EXISTS gf_accepted boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS gf_accepted_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS gf_final_confirmed boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS gf_final_confirmed_at timestamp with time zone;

-- Drop old constraint and add new one with geschaeftsfuehrer
ALTER TABLE public.department_notification_emails 
DROP CONSTRAINT IF EXISTS department_notification_emails_department_check;

ALTER TABLE public.department_notification_emails 
ADD CONSTRAINT department_notification_emails_department_check 
CHECK (department = ANY (ARRAY['dekoration'::text, 'service'::text, 'bar'::text, 'kueche'::text, 'geschaeftsfuehrer'::text]));

-- Add GF email to department notification emails
INSERT INTO public.department_notification_emails (department, email, is_active)
SELECT 'geschaeftsfuehrer', null, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.department_notification_emails WHERE department = 'geschaeftsfuehrer'
);

-- Add comments for clarity
COMMENT ON COLUMN public.group_reservations.gf_accepted IS 'Geschäftsführer has accepted/acknowledged the event';
COMMENT ON COLUMN public.group_reservations.gf_final_confirmed IS 'Geschäftsführer final confirmation that everything is ready';