-- Create table for department access tokens
CREATE TABLE public.department_access_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  department TEXT NOT NULL CHECK (department IN ('service', 'kueche')),
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE,
  last_used_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS
ALTER TABLE public.department_access_tokens ENABLE ROW LEVEL SECURITY;

-- Create policy for reading tokens (needed for validation)
CREATE POLICY "Allow public read for token validation"
ON public.department_access_tokens
FOR SELECT
USING (true);

-- Create index for fast token lookup
CREATE INDEX idx_department_access_tokens_token ON public.department_access_tokens(token);
CREATE INDEX idx_department_access_tokens_department ON public.department_access_tokens(department);