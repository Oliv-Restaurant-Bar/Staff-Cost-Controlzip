-- Rezensionen: privater Storage-Bucket für Screenshot-Uploads (Back-Office).
-- Pfad-Konvention: <tenantId>/<reviewId>.<ext> (tenant-präfixiert; die App
-- erzwingt den Prefix zusätzlich clientseitig in allen Helfern).
-- Idempotent — bereits LIVE via Management-API eingespielt (2026-07-31).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-screenshots', 'review-screenshots', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Nur eingeloggte Nutzer (kein anon); Gäste-Sessions sind rein clientseitige
-- Tokens ohne eigene DB-Rolle — die App blendet Screenshots für Gäste aus.
do $$ begin
  create policy review_screenshots_select on storage.objects
    for select to authenticated using (bucket_id = 'review-screenshots');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy review_screenshots_insert on storage.objects
    for insert to authenticated with check (bucket_id = 'review-screenshots');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy review_screenshots_update on storage.objects
    for update to authenticated using (bucket_id = 'review-screenshots');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy review_screenshots_delete on storage.objects
    for delete to authenticated using (bucket_id = 'review-screenshots');
exception when duplicate_object then null; end $$;
