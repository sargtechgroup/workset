-- Private safety form PDFs attached to job safety records.
-- Safety forms are stored in the shared workspace state; this migration only
-- provisions the private storage bucket and access policies for their PDFs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'safety-form-documents',
  'safety-form-documents',
  false,
  10485760,
  array['application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array['application/pdf'];

drop policy if exists "Workspace and owners read safety form PDFs" on storage.objects;
create policy "Workspace and owners read safety form PDFs"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'safety-form-documents'
    and (
      public.current_workspace_role() in ('admin', 'manager')
      or (storage.foldername(name))[1] = (select auth.uid())::text
    )
  );

drop policy if exists "Workspace and owners upload safety form PDFs" on storage.objects;
create policy "Workspace and owners upload safety form PDFs"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'safety-form-documents'
    and (
      public.current_workspace_role() in ('admin', 'manager')
      or (storage.foldername(name))[1] = (select auth.uid())::text
    )
  );

drop policy if exists "Workspace and owners remove safety form PDFs" on storage.objects;
create policy "Workspace and owners remove safety form PDFs"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'safety-form-documents'
    and (
      public.current_workspace_role() in ('admin', 'manager')
      or (storage.foldername(name))[1] = (select auth.uid())::text
    )
  );
