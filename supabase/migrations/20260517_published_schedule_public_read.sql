-- Allow unauthenticated (anon) users to read published schedule tokens.
-- REQUIRED: the /staff-schedule/:token page is public — no auth — so RLS
-- must permit the anon role to SELECT rows whose key starts with
-- 'published-schedule:'. All other app_settings rows remain private
-- (only authenticated users can read them via the existing policy).
--
-- Run this once in the Supabase SQL editor.

-- 1. Grant the SELECT privilege on app_settings to the anon role
--    (the table currently only grants to 'authenticated').
GRANT SELECT ON public.app_settings TO anon;

-- 2. Row-level policy: anon may only read published-schedule keys.
CREATE POLICY "anon_published_schedule_read"
  ON public.app_settings
  FOR SELECT
  TO anon
  USING (key LIKE 'published-schedule:%');
