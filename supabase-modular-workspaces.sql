-- Apply after supabase-setup.sql and the contractor workflow migrations.
-- Personal workspaces only control shortcuts; they do not grant page access.

create or replace function public.can_use_modular_workspaces()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.contractor_companies c on c.id = p.contractor_company_id
    where p.id = (select auth.uid())
      and (
        p.role in ('admin', 'manager', 'foreman')
        or (p.role = 'contractor' and p.contractor_status = 'active' and c.status = 'active')
      )
  )
$$;
revoke all on function public.can_use_modular_workspaces() from public;
grant execute on function public.can_use_modular_workspaces() to authenticated;

create table if not exists public.shared_workspace_modules (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id),
  name text not null check (length(btrim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 240),
  pages text[] not null default '{}' check (
    cardinality(pages) between 1 and 20
    and pages <@ array['overview','foreman','analytics','users','profile','safety-tickets','contractor-home','jobs','tasks','runs','tracking-tools','gps-workspace','people','invoices','contractor-work','safety','safety-library','reports']::text[]
  ),
  created_at timestamptz not null default now()
);

create table if not exists public.personal_workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  pages text[] not null default '{}' check (
    cardinality(pages) <= 20
    and pages <@ array['overview','foreman','analytics','users','profile','safety-tickets','contractor-home','jobs','tasks','runs','tracking-tools','gps-workspace','people','invoices','contractor-work','safety','safety-library','reports']::text[]
  ),
  module_ids uuid[] not null default '{}' check (cardinality(module_ids) <= 100),
  created_at timestamptz not null default now()
);

alter table public.shared_workspace_modules enable row level security;
alter table public.personal_workspaces enable row level security;
grant select, insert, update, delete on public.shared_workspace_modules, public.personal_workspaces to authenticated;

drop policy if exists "Approved users read shared modules" on public.shared_workspace_modules;
create policy "Approved users read shared modules" on public.shared_workspace_modules
  for select to authenticated using (public.can_use_modular_workspaces());
drop policy if exists "Approved users create shared modules" on public.shared_workspace_modules;
create policy "Approved users create shared modules" on public.shared_workspace_modules
  for insert to authenticated with check (public.can_use_modular_workspaces() and created_by = (select auth.uid()));
drop policy if exists "Creators and admins update shared modules" on public.shared_workspace_modules;
create policy "Creators and admins update shared modules" on public.shared_workspace_modules
  for update to authenticated
  using (public.can_use_modular_workspaces() and (created_by = (select auth.uid()) or public.current_workspace_role() = 'admin'))
  with check (public.can_use_modular_workspaces() and (created_by = (select auth.uid()) or public.current_workspace_role() = 'admin'));
drop policy if exists "Creators and admins delete shared modules" on public.shared_workspace_modules;
create policy "Creators and admins delete shared modules" on public.shared_workspace_modules
  for delete to authenticated
  using (public.can_use_modular_workspaces() and (created_by = (select auth.uid()) or public.current_workspace_role() = 'admin'));

drop policy if exists "Users manage their personal workspaces" on public.personal_workspaces;
create policy "Users manage their personal workspaces" on public.personal_workspaces
  for all to authenticated
  using (public.can_use_modular_workspaces() and user_id = (select auth.uid()))
  with check (public.can_use_modular_workspaces() and user_id = (select auth.uid()));
