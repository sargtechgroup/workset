-- Apply after supabase-setup.sql and supabase-profile-safety.sql.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('pending', 'manager', 'admin', 'contractor', 'foreman'));

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

drop policy if exists "Workspace managers read foreman profiles" on public.profiles;
create policy "Workspace managers read foreman profiles"
  on public.profiles for select to authenticated
  using (
    role = 'foreman'
    and public.current_workspace_role() in ('admin', 'manager')
  );

create or replace function public.foreman_workspace_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  workspace_data jsonb;
  assigned_job_ids text[];
begin
  if public.current_workspace_role() is distinct from 'foreman' then
    raise exception 'Foreman access is required';
  end if;

  select data into workspace_data
  from public.workspace_state
  where id = 'main';

  if not found then
    workspace_data := '{}'::jsonb;
  end if;

  select coalesce(array_agg(job ->> 'id'), '{}'::text[])
  into assigned_job_ids
  from jsonb_array_elements(coalesce(workspace_data -> 'jobs', '[]'::jsonb)) as jobs(job)
  where job ->> 'foremanUserId' = (select auth.uid())::text
    and nullif(job ->> 'id', '') is not null;

  return jsonb_build_object(
    'jobs',
    coalesce((
      select jsonb_agg(job)
      from jsonb_array_elements(coalesce(workspace_data -> 'jobs', '[]'::jsonb)) as jobs(job)
      where job ->> 'id' = any(assigned_job_ids)
    ), '[]'::jsonb),
    'tasks',
    coalesce((
      select jsonb_agg(jsonb_set(task, '{jobIds}', matched_job_ids.job_ids, true))
      from jsonb_array_elements(coalesce(workspace_data -> 'tasks', '[]'::jsonb)) as tasks(task)
      cross join lateral (
        select coalesce(jsonb_agg(to_jsonb(job_id)), '[]'::jsonb) as job_ids
        from jsonb_array_elements_text(coalesce(task -> 'jobIds', '[]'::jsonb)) as task_jobs(job_id)
        where job_id = any(assigned_job_ids)
      ) as matched_job_ids
      where jsonb_array_length(matched_job_ids.job_ids) > 0
    ), '[]'::jsonb),
    'people',
    coalesce((
      select jsonb_agg(jsonb_set(person, '{jobIds}', matched_job_ids.job_ids, true))
      from jsonb_array_elements(coalesce(workspace_data -> 'people', '[]'::jsonb)) as people(person)
      cross join lateral (
        select coalesce(jsonb_agg(to_jsonb(job_id)), '[]'::jsonb) as job_ids
        from jsonb_array_elements_text(coalesce(person -> 'jobIds', '[]'::jsonb)) as person_jobs(job_id)
        where job_id = any(assigned_job_ids)
      ) as matched_job_ids
      where jsonb_array_length(matched_job_ids.job_ids) > 0
    ), '[]'::jsonb),
    'safety',
    coalesce((
      select jsonb_agg(form)
      from jsonb_array_elements(coalesce(workspace_data -> 'safety', '[]'::jsonb)) as safety_forms(form)
      where form ->> 'jobId' = any(assigned_job_ids)
    ), '[]'::jsonb),
    'timesheets',
    coalesce((
      select jsonb_agg(entry)
      from jsonb_array_elements(coalesce(workspace_data -> 'timesheets', '[]'::jsonb)) as timesheets(entry)
      where entry ->> 'jobId' = any(assigned_job_ids)
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.foreman_workspace_data() from public;
grant execute on function public.foreman_workspace_data() to authenticated;
