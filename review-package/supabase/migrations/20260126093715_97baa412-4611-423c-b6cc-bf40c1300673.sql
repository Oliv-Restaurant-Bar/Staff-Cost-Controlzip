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

-- Add trigger for updated_at
CREATE TRIGGER update_email_imported_reservations_updated_at
BEFORE UPDATE ON public.email_imported_reservations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Enable realtime for notifications
ALTER PUBLICATION supabase_realtime ADD TABLE public.email_imported_reservations;