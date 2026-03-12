
CREATE TABLE public.capacity_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  mittag_capacity INTEGER NOT NULL DEFAULT 80,
  abend_capacity INTEGER NOT NULL DEFAULT 80,
  u1_capacity INTEGER NOT NULL DEFAULT 80,
  u1_days INTEGER[] NOT NULL DEFAULT '{5,6}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Insert default row
INSERT INTO public.capacity_settings (id, mittag_capacity, abend_capacity, u1_capacity, u1_days)
VALUES ('default', 80, 80, 80, '{5,6}');

-- No RLS needed - public config data
ALTER TABLE public.capacity_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read capacity settings"
ON public.capacity_settings FOR SELECT USING (true);

CREATE POLICY "Anyone can update capacity settings"
ON public.capacity_settings FOR UPDATE USING (true);
