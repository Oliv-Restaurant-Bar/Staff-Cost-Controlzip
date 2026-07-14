-- Create table for department email settings
CREATE TABLE public.department_notification_emails (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  department TEXT NOT NULL UNIQUE CHECK (department IN ('dekoration', 'service', 'bar', 'kueche')),
  email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.department_notification_emails ENABLE ROW LEVEL SECURITY;

-- Create policies for public access (no auth in this app)
CREATE POLICY "Allow public read for department emails" 
ON public.department_notification_emails 
FOR SELECT 
USING (true);

CREATE POLICY "Allow public insert for department emails" 
ON public.department_notification_emails 
FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Allow public update for department emails" 
ON public.department_notification_emails 
FOR UPDATE 
USING (true);

CREATE POLICY "Allow public delete for department emails" 
ON public.department_notification_emails 
FOR DELETE 
USING (true);

-- Insert default rows for all departments
INSERT INTO public.department_notification_emails (department, email, is_active)
VALUES 
  ('dekoration', NULL, true),
  ('service', NULL, true),
  ('bar', NULL, true),
  ('kueche', NULL, true);

-- Add trigger for updated_at
CREATE TRIGGER update_department_notification_emails_updated_at
BEFORE UPDATE ON public.department_notification_emails
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();