-- Isolate AD dispatch rosters/cursors from the existing Qianchuan/local-promo roster.
-- Existing rows remain in scope='default'; AD uses scope='ad'.
begin;

alter table public.bess_dispatch_daily_state
  add column if not exists scope text not null default 'default';
alter table public.bess_dispatch_assignments
  add column if not exists scope text not null default 'default';

alter table public.bess_dispatch_daily_state
  drop constraint if exists bess_dispatch_daily_state_scope_check;
alter table public.bess_dispatch_daily_state
  add constraint bess_dispatch_daily_state_scope_check check (scope in ('default', 'ad'));
alter table public.bess_dispatch_assignments
  drop constraint if exists bess_dispatch_assignments_scope_check;
alter table public.bess_dispatch_assignments
  add constraint bess_dispatch_assignments_scope_check check (scope in ('default', 'ad'));

alter table public.bess_dispatch_assignments
  drop constraint if exists bess_dispatch_assignments_direction_check;
alter table public.bess_dispatch_assignments
  add constraint bess_dispatch_assignments_direction_check
  check (direction in ('forward', 'reverse', 'specified'));

-- Drop the old day-only FK/uniqueness contracts by their actual definitions.
do $drop_old_assignment_constraints$
declare
  item record;
begin
  for item in
    select c.conname
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.bess_dispatch_assignments'::regclass
       and c.contype in ('f', 'u')
       and pg_catalog.pg_get_constraintdef(c.oid) in (
         'FOREIGN KEY (day_key) REFERENCES bess_dispatch_daily_state(day_key) ON DELETE CASCADE',
         'UNIQUE (day_key, request_id)'
       )
  loop
    execute format('alter table public.bess_dispatch_assignments drop constraint %I', item.conname);
  end loop;
end
$drop_old_assignment_constraints$;

do $drop_old_state_key$
declare
  item record;
begin
  for item in
    select c.conname
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.bess_dispatch_daily_state'::regclass
       and c.contype = 'p'
       and pg_catalog.pg_get_constraintdef(c.oid) = 'PRIMARY KEY (day_key)'
  loop
    execute format('alter table public.bess_dispatch_daily_state drop constraint %I', item.conname);
  end loop;
end
$drop_old_state_key$;

do $add_scoped_constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = 'public.bess_dispatch_daily_state'::regclass and c.contype = 'p'
       and pg_catalog.pg_get_constraintdef(c.oid) = 'PRIMARY KEY (day_key, scope)'
  ) then
    alter table public.bess_dispatch_daily_state
      add constraint bess_dispatch_daily_state_pkey primary key (day_key, scope);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = 'public.bess_dispatch_assignments'::regclass and c.contype = 'u'
       and pg_catalog.pg_get_constraintdef(c.oid) = 'UNIQUE (day_key, scope, request_id)'
  ) then
    alter table public.bess_dispatch_assignments
      add constraint bess_dispatch_assignments_day_scope_request_key unique (day_key, scope, request_id);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = 'public.bess_dispatch_assignments'::regclass and c.contype = 'f'
       and pg_catalog.pg_get_constraintdef(c.oid) = 'FOREIGN KEY (day_key, scope) REFERENCES bess_dispatch_daily_state(day_key, scope) ON DELETE CASCADE'
  ) then
    alter table public.bess_dispatch_assignments
      add constraint bess_dispatch_assignments_day_scope_fkey
      foreign key (day_key, scope)
      references public.bess_dispatch_daily_state(day_key, scope) on delete cascade;
  end if;
end
$add_scoped_constraints$;

create or replace function public.bess_assign_next(
  p_day_key date,
  p_scope text,
  p_request_id text,
  p_direction text,
  p_roster jsonb default null,
  p_expires_at timestamptz default null,
  p_context jsonb default '{}'::jsonb
) returns table (
  assignee text,
  roster jsonb,
  direction text,
  replayed boolean,
  original_message_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.bess_dispatch_daily_state%rowtype;
  v_existing public.bess_dispatch_assignments%rowtype;
  v_count integer;
  v_index bigint;
  v_anchor_index bigint;
  v_original_message_id text;
  v_i integer;
begin
  if p_day_key is null then
    raise exception using errcode = '22004', message = 'day key required';
  end if;
  if p_scope is null or p_scope not in ('default', 'ad') then
    raise exception using errcode = '22023', message = 'invalid dispatch scope';
  end if;
  if p_request_id is null or btrim(p_request_id) = '' then
    raise exception using errcode = '22023', message = 'request id required';
  end if;
  if p_direction is null or p_direction not in ('forward', 'reverse') then
    raise exception using errcode = '22023', message = 'invalid direction';
  end if;

  if p_roster is not null then
    if p_expires_at is null or p_expires_at <= now() then
      raise exception using errcode = '22023', message = 'future expiry required for roster initialization';
    end if;
    if jsonb_typeof(p_roster) <> 'array' or jsonb_array_length(p_roster) = 0 then
      raise exception using errcode = '22023', message = 'invalid roster';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_roster) as item(value)
       where jsonb_typeof(item.value) <> 'string' or btrim(item.value #>> '{}') = ''
    ) then
      raise exception using errcode = '22023', message = 'roster entries must be non-empty strings';
    end if;
    insert into public.bess_dispatch_daily_state(day_key, scope, roster, expires_at)
    values (p_day_key, p_scope, p_roster, p_expires_at)
    on conflict (day_key, scope) do nothing;
  end if;

  select state.* into v_state
    from public.bess_dispatch_daily_state as state
   where state.day_key = p_day_key and state.scope = p_scope and state.expires_at > now()
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'daily roster is not initialized or expired';
  end if;
  if jsonb_typeof(v_state.roster) <> 'array' or jsonb_array_length(v_state.roster) = 0
     or exists (
       select 1 from jsonb_array_elements(v_state.roster) as item(value)
        where jsonb_typeof(item.value) <> 'string' or btrim(item.value #>> '{}') = ''
     ) then
    raise exception using errcode = '22023', message = 'stored roster is invalid';
  end if;

  select pending.original_message_id into v_original_message_id
    from public.bess_dispatch_pending_forms as pending
   where pending.request_id = p_request_id
   order by pending.created_at desc limit 1;

  select assignment.* into v_existing
    from public.bess_dispatch_assignments as assignment
   where assignment.day_key = p_day_key and assignment.scope = p_scope
     and assignment.request_id = p_request_id;
  if found then
    return query select v_existing.assignee, v_state.roster, v_existing.direction, true, v_original_message_id;
    return;
  end if;

  v_count := jsonb_array_length(v_state.roster);
  select item.ordinality - 1 into v_anchor_index
    from jsonb_array_elements_text(v_state.roster) with ordinality as item(value, ordinality)
   where btrim(item.value) = nullif(btrim(p_context ->> 'anchor_assignee'), '') limit 1;
  if v_anchor_index is not null then
    if p_direction = 'forward' then v_index := (v_anchor_index + 1) % v_count;
    else v_index := (v_anchor_index - 1 + v_count) % v_count; end if;
  elsif p_direction = 'forward' then v_index := v_state.forward_cursor % v_count;
  else v_index := v_count - 1 - (v_state.reverse_cursor % v_count); end if;

  for v_i in 0..v_count-1 loop
    assignee := btrim(v_state.roster ->> v_index::integer);
    if not (v_state.off_duty ? assignee) then exit; end if;
    if p_direction = 'forward' then v_index := (v_index + 1) % v_count;
    else v_index := (v_index - 1 + v_count) % v_count; end if;
    if v_i = v_count - 1 then raise exception using errcode = 'P0001', message = 'ALL_OFF_DUTY'; end if;
  end loop;

  update public.bess_dispatch_daily_state as state
     set forward_cursor = v_index + 1, reverse_cursor = v_count - v_index, updated_at = now()
   where state.day_key = p_day_key and state.scope = p_scope;
  roster := v_state.roster;
  direction := p_direction;
  replayed := false;
  original_message_id := v_original_message_id;
  insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, request_context)
  values (p_day_key, p_scope, p_request_id, assignee, p_direction, coalesce(p_context, '{}'::jsonb));
  return next;
end;
$$;

create or replace function public.bess_update_roster_status(
  p_day_key date,
  p_scope text,
  p_off_duty jsonb,
  p_expected_version bigint
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
begin
  return query
    update public.bess_dispatch_daily_state as state
       set off_duty = p_off_duty, version = state.version + 1, updated_at = now()
     where state.day_key = p_day_key and state.scope = p_scope
       and state.version = p_expected_version
     returning state.*;
end;
$$;

create or replace function public.bess_calibrate_cursor(
  p_day_key date,
  p_scope text,
  p_assignee text,
  p_roster jsonb
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_state public.bess_dispatch_daily_state%rowtype;
  v_index integer;
  v_count integer;
begin
  select * into v_state from public.bess_dispatch_daily_state as state
   where state.day_key = p_day_key and state.scope = p_scope and state.expires_at > now()
   for update;
  if not found then raise exception 'DAILY_STATE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_roster is null or jsonb_typeof(p_roster) <> 'array' or p_roster <> v_state.roster then
    raise exception 'ROSTER_CHANGED' using errcode = 'P0001';
  end if;
  select item.ordinality - 1 into v_index
    from jsonb_array_elements_text(v_state.roster) with ordinality as item(value, ordinality)
   where btrim(item.value) = nullif(btrim(p_assignee), '') limit 1;
  if v_index is null then raise exception 'ASSIGNEE_NOT_IN_ROSTER' using errcode = 'P0001'; end if;
  v_count := jsonb_array_length(v_state.roster);
  return query
    update public.bess_dispatch_daily_state as state
       set forward_cursor = v_index + 1, reverse_cursor = v_count - v_index, updated_at = now()
     where state.day_key = p_day_key and state.scope = p_scope
     returning state.*;
end;
$$;

create or replace function public.bess_assign_specific(
  p_day_key date,
  p_scope text,
  p_request_id text,
  p_assignee text,
  p_context jsonb default '{}'::jsonb
) returns table (assignee text, replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_state public.bess_dispatch_daily_state%rowtype;
  v_existing public.bess_dispatch_assignments%rowtype;
begin
  if p_scope is null or p_scope not in ('default', 'ad') then
    raise exception using errcode = '22023', message = 'invalid dispatch scope';
  end if;
  if p_request_id is null or btrim(p_request_id) = '' or p_assignee is null or btrim(p_assignee) = '' then
    raise exception using errcode = '22023', message = 'request id and assignee required';
  end if;
  select state.* into v_state from public.bess_dispatch_daily_state as state
   where state.day_key = p_day_key and state.scope = p_scope and state.expires_at > now()
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'daily roster is not initialized or expired';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(v_state.roster) as item(value) where btrim(item.value) = btrim(p_assignee))
     or v_state.off_duty ? btrim(p_assignee) then
    raise exception using errcode = '22023', message = 'assignee is not on duty in this scope';
  end if;
  select assignment.* into v_existing from public.bess_dispatch_assignments assignment
   where assignment.day_key = p_day_key and assignment.scope = p_scope
     and assignment.request_id = p_request_id;
  if found then
    return query select v_existing.assignee, true;
    return;
  end if;
  insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, request_context)
  values (p_day_key, p_scope, p_request_id, btrim(p_assignee), 'specified', coalesce(p_context, '{}'::jsonb));
  return query select btrim(p_assignee), false;
end;
$$;

-- Scope-aware RPCs are a coordinated cutover: pause dispatch, apply this
-- migration, deploy the matching application, then resume dispatch. Old
-- unscoped callers are intentionally revoked to prevent cross-scope reads.

revoke all on function public.bess_assign_next(date,text,text,jsonb,timestamptz,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb) to service_role;
revoke all on function public.bess_update_roster_status(date,jsonb,bigint) from public, anon, authenticated, service_role;
revoke all on function public.bess_update_roster_status(date,text,jsonb,bigint) from public, anon, authenticated, service_role;
grant execute on function public.bess_update_roster_status(date,text,jsonb,bigint) to service_role;
revoke all on function public.bess_calibrate_cursor(date,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.bess_calibrate_cursor(date,text,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.bess_calibrate_cursor(date,text,text,jsonb) to service_role;

revoke all on function public.bess_assign_specific(date,text,text,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.bess_assign_specific(date,text,text,text,jsonb) to service_role;

commit;
