-- Add INSERT policy for department_access_tokens
CREATE POLICY "Allow public insert for token creation"
ON public.department_access_tokens
FOR INSERT
WITH CHECK (true);

-- Add UPDATE policy for toggling token status
CREATE POLICY "Allow public update for token management"
ON public.department_access_tokens
FOR UPDATE
USING (true);

-- Add DELETE policy for token deletion
CREATE POLICY "Allow public delete for token removal"
ON public.department_access_tokens
FOR DELETE
USING (true);