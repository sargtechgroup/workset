-- Run once in Supabase SQL Editor to add complete profiles, contractor tax details,
-- private safety-ticket photos, and authenticated ticket verification.

alter table public.profiles
  add column if not exists phone text not null default '',
  add column if not exists job_title text not null default '',
  add column if not exists employee_number text not null default '',
  add column if not exists emergency_contact_name text not null default '',
  add column if not exists emergency_contact_phone text not null default '',
  add column if not exists profile_photo_path text;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('pending', 'manager', 'admin', 'contractor', 'foreman'));

alter table public.contractor_companies
  add column if not exists gst_number text not null default '',
  add column if not exists business_address text not null default '',
  add column if not exists business_phone text not null default '';

create table if not exists public.safety_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  holder_name text not null default '',
  title text not null,
  issuer text not null,
  ticket_number text not null default '',
  issued_on date not null,
  expires_on date not null,
  photo_path text not null,
  created_at timestamptz not null default now(),
  constraint safety_tickets_date_order check (expires_on >= issued_on),
  constraint safety_tickets_photo_owner_path check (photo_path like user_id::text || '/tickets/' || id::text || '/%')
);

alter table public.safety_tickets add column if not exists holder_name text not null default '';

create or replace function public.set_safety_ticket_holder_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select full_name into new.holder_name
  from public.profiles
  where id = new.user_id;
  if new.holder_name is null or new.holder_name = '' then
    raise exception 'A valid ticket holder profile is required';
  end if;
  return new;
end;
$$;

drop trigger if exists set_safety_ticket_holder_name on public.safety_tickets;
create trigger set_safety_ticket_holder_name
  before insert on public.safety_tickets
  for each row execute procedure public.set_safety_ticket_holder_name();

create index if not exists safety_tickets_user_expiry_idx
  on public.safety_tickets (user_id, expires_on);

alter table public.profiles enable row level security;
alter table public.contractor_companies enable row level security;
alter table public.safety_tickets enable row level security;

drop policy if exists "Users read own or admins read all profiles" on public.profiles;
create policy "Users read own or admins read all profiles"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.current_workspace_role() = 'admin');

drop policy if exists "Users update own profile details" on public.profiles;
create policy "Users update own profile details"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

revoke update on public.profiles from authenticated;
grant update (full_name, phone, job_title, employee_number, emergency_contact_name, emergency_contact_phone, profile_photo_path)
  on public.profiles to authenticated;

create or replace function public.prevent_profile_access_self_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) = old.id
     and public.current_workspace_role() <> 'admin'
     and (
       new.role is distinct from old.role
       or new.contractor_company_id is distinct from old.contractor_company_id
       or new.contractor_status is distinct from old.contractor_status
       or new.email is distinct from old.email
     ) then
    raise exception 'Users cannot change their own account access or company assignment';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_profile_access_self_change on public.profiles;
create trigger prevent_profile_access_self_change
  before update on public.profiles
  for each row execute procedure public.prevent_profile_access_self_change();

create or replace function public.admin_update_profile_access(
  p_user_id uuid,
  p_role text default null,
  p_contractor_status text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.current_workspace_role() is distinct from 'admin' then
    raise exception 'Only workspace admins can update account access';
  end if;
  if p_role is null and p_contractor_status is null then
    raise exception 'No access change was provided';
  end if;
  if p_role is not null and p_role not in ('pending', 'manager', 'admin', 'contractor', 'foreman') then
    raise exception 'Invalid account role';
  end if;
  if p_contractor_status is not null and p_contractor_status not in ('not_applicable', 'pending', 'active', 'rejected', 'suspended') then
    raise exception 'Invalid contractor status';
  end if;
  if p_user_id = (select auth.uid()) and p_role is not null and p_role <> 'admin' then
    raise exception 'Admins cannot remove their own admin role';
  end if;

  update public.profiles
  set role = coalesce(p_role, role),
      contractor_status = coalesce(p_contractor_status, contractor_status)
  where id = p_user_id;
  if not found then
    raise exception 'User profile not found';
  end if;
end;
$$;

revoke all on function public.admin_update_profile_access(uuid, text, text) from public;
grant execute on function public.admin_update_profile_access(uuid, text, text) to authenticated;

create or replace function public.set_profile_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_type text;
  requested_company text;
  requested_gst text;
  requested_business_phone text;
  requested_business_address text;
  matched_company_id uuid;
begin
  requested_type := new.raw_user_meta_data ->> 'account_type';
  if requested_type = 'contractor' then
    requested_company := nullif(btrim(new.raw_user_meta_data ->> 'contractor_company_name'), '');
    requested_gst := nullif(btrim(new.raw_user_meta_data ->> 'contractor_gst_number'), '');
    requested_business_phone := nullif(btrim(new.raw_user_meta_data ->> 'contractor_business_phone'), '');
    requested_business_address := nullif(btrim(new.raw_user_meta_data ->> 'contractor_business_address'), '');
    if requested_company is null or requested_gst is null
       or requested_business_phone is null or requested_business_address is null then
      raise exception 'Contractor company name, GST / tax number, business phone, and address are required';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(lower(requested_company), 0));
    select id into matched_company_id
    from public.contractor_companies
    where lower(name) = lower(requested_company);

    if matched_company_id is null then
      insert into public.contractor_companies (name, gst_number, business_phone, business_address)
      values (requested_company, requested_gst, requested_business_phone, requested_business_address)
      returning id into matched_company_id;
    end if;

    insert into public.profiles (
      id, email, full_name, role, contractor_company_id, contractor_status,
      phone, job_title
    )
    values (
      new.id,
      new.email,
      coalesce(new.raw_user_meta_data ->> 'full_name', ''),
      'contractor',
      matched_company_id,
      'pending',
      coalesce(new.raw_user_meta_data ->> 'phone', ''),
      coalesce(new.raw_user_meta_data ->> 'job_title', '')
    )
    on conflict (id) do update
    set email = excluded.email;
  else
    insert into public.profiles (id, email, full_name, role, contractor_status, phone, job_title)
    values (
      new.id,
      new.email,
      coalesce(new.raw_user_meta_data ->> 'full_name', ''),
      'pending',
      'not_applicable',
      coalesce(new.raw_user_meta_data ->> 'phone', ''),
      coalesce(new.raw_user_meta_data ->> 'job_title', '')
    )
    on conflict (id) do update
    set email = excluded.email;
  end if;
  return new;
end;
$$;

drop policy if exists "Users read safety tickets they can verify" on public.safety_tickets;
create policy "Users read safety tickets they can verify"
  on public.safety_tickets for select to authenticated
  using (
    public.current_workspace_role() in ('admin', 'manager')
    or (
      user_id = (select auth.uid())
      and exists (
        select 1
        from public.profiles p
        left join public.contractor_companies c on c.id = p.contractor_company_id
        where p.id = (select auth.uid())
          and (
            p.role in ('admin', 'manager')
            or (
              p.role = 'contractor'
              and p.contractor_status = 'active'
              and c.status = 'active'
            )
          )
      )
    )
  );

drop policy if exists "Active users add their own safety tickets" on public.safety_tickets;
create policy "Active users add their own safety tickets"
  on public.safety_tickets for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.profiles p
      left join public.contractor_companies c on c.id = p.contractor_company_id
      where p.id = (select auth.uid())
        and (
          p.role in ('admin', 'manager')
          or (
            p.role = 'contractor'
            and p.contractor_status = 'active'
            and c.status = 'active'
          )
        )
    )
  );

drop policy if exists "Admins manage safety tickets" on public.safety_tickets;
create policy "Admins manage safety tickets"
  on public.safety_tickets for all to authenticated
  using (public.current_workspace_role() = 'admin')
  with check (public.current_workspace_role() = 'admin');

drop policy if exists "Owners delete their own safety tickets" on public.safety_tickets;
create policy "Owners delete their own safety tickets"
  on public.safety_tickets for delete to authenticated
  using (user_id = (select auth.uid()));

grant select, insert, delete on public.safety_tickets to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('safety-ticket-photos', 'safety-ticket-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "Users read permitted private profile and safety photos" on storage.objects;
create policy "Users read permitted private profile and safety photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'safety-ticket-photos'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or public.current_workspace_role() in ('admin', 'manager')
    )
  );

drop policy if exists "Users upload their own private profile and safety photos" on storage.objects;
create policy "Users upload their own private profile and safety photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'safety-ticket-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users update their own private profile and safety photos" on storage.objects;
create policy "Users update their own private profile and safety photos"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'safety-ticket-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'safety-ticket-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users remove their own private profile and safety photos" on storage.objects;
create policy "Users remove their own private profile and safety photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'safety-ticket-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
