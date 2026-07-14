-- Create table for IMAP email settings
CREATE TABLE public.imap_email_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 993,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  use_tls BOOLEAN NOT NULL DEFAULT true,
  mailbox TEXT NOT NULL DEFAULT 'INBOX',
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  last_sync_at TIMESTAMP WITH TIME ZONE,
  last_uid INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.imap_email_settings ENABLE ROW LEVEL SECURITY;

-- Allow public read/write for now (no auth in this app)
CREATE POLICY "Allow public read access on imap_email_settings" 
ON public.imap_email_settings 
FOR SELECT 
USING (true);

CREATE POLICY "Allow public insert access on imap_email_settings" 
ON public.imap_email_settings 
FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Allow public update access on imap_email_settings" 
ON public.imap_email_settings 
FOR UPDATE 
USING (true);

CREATE POLICY "Allow public delete access on imap_email_settings" 
ON public.imap_email_settings 
FOR DELETE 
USING (true);

-- Add trigger for updated_at
CREATE TRIGGER update_imap_email_settings_updated_at
BEFORE UPDATE ON public.imap_email_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();