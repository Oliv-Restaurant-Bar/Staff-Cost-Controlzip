-- Add menu_pdf_url column to group_reservations for storing PDF links
ALTER TABLE public.group_reservations 
ADD COLUMN menu_pdf_url TEXT;

-- Create storage bucket for menu PDFs
INSERT INTO storage.buckets (id, name, public)
VALUES ('menu-pdfs', 'menu-pdfs', true)
ON CONFLICT (id) DO NOTHING;

-- Create storage policies for menu PDFs
CREATE POLICY "Public can read menu PDFs"
ON storage.objects FOR SELECT
USING (bucket_id = 'menu-pdfs');

CREATE POLICY "Anyone can upload menu PDFs"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'menu-pdfs');

CREATE POLICY "Anyone can update menu PDFs"
ON storage.objects FOR UPDATE
USING (bucket_id = 'menu-pdfs');

CREATE POLICY "Anyone can delete menu PDFs"
ON storage.objects FOR DELETE
USING (bucket_id = 'menu-pdfs');