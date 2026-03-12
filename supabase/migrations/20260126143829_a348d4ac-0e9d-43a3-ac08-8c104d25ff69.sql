-- Create table for external API integration settings
CREATE TABLE public.external_api_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  api_key TEXT NOT NULL,
  api_key_name TEXT NOT NULL DEFAULT 'Default API Key',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_used_at TIMESTAMP WITH TIME ZONE,
  request_count INTEGER NOT NULL DEFAULT 0
);

-- Create table for logging external API imports
CREATE TABLE public.external_api_import_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  api_key_id UUID REFERENCES public.external_api_settings(id) ON DELETE SET NULL,
  source_system TEXT,
  import_type TEXT NOT NULL DEFAULT 'api', -- 'api' or 'file'
  reservations_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  errors JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add source field to group_reservations to track origin
ALTER TABLE public.group_reservations 
ADD COLUMN IF NOT EXISTS external_id TEXT,
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

-- Create index for external_id lookups
CREATE INDEX IF NOT EXISTS idx_group_reservations_external_id ON public.group_reservations(external_id);

-- Enable RLS
ALTER TABLE public.external_api_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_api_import_log ENABLE ROW LEVEL SECURITY;

-- RLS policies - allow all access (no auth required for this app)
CREATE POLICY "Allow all access to external_api_settings" 
ON public.external_api_settings FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all access to external_api_import_log" 
ON public.external_api_import_log FOR ALL USING (true) WITH CHECK (true);

-- Trigger for updated_at
CREATE TRIGGER update_external_api_settings_updated_at
BEFORE UPDATE ON public.external_api_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();