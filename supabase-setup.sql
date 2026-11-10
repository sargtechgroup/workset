-- Re-run this entire script after applying the contractor company and per-user approval flow.
-- New contractor signups create a pending company and a pending user membership.

create table if not exists public.contractor_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'suspended')),
  created_at timestamptz not null default now()
);

create unique index if not exists contractor_companies_normalized_name_key
  on public.contractor_companies (lower(name));

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  role text not null default 'pending',
  contractor_company_id uuid references public.contractor_companies (id),
  contractor_status text not null default 'not_applicable',
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists contractor_company_id uuid references public.contractor_companies (id);
alter table public.profiles add column if not exists contractor_status text not null default 'not_applicable';
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles drop constraint if exists profiles_contractor_status_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('pending', 'manager', 'admin', 'contractor', 'foreman'));
alter table public.profiles add constraint profiles_contractor_status_check
  check (contractor_status in ('not_applicable', 'pending', 'active', 'rejected', 'suspended'));

create table if not exists public.workspace_state (
  id text primary key check (id = 'main'),
  data jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version > 0),
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

insert into public.workspace_state (id, data)
values ('main', '{}'::jsonb)
on conflict (id) do nothing;

create or replace function public.set_profile_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_type text;
  requested_company text;
  matched_company_id uuid;
begin
  requested_type := new.raw_user_meta_data ->> 'account_type';
  if requested_type = 'contractor' then
    requested_company := nullif(btrim(new.raw_user_meta_data ->> 'contractor_company_name'), '');
    if requested_company is null then
      raise exception 'Contractor company name is required';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(lower(requested_company), 0));
    select id into matched_company_id
    from public.contractor_companies
    where lower(name) = lower(requested_company);

    if matched_company_id is null then
      insert into public.contractor_companies (name)
      values (requested_company)
      returning id into matched_company_id;
    end if;

    insert into public.profiles (id, email, full_name, role, contractor_company_id, contractor_status)
    values (
      new.id,
      new.email,
      coalesce(new.raw_user_meta_data ->> 'full_name', ''),
      'contractor',
      matched_company_id,
      'pending'
    )
    on conflict (id) do update
    set email = excluded.email;
  else
    insert into public.profiles (id, email, full_name, role, contractor_status)
    values (
      new.id,
      new.email,
      coalesce(new.raw_user_meta_data ->> 'full_name', ''),
      'pending',
      'not_applicable'
    )
    on conflict (id) do update
    set email = excluded.email;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_fieldwork on auth.users;
create trigger on_auth_user_created_fieldwork
  after insert on auth.users
  for each row execute procedure public.set_profile_from_auth_user();

create or replace function public.current_workspace_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = (select auth.uid())
$$;

create or replace function public.current_contractor_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select contractor_company_id
  from public.profiles
  where id = (select auth.uid()) and role = 'contractor'
$$;

revoke all on function public.current_workspace_role() from public;
revoke all on function public.current_contractor_company_id() from public;
grant execute on function public.current_workspace_role() to authenticated;
grant execute on function public.current_contractor_company_id() to authenticated;

alter table public.profiles enable row level security;
alter table public.contractor_companies enable row level security;
alter table public.workspace_state enable row level security;

drop policy if exists "Users read own or admins read all profiles" on public.profiles;
create policy "Users read own or admins read all profiles"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.current_workspace_role() = 'admin');

drop policy if exists "Admins update profiles" on public.profiles;
create policy "Admins update profiles"
  on public.profiles for update to authenticated
  using (public.current_workspace_role() = 'admin')
  with check (
    public.current_workspace_role() = 'admin'
    and (id <> (select auth.uid()) or role = 'admin')
  );

drop policy if exists "Admins manage contractor companies" on public.contractor_companies;
create policy "Admins manage contractor companies"
  on public.contractor_companies for all to authenticated
  using (public.current_workspace_role() = 'admin')
  with check (public.current_workspace_role() = 'admin');

drop policy if exists "Contractors read their company" on public.contractor_companies;
create policy "Contractors read their company"
  on public.contractor_companies for select to authenticated
  using (id = public.current_contractor_company_id());

drop policy if exists "Active users read workspace" on public.workspace_state;
create policy "Active users read workspace"
  on public.workspace_state for select to authenticated
  using (public.current_workspace_role() in ('admin', 'manager'));

drop policy if exists "Active users update workspace" on public.workspace_state;
create policy "Active users update workspace"
  on public.workspace_state for update to authenticated
  using (public.current_workspace_role() in ('admin', 'manager'))
  with check (public.current_workspace_role() in ('admin', 'manager'));

grant select, update on public.profiles to authenticated;
grant select, update on public.contractor_companies to authenticated;
grant select, update on public.workspace_state to authenticated;

do $$
declare
  table_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array['workspace_state', 'profiles', 'contractor_companies'] loop
      if exists (
        select 1 from pg_tables
        where schemaname = 'public' and tablename = table_name
      ) and not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = table_name
      ) then
        execute format('alter publication supabase_realtime add table public.%I', table_name);
      end if;
    end loop;
  end if;
end
$$;

-- After creating your first internal account, run this once using its sign-in email:
-- update public.profiles set role = 'admin' where email = 'admin@yourcompany.com';
