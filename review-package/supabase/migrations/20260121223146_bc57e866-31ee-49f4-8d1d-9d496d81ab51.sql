-- Drop the restrictive policy and create a permissive one
DROP POLICY IF EXISTS "Allow public read for token validation" ON public.department_access_tokens;

CREATE POLICY "Allow public read for token validation"
ON public.department_access_tokens
FOR SELECT
USING (true);