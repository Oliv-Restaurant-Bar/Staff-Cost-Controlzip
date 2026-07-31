-- Warenrechnungen: privater Storage-Bucket für Beleg-/Screenshot-Uploads.
-- Pfad-Konvention: <tenantId>/<invoiceId>.<ext> (tenant-präfixiert; die App
-- erzwingt den Prefix zusätzlich clientseitig in allen Helfern).
-- Idempotent — bereits LIVE via Management-API eingespielt (2026-07-31).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('waren-belege', 'waren-belege', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

do $$ begin
  create policy waren_belege_select on storage.objects
    for select to authenticated using (bucket_id = 'waren-belege');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy waren_belege_insert on storage.objects
    for insert to authenticated with check (bucket_id = 'waren-belege');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy waren_belege_update on storage.objects
    for update to authenticated using (bucket_id = 'waren-belege');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy waren_belege_delete on storage.objects
    for delete to authenticated using (bucket_id = 'waren-belege');
exception when duplicate_object then null; end $$;
