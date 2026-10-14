-- Create table for event notification settings
CREATE TABLE public.event_notification_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notify_group_reservations BOOLEAN NOT NULL DEFAULT true,
  notify_regular_reservations BOOLEAN NOT NULL DEFAULT true,
  days_before_notification INTEGER NOT NULL DEFAULT 7,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.event_notification_settings ENABLE ROW LEVEL SECURITY;

-- Create policies for public access (no auth required for this app)
CREATE POLICY "Allow public read for notification settings"
  ON public.event_notification_settings FOR SELECT
  USING (true);

CREATE POLICY "Allow public insert for notification settings"
  ON public.event_notification_settings FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow public update for notification settings"
  ON public.event_notification_settings FOR UPDATE
  USING (true);

CREATE POLICY "Allow public delete for notification settings"
  ON public.event_notification_settings FOR DELETE
  USING (true);

-- Create trigger for updated_at
CREATE TRIGGER update_event_notification_settings_updated_at
  BEFORE UPDATE ON public.event_notification_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Create table for tracking sent notifications (to avoid duplicates)
CREATE TABLE public.event_notifications_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  reservation_id UUID NOT NULL,
  notification_type TEXT NOT NULL, -- 'automatic' or 'manual'
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  recipients TEXT[] NOT NULL,
  success BOOLEAN NOT NULL DEFAULT true,
  error_message TEXT
);

-- Enable RLS
ALTER TABLE public.event_notifications_log ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Allow public read for notification logs"
  ON public.event_notifications_log FOR SELECT
  USING (true);

CREATE POLICY "Allow public insert for notification logs"
  ON public.event_notifications_log FOR INSERT
  WITH CHECK (true);