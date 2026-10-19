-- Create table for email-imported reservations
CREATE TABLE public.email_imported_reservations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  reservation_number TEXT,
  guest_name TEXT NOT NULL,
  guest_email TEXT,
  guest_phone TEXT,
  date DATE NOT NULL,
  time TIME NOT NULL,
  guest_count INTEGER NOT NULL DEFAULT 1,
  comment TEXT,
  location TEXT,
  source TEXT DEFAULT 'foratable',
  raw_email_content TEXT,
  is_processed BOOLEAN NOT NULL DEFAULT false,
  needs_review BOOLEAN NOT NULL DEFAULT false,
  converted_to_group_id UUID REFERENCES public.group_reservations(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.email_imported_reservations ENABLE ROW LEVEL SECURITY;

-- Create policy for public access (webhook needs to insert)
CREATE POLICY "Allow public insert for email imports"
ON public.email_imported_reservations
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow public read for email imports"
ON public.email_imported_reservations
FOR SELECT
USING (true);

CREATE POLICY "Allow public update for email imports"
ON public.email_imported_reservations
FOR UPDATE
USING (true);

CREATE POLICY "Allow public delete for email imports"
ON public.email_imported_reservations
FOR DELETE
USING (true);

-- update_updated_at_column() should already exist (defined in 20260121224141_...sql
-- and redefined idempotently in 20260122162412_...sql, which this file's
-- filename-ordering applies before). Redefined here too as a standalone guard
-- in case this file is ever applied on its own — CREATE OR REPLACE is a safe
-- no-op anywhere it already exists. See that file's comment for why this
-- guard exists (2026-10-14 staging apply failure).
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Add trigger for updated_at
CREATE TRIGGER update_email_imported_reservations_updated_at
BEFORE UPDATE ON public.email_imported_reservations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Enable realtime for notifications
ALTER PUBLICATION supabase_realtime ADD TABLE public.email_imported_reservations;