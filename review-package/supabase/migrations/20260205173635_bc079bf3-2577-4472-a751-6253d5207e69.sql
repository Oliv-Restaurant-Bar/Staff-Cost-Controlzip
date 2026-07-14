-- Add restaurant_hash column to fortelable_settings
ALTER TABLE public.fortelable_settings 
ADD COLUMN IF NOT EXISTS restaurant_hash TEXT;

-- Add comment for documentation
COMMENT ON COLUMN public.fortelable_settings.restaurant_hash IS 'Restaurant hash from Foratable API';