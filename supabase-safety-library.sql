-- Apply after supabase-setup.sql, supabase-safety-form-documents.sql,
-- and supabase-foreman-dashboard.sql.

create or replace function public.foreman_can_read_safety_library_document(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_workspace_role() is not distinct from 'foreman'
    and exists (
      select 1
      from public.workspace_state as workspace
      cross join lateral jsonb_array_elements(coalesce(workspace.data -> 'safetyLibrary', '[]'::jsonb)) as library_documents(document)
      where workspace.id = 'main'
        and library_documents.document ->> 'storagePath' = p_path
        and (
          nullif(library_documents.document ->> 'jobId', '') is null
          or exists (
            select 1
            from jsonb_array_elements(coalesce(workspace.data -> 'jobs', '[]'::jsonb)) as jobs(job)
            where jobs.job ->> 'id' = library_documents.document ->> 'jobId'
              and jobs.job ->> 'foremanUserId' = (select auth.uid())::text
          )
        )
    );
$$;

revoke all on function public.foreman_can_read_safety_library_document(text) from public;
grant execute on function public.foreman_can_read_safety_library_document(text) to authenticated;

drop policy if exists "Workspace users read safety library PDFs" on storage.objects;
create policy "Workspace users read safety library PDFs"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'safety-form-documents'
    and (storage.foldername(name))[1] = 'library'
    and public.current_workspace_role() in ('admin', 'manager', 'foreman')
    and (
      public.current_workspace_role() in ('admin', 'manager')
      or public.foreman_can_read_safety_library_document(name)
    )
  );

create or replace function public.foreman_safety_library_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  library_data jsonb;
  folder_data jsonb;
begin
  if public.current_workspace_role() is distinct from 'foreman' then
    raise exception 'Foreman access is required';
  end if;

  select coalesce(data -> 'safetyLibrary', '[]'::jsonb)
  into library_data
  from public.workspace_state
  where id = 'main';

  select coalesce(data -> 'safetyLibraryFolders', '[]'::jsonb)
  into folder_data
  from public.workspace_state
  where id = 'main';

  return jsonb_build_object(
    'documents', coalesce((
      select jsonb_agg(document)
      from jsonb_array_elements(coalesce(library_data, '[]'::jsonb)) as library_documents(document)
      where nullif(document ->> 'jobId', '') is null
        or document ->> 'jobId' = any(array(
          select job ->> 'id'
          from jsonb_array_elements(coalesce((
            select data -> 'jobs'
            from public.workspace_state
            where id = 'main'
          ), '[]'::jsonb)) as jobs(job)
          where job ->> 'foremanUserId' = (select auth.uid())::text
        ))
    ), '[]'::jsonb),
    'folders', coalesce(folder_data, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.foreman_safety_library_data() from public;
grant execute on function public.foreman_safety_library_data() to authenticated;
