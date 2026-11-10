-- Private WCB clearance letters for contractor companies.
alter table public.contractor_companies
  add column if not exists wcb_letter_path text,
  add column if not exists wcb_expires_on date;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'contractor-wcb-letters',
  'contractor-wcb-letters',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "Admins and company users read WCB letters" on storage.objects;
create policy "Admins and company users read WCB letters"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'contractor-wcb-letters'
    and (
      public.current_workspace_role() = 'admin'
      or (
        (storage.foldername(name))[1] = (select public.current_contractor_company_id())::text
        and exists (
          select 1 from public.profiles p
          where p.id = (select auth.uid())
            and p.role = 'contractor'
            and p.contractor_status in ('pending', 'active')
        )
      )
    )
  );

drop policy if exists "Admins and company users upload WCB letters" on storage.objects;
create policy "Admins and company users upload WCB letters"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'contractor-wcb-letters'
    and (
      public.current_workspace_role() = 'admin'
      or (
        (storage.foldername(name))[1] = (select public.current_contractor_company_id())::text
        and exists (
          select 1 from public.profiles p
          where p.id = (select auth.uid())
            and p.role = 'contractor'
            and p.contractor_status in ('pending', 'active')
        )
      )
    )
  );

drop policy if exists "Admins and company users remove WCB letters" on storage.objects;
create policy "Admins and company users remove WCB letters"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'contractor-wcb-letters'
    and (
      public.current_workspace_role() = 'admin'
      or (
        (storage.foldername(name))[1] = (select public.current_contractor_company_id())::text
        and exists (
          select 1 from public.profiles p
          where p.id = (select auth.uid())
            and p.role = 'contractor'
            and p.contractor_status in ('pending', 'active')
        )
      )
    )
  );

create or replace function public.set_contractor_wcb_clearance(
  p_company_id uuid,
  p_document_path text,
  p_expires_on date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_company_id is null or p_document_path is null or p_expires_on is null then
    raise exception 'A company, WCB letter, and expiry date are required';
  end if;
  if left(p_document_path, length(p_company_id::text) + 1) <> (p_company_id::text || '/')
     or position('/' in substring(p_document_path from length(p_company_id::text) + 2)) > 0 then
    raise exception 'The WCB letter must be stored in the company folder';
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'contractor-wcb-letters'
      and o.name = p_document_path
  ) then
    raise exception 'Upload the WCB letter before saving its expiry date';
  end if;
  if coalesce(public.current_workspace_role(), '') <> 'admin'
     and not exists (
       select 1 from public.profiles p
       where p.id = (select auth.uid())
         and p.role = 'contractor'
         and p.contractor_company_id = p_company_id
         and p.contractor_status in ('pending', 'active')
     ) then
    raise exception 'You cannot update this contractor company WCB clearance';
  end if;

  update public.contractor_companies
  set wcb_letter_path = p_document_path,
      wcb_expires_on = p_expires_on
  where id = p_company_id;
  if not found then
    raise exception 'Contractor company not found';
  end if;
end;
$$;

revoke all on function public.set_contractor_wcb_clearance(uuid, text, date) from public;
grant execute on function public.set_contractor_wcb_clearance(uuid, text, date) to authenticated;
