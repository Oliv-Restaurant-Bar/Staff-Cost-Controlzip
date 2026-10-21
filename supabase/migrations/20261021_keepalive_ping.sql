-- Keep-alive ping for the daily Vercel Cron (api/keepalive.ts).
-- Prevents the free-tier Supabase project from being paused for inactivity.
--
-- Exposes ONLY the current timestamp: no table access, no parameters.
-- This is the single deliberate anon-EXECUTE exception after the
-- 20260805/20260806 anon lockdown; it reads no data.
--
-- Run in the Supabase SQL editor (dev project). Idempotent.

CREATE OR REPLACE FUNCTION public.keepalive_ping()
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT now();
$$;

REVOKE ALL ON FUNCTION public.keepalive_ping() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.keepalive_ping() TO anon, authenticated;
