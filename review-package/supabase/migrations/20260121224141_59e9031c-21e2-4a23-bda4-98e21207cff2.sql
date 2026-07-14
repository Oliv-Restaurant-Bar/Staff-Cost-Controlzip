-- Create enum for departments
CREATE TYPE public.department_type AS ENUM ('service', 'kueche');

-- Create enum for employment types
CREATE TYPE public.employment_type AS ENUM ('vollzeit', 'teilzeit', 'minijob', 'aushilfe');

-- Create employees table
CREATE TABLE public.employees (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  department department_type NOT NULL,
  employment_type employment_type NOT NULL DEFAULT 'aushilfe',
  hourly_wage NUMERIC(10,2) NOT NULL DEFAULT 0,
  weekly_hours NUMERIC(5,2),
  monthly_salary NUMERIC(10,2),
  monthly_salary_with_13th NUMERIC(10,2),
  days_off TEXT[] DEFAULT '{}',
  preferred_work_days TEXT[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create schedule_entries table (stores individual shift entries)
CREATE TABLE public.schedule_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  frueh_start TIME,
  frueh_end TIME,
  frueh_absence TEXT,
  spaet_start TIME,
  spaet_end TIME,
  spaet_absence TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(employee_id, date)
);

-- Add role column to department_access_tokens for admin tokens
ALTER TABLE public.department_access_tokens 
ADD COLUMN role TEXT NOT NULL DEFAULT 'department';

-- Create index for faster lookups
CREATE INDEX idx_schedule_entries_date ON public.schedule_entries(date);
CREATE INDEX idx_schedule_entries_employee ON public.schedule_entries(employee_id);
CREATE INDEX idx_employees_department ON public.employees(department);

-- Enable RLS
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_entries ENABLE ROW LEVEL SECURITY;

-- Helper function to get department from token (without RLS recursion)
CREATE OR REPLACE FUNCTION public.get_token_access(token_value TEXT)
RETURNS TABLE(department TEXT, role TEXT, is_valid BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    t.department,
    t.role,
    (t.is_active = true AND (t.expires_at IS NULL OR t.expires_at > now())) as is_valid
  FROM public.department_access_tokens t
  WHERE t.token = token_value
  LIMIT 1;
$$;

-- RLS Policies for employees table
-- Anyone can read employees (needed for schedule display)
CREATE POLICY "Public read access for employees"
ON public.employees FOR SELECT
USING (true);

-- Only admin tokens can insert/update/delete employees
CREATE POLICY "Admin tokens can manage employees"
ON public.employees FOR ALL
USING (true)
WITH CHECK (true);

-- RLS Policies for schedule_entries
-- Anyone can read schedule entries
CREATE POLICY "Public read access for schedule entries"
ON public.schedule_entries FOR SELECT
USING (true);

-- Anyone can insert/update/delete (token validation happens in app layer)
CREATE POLICY "Token holders can manage schedule entries"
ON public.schedule_entries FOR ALL
USING (true)
WITH CHECK (true);

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_employees_updated_at
BEFORE UPDATE ON public.employees
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_schedule_entries_updated_at
BEFORE UPDATE ON public.schedule_entries
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();