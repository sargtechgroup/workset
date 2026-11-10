-- Contractor job assignments, rate cards, owned equipment, invoice submissions,
-- and secure employee invitations. Apply after the contractor and profile setup SQL.

alter table public.contractor_companies
  add column if not exists owner_user_id uuid references public.profiles (id) on delete set null;

update public.contractor_companies c
set owner_user_id = (
  select p.id
  from public.profiles p
  where p.contractor_company_id = c.id and p.role = 'contractor'
  order by p.created_at, p.id
  limit 1
)
where c.owner_user_id is null;

create table if not exists public.contractor_rate_cards (
  company_id uuid primary key references public.contractor_companies (id) on delete cascade,
  hourly_rate numeric(12, 2) not null check (hourly_rate > 0),
  subsistence_daily_rate numeric(12, 2) not null check (subsistence_daily_rate > 0),
  truck_daily_rate numeric(12, 2) not null check (truck_daily_rate > 0),
  utv_daily_rate numeric(12, 2) not null check (utv_daily_rate > 0),
  atv_daily_rate numeric(12, 2) not null check (atv_daily_rate > 0),
  snowmobile_daily_rate numeric(12, 2) not null check (snowmobile_daily_rate > 0),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

create table if not exists public.contractor_job_assignments (
  company_id uuid not null references public.contractor_companies (id) on delete cascade,
  job_id text not null,
  assigned_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  primary key (company_id, job_id),
  constraint contractor_job_assignments_job_id_nonempty check (length(btrim(job_id)) > 0)
);

create table if not exists public.contractor_company_equipment (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.contractor_companies (id) on delete cascade,
  equipment_type text not null check (equipment_type in ('truck', 'utv', 'atv', 'snowmobile')),
  name text not null,
  serial_number text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, serial_number),
  unique (id, company_id),
  constraint contractor_equipment_name_nonempty check (length(btrim(name)) > 0),
  constraint contractor_equipment_serial_nonempty check (length(btrim(serial_number)) > 0)
);

create table if not exists public.contractor_job_equipment (
  company_id uuid not null,
  job_id text not null,
  equipment_id uuid not null,
  primary key (company_id, job_id, equipment_id),
  foreign key (company_id, job_id)
    references public.contractor_job_assignments (company_id, job_id) on delete cascade,
  foreign key (equipment_id, company_id)
    references public.contractor_company_equipment (id, company_id) on delete cascade
);

create table if not exists public.contractor_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.contractor_companies (id) on delete restrict,
  submitted_by uuid not null references public.profiles (id) on delete restrict,
  job_id text not null,
  invoice_number text not null,
  work_date date not null,
  labor_hours numeric(10, 2) not null default 0 check (labor_hours >= 0),
  subsistence_days numeric(10, 2) not null default 0 check (subsistence_days >= 0),
  equipment_usage jsonb not null default '[]'::jsonb check (jsonb_typeof(equipment_usage) = 'array'),
  rate_snapshot jsonb not null,
  amount numeric(12, 2) not null check (amount > 0),
  notes text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_notes text not null default '',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  constraint contractor_invoice_number_nonempty check (length(btrim(invoice_number)) > 0)
);

create index if not exists contractor_invoices_company_created_idx
  on public.contractor_invoices (company_id, created_at desc);
create index if not exists contractor_invoices_job_work_date_idx
  on public.contractor_invoices (job_id, work_date);

create table if not exists public.contractor_employee_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.contractor_companies (id) on delete cascade,
  invited_email text not null,
  token uuid not null unique default gen_random_uuid(),
  created_by uuid not null references public.profiles (id) on delete restrict,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_user_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint contractor_invite_email_nonempty check (length(btrim(invited_email)) > 0)
);

create index if not exists contractor_employee_invites_company_idx
  on public.contractor_employee_invites (company_id, created_at desc);

alter table public.contractor_rate_cards enable row level security;
alter table public.contractor_job_assignments enable row level security;
alter table public.contractor_company_equipment enable row level security;
alter table public.contractor_job_equipment enable row level security;
alter table public.contractor_invoices enable row level security;
alter table public.contractor_employee_invites enable row level security;

drop policy if exists "Admins manage contractor rate cards" on public.contractor_rate_cards;
create policy "Admins manage contractor rate cards"
  on public.contractor_rate_cards for all to authenticated
  using (public.current_workspace_role() = 'admin')
  with check (public.current_workspace_role() = 'admin');

drop policy if exists "Contractors read their rate card" on public.contractor_rate_cards;
create policy "Contractors read their rate card"
  on public.contractor_rate_cards for select to authenticated
  using (
    company_id = public.current_contractor_company_id()
    and exists (
      select 1 from public.profiles p
      join public.contractor_companies c on c.id = p.contractor_company_id
      where p.id = (select auth.uid())
        and p.role = 'contractor'
        and p.contractor_status = 'active'
        and c.status = 'active'
    )
  );

drop policy if exists "Admins manage contractor job assignments" on public.contractor_job_assignments;
create policy "Admins manage contractor job assignments"
  on public.contractor_job_assignments for all to authenticated
  using (public.current_workspace_role() = 'admin')
  with check (public.current_workspace_role() = 'admin');

drop policy if exists "Contractors read their job assignments" on public.contractor_job_assignments;
create policy "Contractors read their job assignments"
  on public.contractor_job_assignments for select to authenticated
  using (
    company_id = public.current_contractor_company_id()
    and exists (
      select 1 from public.profiles p
      join public.contractor_companies c on c.id = p.contractor_company_id
      where p.id = (select auth.uid())
        and p.role = 'contractor'
        and p.contractor_status = 'active'
        and c.status = 'active'
    )
  );

drop policy if exists "Admins manage contractor company equipment" on public.contractor_company_equipment;
create policy "Admins manage contractor company equipment"
  on public.contractor_company_equipment for all to authenticated
  using (public.current_workspace_role() = 'admin')
  with check (public.current_workspace_role() = 'admin');

drop policy if exists "Contractors read their company equipment" on public.contractor_company_equipment;
create policy "Contractors read their company equipment"
  on public.contractor_company_equipment for select to authenticated
  using (
    company_id = public.current_contractor_company_id()
    and exists (
      select 1 from public.profiles p
      join public.contractor_companies c on c.id = p.contractor_company_id
      where p.id = (select auth.uid())
        and p.role = 'contractor'
        and p.contractor_status = 'active'
        and c.status = 'active'
    )
  );

drop policy if exists "Admins manage contractor job equipment" on public.contractor_job_equipment;
create policy "Admins manage contractor job equipment"
  on public.contractor_job_equipment for all to authenticated
  using (public.current_workspace_role() = 'admin')
  with check (public.current_workspace_role() = 'admin');

drop policy if exists "Contractors read their assigned job equipment" on public.contractor_job_equipment;
create policy "Contractors read their assigned job equipment"
  on public.contractor_job_equipment for select to authenticated
  using (
    company_id = public.current_contractor_company_id()
    and exists (
      select 1 from public.profiles p
      join public.contractor_companies c on c.id = p.contractor_company_id
      where p.id = (select auth.uid())
        and p.role = 'contractor'
        and p.contractor_status = 'active'
        and c.status = 'active'
    )
  );

drop policy if exists "Admins read and review contractor invoices" on public.contractor_invoices;
create policy "Admins read and review contractor invoices"
  on public.contractor_invoices for select to authenticated
  using (public.current_workspace_role() = 'admin');

drop policy if exists "Contractors read their company invoices" on public.contractor_invoices;
create policy "Contractors read their company invoices"
  on public.contractor_invoices for select to authenticated
  using (
    company_id = public.current_contractor_company_id()
    and exists (
      select 1 from public.profiles p
      join public.contractor_companies c on c.id = p.contractor_company_id
      where p.id = (select auth.uid())
        and p.role = 'contractor'
        and p.contractor_status = 'active'
        and c.status = 'active'
    )
  );

drop policy if exists "Admins update contractor invoice reviews" on public.contractor_invoices;
create policy "Admins update contractor invoice reviews"
  on public.contractor_invoices for update to authenticated
  using (public.current_workspace_role() = 'admin')
  with check (public.current_workspace_role() = 'admin');

revoke all on public.contractor_employee_invites from anon, authenticated;
grant select on public.contractor_rate_cards, public.contractor_job_assignments,
  public.contractor_company_equipment, public.contractor_job_equipment,
  public.contractor_invoices to authenticated;
grant update (status, admin_notes, reviewed_at) on public.contractor_invoices to authenticated;

create or replace function public.admin_configure_contractor_workflow(
  p_company_id uuid,
  p_rates jsonb,
  p_job_ids text[],
  p_equipment_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  rate_values numeric[];
  job_id text;
  equipment_id uuid;
begin
  if public.current_workspace_role() <> 'admin' then
    raise exception 'Only workspace admins can configure contractor workflow';
  end if;
  if not exists (select 1 from public.contractor_companies where id = p_company_id) then
    raise exception 'Contractor company not found';
  end if;

  rate_values := array[
    (p_rates ->> 'hourly_rate')::numeric,
    (p_rates ->> 'subsistence_daily_rate')::numeric,
    (p_rates ->> 'truck_daily_rate')::numeric,
    (p_rates ->> 'utv_daily_rate')::numeric,
    (p_rates ->> 'atv_daily_rate')::numeric,
    (p_rates ->> 'snowmobile_daily_rate')::numeric
  ];
  if array_position(rate_values, null) is not null or exists (
    select 1 from unnest(rate_values) as rate(value) where value <= 0
  ) then
    raise exception 'Set a positive price for every contractor rate';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_job_ids, array[]::text[])) selected(job_id)
    where not exists (
      select 1 from public.workspace_state w,
        lateral jsonb_array_elements(coalesce(w.data -> 'jobs', '[]'::jsonb)) j
      where w.id = 'main' and j ->> 'id' = selected.job_id
    )
  ) then
    raise exception 'One or more selected jobs are unavailable';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_equipment_ids, array[]::uuid[])) selected(equipment_id)
    where not exists (
      select 1 from public.contractor_company_equipment e
      where e.id = selected.equipment_id
        and e.company_id = p_company_id
        and e.active
    )
  ) then
    raise exception 'One or more selected equipment items are unavailable';
  end if;

  insert into public.contractor_rate_cards (
    company_id, hourly_rate, subsistence_daily_rate, truck_daily_rate,
    utv_daily_rate, atv_daily_rate, snowmobile_daily_rate, updated_by, updated_at
  ) values (
    p_company_id,
    rate_values[1], rate_values[2], rate_values[3],
    rate_values[4], rate_values[5], rate_values[6],
    (select auth.uid()), now()
  )
  on conflict (company_id) do update set
    hourly_rate = excluded.hourly_rate,
    subsistence_daily_rate = excluded.subsistence_daily_rate,
    truck_daily_rate = excluded.truck_daily_rate,
    utv_daily_rate = excluded.utv_daily_rate,
    atv_daily_rate = excluded.atv_daily_rate,
    snowmobile_daily_rate = excluded.snowmobile_daily_rate,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  delete from public.contractor_job_assignments where company_id = p_company_id;
  foreach job_id in array coalesce(p_job_ids, array[]::text[]) loop
    insert into public.contractor_job_assignments (company_id, job_id, assigned_by)
    values (p_company_id, job_id, (select auth.uid()));
    foreach equipment_id in array coalesce(p_equipment_ids, array[]::uuid[]) loop
      insert into public.contractor_job_equipment (company_id, job_id, equipment_id)
      values (p_company_id, job_id, equipment_id);
    end loop;
  end loop;
end;
$$;

create or replace function public.contractor_assigned_jobs()
returns table (
  job_id text,
  job_name text,
  client text,
  location text,
  start_date date,
  end_date date,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  v_company_id := public.current_contractor_company_id();
  if v_company_id is null or not exists (
    select 1 from public.profiles p
    join public.contractor_companies c on c.id = p.contractor_company_id
    where p.id = (select auth.uid())
      and p.role = 'contractor'
      and p.contractor_status = 'active'
      and c.status = 'active'
  ) then
    raise exception 'Active contractor access is required';
  end if;

  return query
  select
    j ->> 'id',
    coalesce(j ->> 'name', 'Project'),
    coalesce(j ->> 'client', ''),
    coalesce(j ->> 'location', ''),
    coalesce(nullif(j ->> 'startDate', ''), nullif(j ->> 'date', ''))::date,
    coalesce(nullif(j ->> 'endDate', ''), nullif(j ->> 'startDate', ''), nullif(j ->> 'date', ''))::date,
    coalesce(j ->> 'status', 'Scheduled')
  from public.contractor_job_assignments a
  join public.workspace_state w on w.id = 'main'
  cross join lateral jsonb_array_elements(coalesce(w.data -> 'jobs', '[]'::jsonb)) j
  where a.company_id = v_company_id and j ->> 'id' = a.job_id
  order by coalesce(nullif(j ->> 'startDate', ''), nullif(j ->> 'date', ''))::date;
end;
$$;

create or replace function public.submit_contractor_invoice(
  p_job_id text,
  p_invoice_number text,
  p_work_date date,
  p_labor_hours numeric,
  p_subsistence_days numeric,
  p_equipment_usage jsonb,
  p_notes text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  card public.contractor_rate_cards%rowtype;
  usage_item jsonb;
  asset public.contractor_company_equipment%rowtype;
  daily_rate numeric;
  equipment_total numeric := 0;
  labor_total numeric;
  subsistence_total numeric;
  invoice_total numeric;
  normalized_usage jsonb := '[]'::jsonb;
  rate_snapshot jsonb;
  invoice_id uuid;
begin
  v_company_id := public.current_contractor_company_id();
  if v_company_id is null or not exists (
    select 1 from public.profiles p
    join public.contractor_companies c on c.id = p.contractor_company_id
    where p.id = (select auth.uid())
      and p.role = 'contractor'
      and p.contractor_status = 'active'
      and c.status = 'active'
  ) then
    raise exception 'Active contractor access is required';
  end if;
  if length(btrim(coalesce(p_invoice_number, ''))) = 0 or p_work_date is null then
    raise exception 'Invoice number and work date are required';
  end if;
  if coalesce(p_labor_hours, 0) < 0 or coalesce(p_subsistence_days, 0) < 0
     or jsonb_typeof(coalesce(p_equipment_usage, '[]'::jsonb)) <> 'array' then
    raise exception 'Invoice quantities must be valid non-negative values';
  end if;
  if not exists (
    select 1 from public.contractor_job_assignments a
    where a.company_id = v_company_id and a.job_id = p_job_id
  ) then
    raise exception 'Your company is not assigned to this job';
  end if;
  select rc.* into card from public.contractor_rate_cards rc where rc.company_id = v_company_id;
  if not found then
    raise exception 'Your company pricing has not been configured by Fieldwork';
  end if;

  labor_total := coalesce(p_labor_hours, 0) * card.hourly_rate;
  subsistence_total := coalesce(p_subsistence_days, 0) * card.subsistence_daily_rate;
  for usage_item in select value from jsonb_array_elements(coalesce(p_equipment_usage, '[]'::jsonb)) loop
    if not (usage_item ? 'equipment_id') or not (usage_item ? 'days') then
      raise exception 'Equipment invoice items require an asset and rental days';
    end if;
    if (usage_item ->> 'days')::numeric <= 0 then
      raise exception 'Equipment rental days must be greater than zero';
    end if;
    select e.* into asset
    from public.contractor_company_equipment e
    join public.contractor_job_equipment je
      on je.equipment_id = e.id and je.company_id = e.company_id
    where e.id = (usage_item ->> 'equipment_id')::uuid
      and e.company_id = v_company_id
      and e.active
      and je.job_id = p_job_id;
    if not found then
      raise exception 'Selected equipment is not assigned to this job';
    end if;
    daily_rate := case asset.equipment_type
      when 'truck' then card.truck_daily_rate
      when 'utv' then card.utv_daily_rate
      when 'atv' then card.atv_daily_rate
      when 'snowmobile' then card.snowmobile_daily_rate
    end;
    equipment_total := equipment_total + daily_rate * (usage_item ->> 'days')::numeric;
    normalized_usage := normalized_usage || jsonb_build_array(jsonb_build_object(
      'equipment_id', asset.id,
      'equipment_type', asset.equipment_type,
      'name', asset.name,
      'serial_number', asset.serial_number,
      'days', (usage_item ->> 'days')::numeric,
      'daily_rate', daily_rate
    ));
  end loop;
  invoice_total := labor_total + subsistence_total + equipment_total;
  if invoice_total <= 0 then
    raise exception 'Enter labor hours, subsistence days, or assigned equipment';
  end if;

  rate_snapshot := jsonb_build_object(
    'hourly_rate', card.hourly_rate,
    'subsistence_daily_rate', card.subsistence_daily_rate,
    'truck_daily_rate', card.truck_daily_rate,
    'utv_daily_rate', card.utv_daily_rate,
    'atv_daily_rate', card.atv_daily_rate,
    'snowmobile_daily_rate', card.snowmobile_daily_rate,
    'labor_total', labor_total,
    'subsistence_total', subsistence_total,
    'equipment_total', equipment_total
  );
  insert into public.contractor_invoices (
    company_id, submitted_by, job_id, invoice_number, work_date,
    labor_hours, subsistence_days, equipment_usage, rate_snapshot,
    amount, notes
  ) values (
    v_company_id, (select auth.uid()), p_job_id, btrim(p_invoice_number), p_work_date,
    coalesce(p_labor_hours, 0), coalesce(p_subsistence_days, 0),
    normalized_usage, rate_snapshot, invoice_total, coalesce(p_notes, '')
  )
  returning id into invoice_id;
  return invoice_id;
end;
$$;

create or replace function public.create_contractor_employee_invite(p_email text)
returns table (token uuid, invited_email text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  invite_token uuid;
  invitation_expiry timestamptz;
  normalized_email text := lower(btrim(coalesce(p_email, '')));
begin
  v_company_id := public.current_contractor_company_id();
  if v_company_id is null or not exists (
    select 1 from public.profiles p
    join public.contractor_companies c on c.id = p.contractor_company_id
    where p.id = (select auth.uid())
      and p.role = 'contractor'
      and p.contractor_status = 'active'
      and c.status = 'active'
      and c.owner_user_id = (select auth.uid())
  ) then
    raise exception 'Only the approved primary contractor user can invite employees';
  end if;
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'Enter a valid employee email address';
  end if;
  if exists (
    select 1 from public.profiles p
    where lower(p.email) = normalized_email
  ) then
    raise exception 'This email already has a Fieldwork account';
  end if;
  if exists (
    select 1 from public.contractor_employee_invites i
    where i.company_id = v_company_id
      and lower(i.invited_email) = normalized_email
      and i.accepted_user_id is null
      and i.expires_at > now()
  ) then
    raise exception 'An unexpired invitation already exists for this email';
  end if;
  insert into public.contractor_employee_invites (company_id, invited_email, created_by)
  values (v_company_id, normalized_email, (select auth.uid()))
  returning contractor_employee_invites.token, contractor_employee_invites.expires_at
    into invite_token, invitation_expiry;
  return query select invite_token, normalized_email, invitation_expiry;
end;
$$;

create or replace function public.admin_update_contractor_invoice(
  p_invoice_id uuid,
  p_status text,
  p_admin_notes text default ''
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.current_workspace_role() <> 'admin' then
    raise exception 'Only workspace admins can review contractor invoices';
  end if;
  if p_status not in ('approved', 'rejected') then
    raise exception 'Invoice review status must be approved or rejected';
  end if;
  update public.contractor_invoices
  set status = p_status, admin_notes = coalesce(p_admin_notes, ''), reviewed_at = now()
  where id = p_invoice_id;
  if not found then
    raise exception 'Contractor invoice not found';
  end if;
end;
$$;

create or replace function public.workspace_contractor_crew_members()
returns table (
  company_id uuid,
  company_name text,
  user_id uuid,
  full_name text,
  email text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.current_workspace_role() not in ('admin', 'manager') then
    raise exception 'Only workspace staff can load contractor crew members';
  end if;

  return query
  select c.id, c.name, p.id, p.full_name, p.email
  from public.contractor_companies c
  join public.profiles p on p.contractor_company_id = c.id
  where c.status = 'active'
    and p.role = 'contractor'
    and p.contractor_status = 'active'
  order by c.name, p.full_name, p.email;
end;
$$;

revoke all on function public.admin_configure_contractor_workflow(uuid, jsonb, text[], uuid[]) from public;
revoke all on function public.contractor_assigned_jobs() from public;
revoke all on function public.submit_contractor_invoice(text, text, date, numeric, numeric, jsonb, text) from public;
revoke all on function public.create_contractor_employee_invite(text) from public;
revoke all on function public.admin_update_contractor_invoice(uuid, text, text) from public;
revoke all on function public.workspace_contractor_crew_members() from public;
grant execute on function public.admin_configure_contractor_workflow(uuid, jsonb, text[], uuid[]) to authenticated;
grant execute on function public.contractor_assigned_jobs() to authenticated;
grant execute on function public.submit_contractor_invoice(text, text, date, numeric, numeric, jsonb, text) to authenticated;
grant execute on function public.create_contractor_employee_invite(text) to authenticated;
grant execute on function public.admin_update_contractor_invoice(uuid, text, text) to authenticated;
grant execute on function public.workspace_contractor_crew_members() to authenticated;

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
  invitation public.contractor_employee_invites%rowtype;
  invite_token_text text;
begin
  requested_type := new.raw_user_meta_data ->> 'account_type';
  if requested_type = 'contractor' then
    invite_token_text := new.raw_user_meta_data ->> 'contractor_invite_token';
    if invite_token_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into invitation
      from public.contractor_employee_invites i
      where i.token = invite_token_text::uuid
        and i.accepted_user_id is null
        and i.expires_at > now()
        and lower(i.invited_email) = lower(new.email)
      for update;
      if not found then
        raise exception 'This employee invitation is invalid, expired, or for a different email';
      end if;
      insert into public.profiles (
        id, email, full_name, role, contractor_company_id, contractor_status,
        phone, job_title
      ) values (
        new.id, new.email,
        coalesce(new.raw_user_meta_data ->> 'full_name', ''),
        'contractor', invitation.company_id, 'pending',
        coalesce(new.raw_user_meta_data ->> 'phone', ''),
        coalesce(new.raw_user_meta_data ->> 'job_title', '')
      );
      update public.contractor_employee_invites
      set accepted_user_id = new.id
      where id = invitation.id and accepted_user_id is null;
      if not found then
        raise exception 'This employee invitation has already been used';
      end if;
      return new;
    end if;

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
    if matched_company_id is not null then
      raise exception 'A contractor company with this name already exists. Ask its primary user for an employee invitation link.';
    end if;

    insert into public.contractor_companies (
      name, gst_number, business_phone, business_address
    ) values (
      requested_company, requested_gst, requested_business_phone, requested_business_address
    )
    returning id into matched_company_id;

    insert into public.profiles (
      id, email, full_name, role, contractor_company_id, contractor_status,
      phone, job_title
    ) values (
      new.id, new.email,
      coalesce(new.raw_user_meta_data ->> 'full_name', ''),
      'contractor', matched_company_id, 'pending',
      coalesce(new.raw_user_meta_data ->> 'phone', ''),
      coalesce(new.raw_user_meta_data ->> 'job_title', '')
    );
    update public.contractor_companies
    set owner_user_id = new.id
    where id = matched_company_id;
  else
    insert into public.profiles (id, email, full_name, role, contractor_status, phone, job_title)
    values (
      new.id, new.email,
      coalesce(new.raw_user_meta_data ->> 'full_name', ''),
      'pending', 'not_applicable',
      coalesce(new.raw_user_meta_data ->> 'phone', ''),
      coalesce(new.raw_user_meta_data ->> 'job_title', '')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_fieldwork on auth.users;
create trigger on_auth_user_created_fieldwork
  after insert on auth.users
  for each row execute procedure public.set_profile_from_auth_user();

do $$
declare
  table_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array['profiles', 'contractor_companies', 'contractor_invoices', 'contractor_job_assignments', 'contractor_company_equipment', 'contractor_job_equipment', 'contractor_rate_cards'] loop
      if not exists (
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
