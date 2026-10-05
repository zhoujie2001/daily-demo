-- Split the legacy AD dispatch lane into independently advancing review/game lanes.
-- The legacy scope='ad' remains a rollback shadow: roster/off-duty/assignments
-- are synchronized, while cursor-based legacy writes fail closed because one
-- legacy cursor cannot represent two independent lanes. New code never reads it.
begin;

alter table public.bess_dispatch_daily_state drop constraint if exists bess_dispatch_daily_state_scope_check;
alter table public.bess_dispatch_daily_state add constraint bess_dispatch_daily_state_scope_check
  check (scope in ('default', 'ad', 'ad_review', 'ad_game'));
alter table public.bess_dispatch_assignments drop constraint if exists bess_dispatch_assignments_scope_check;
alter table public.bess_dispatch_assignments add constraint bess_dispatch_assignments_scope_check
  check (scope in ('default', 'ad', 'ad_review', 'ad_game'));

create table if not exists public.bess_dispatch_person_status (
  day_key date not null,
  person_name text not null check (btrim(person_name) <> ''),
  off_duty boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (day_key, person_name)
);
alter table public.bess_dispatch_person_status enable row level security;
alter table public.bess_dispatch_person_status force row level security;
drop policy if exists bess_dispatch_service_role_only on public.bess_dispatch_person_status;
create policy bess_dispatch_service_role_only
  on public.bess_dispatch_person_status
  for all
  to service_role
  using (true)
  with check (true);
revoke all on table public.bess_dispatch_person_status from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.bess_dispatch_person_status to service_role;

-- A legacy AD row is copied twice only as an initial snapshot. The two rows have
-- distinct keys and all later cursor/calibration writes address exactly one row.
insert into public.bess_dispatch_daily_state(
  day_key, scope, roster, forward_cursor, reverse_cursor, off_duty, version,
  expires_at, created_at, updated_at
)
select day_key, target.scope, roster, forward_cursor, reverse_cursor, off_duty,
       version, expires_at, created_at, updated_at
  from public.bess_dispatch_daily_state legacy
 cross join (values ('ad_review'::text), ('ad_game'::text)) as target(scope)
 where legacy.scope = 'ad'
on conflict (day_key, scope) do nothing;

insert into public.bess_dispatch_person_status(day_key, person_name, off_duty, updated_at)
select legacy.day_key, item.value, true, legacy.updated_at
  from public.bess_dispatch_daily_state legacy
 cross join lateral jsonb_array_elements_text(legacy.off_duty) item(value)
 where legacy.scope = 'ad'
on conflict (day_key, person_name) do nothing;

-- Migrate idempotency only when category and the complete sheet contract agree.
-- Contradictory, partial and category-less records remain in legacy ad.
with legacy_contract as (
  select a.*,
         lower(coalesce(a.request_context ->> 'targetCategory', a.request_context ->> 'target_category', '')) as category,
         coalesce(a.request_context ->> 'sheetId', a.request_context ->> 'sheet_id', '') as sheet_id,
         upper(coalesce(a.request_context ->> 'dateFieldId', a.request_context ->> 'date_field_id', '')) as date_field_id,
         upper(coalesce(a.request_context ->> 'assigneeFieldId', a.request_context ->> 'assignee_field_id', '')) as assignee_field_id
    from public.bess_dispatch_assignments a
   where a.scope = 'ad'
), eligible as (
  select legacy_contract.*,
         case when category = 'game_agent' then 'ad_game' else 'ad_review' end as target_scope
    from legacy_contract
   where (
     category in ('ad', 'game_agent')
     and sheet_id <> '' and sheet_id <> '288afd'
     and date_field_id = 'J' and assignee_field_id = 'B'
   ) or (
     category in ('qianchuan_ad', 'ehc_emergency_ad')
     and sheet_id = '288afd'
     and date_field_id = 'A' and assignee_field_id = 'F'
   )
)
insert into public.bess_dispatch_assignments(
  day_key, scope, request_id, assignee, direction, request_context, created_at
)
select day_key, target_scope, request_id, assignee, direction, request_context, created_at
  from eligible
on conflict (day_key, scope, request_id) do nothing;

create or replace function public.bess_sync_legacy_ad_shadow(p_day_key date)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_review public.bess_dispatch_daily_state%rowtype;
  v_game public.bess_dispatch_daily_state%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rollback_shadow'));
  select state.* into v_review from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope = 'ad_review' for update;
  select state.* into v_game from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope = 'ad_game' for update;
  if v_review.day_key is null or v_game.day_key is null then return; end if;
  if v_review.roster <> v_game.roster then
    raise exception using errcode = 'P0001', message = 'AD_ROSTER_DIVERGED';
  end if;
  insert into public.bess_dispatch_daily_state(
    day_key, scope, roster, forward_cursor, reverse_cursor, off_duty, version, expires_at
  ) values (
    p_day_key, 'ad', v_review.roster, 0, 0, v_review.off_duty,
    greatest(v_review.version, v_game.version), greatest(v_review.expires_at, v_game.expires_at)
  )
  on conflict (day_key, scope) do update
    set roster = excluded.roster,
        off_duty = excluded.off_duty,
        version = greatest(bess_dispatch_daily_state.version, excluded.version),
        expires_at = excluded.expires_at,
        updated_at = now();
end;
$$;

create or replace function public.bess_initialize_ad_rosters(
  p_day_key date,
  p_roster jsonb,
  p_expires_at timestamptz
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.bess_dispatch_daily_state%rowtype;
  v_off_duty jsonb;
begin
  if p_day_key is null or p_expires_at is null or p_expires_at <= now()
     or jsonb_typeof(p_roster) <> 'array' or jsonb_array_length(p_roster) = 0
     or exists (select 1 from jsonb_array_elements(p_roster) item(value)
                 where jsonb_typeof(item.value) <> 'string' or btrim(item.value #>> '{}') = '') then
    raise exception using errcode = '22023', message = 'invalid AD roster initialization';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rosters'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rollback_shadow'));
  select state.* into v_existing
    from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope in ('ad_review', 'ad_game')
   order by state.scope limit 1 for update;
  if found and v_existing.roster <> p_roster then
    raise exception using errcode = 'P0001', message = 'ROSTER_CHANGED';
  end if;
  if exists (
    select 1 from public.bess_dispatch_daily_state state
     where state.day_key = p_day_key and state.scope in ('ad_review', 'ad_game')
       and state.roster <> p_roster
  ) then
    raise exception using errcode = 'P0001', message = 'AD_ROSTER_DIVERGED';
  end if;
  select coalesce(jsonb_agg(status.person_name order by status.person_name), '[]'::jsonb)
    into v_off_duty
    from public.bess_dispatch_person_status status
   where status.day_key = p_day_key and status.off_duty;
  insert into public.bess_dispatch_daily_state(
    day_key, scope, roster, forward_cursor, reverse_cursor, off_duty, version, expires_at
  )
  select p_day_key, lane.scope, p_roster, 0, 0, v_off_duty, 1, p_expires_at
    from (values ('ad_review'::text), ('ad_game'::text)) lane(scope)
  on conflict (day_key, scope) do nothing;
  perform public.bess_sync_legacy_ad_shadow(p_day_key);
  return query select state.* from public.bess_dispatch_daily_state state
    where state.day_key = p_day_key and state.scope in ('ad_review', 'ad_game') order by state.scope;
end;
$$;

create or replace function public.bess_replace_ad_rosters(
  p_day_key date,
  p_roster jsonb,
  p_expected_review_version bigint,
  p_expected_game_version bigint
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
begin
  if jsonb_typeof(p_roster) <> 'array' or jsonb_array_length(p_roster) = 0
     or exists (select 1 from jsonb_array_elements(p_roster) item(value)
                 where jsonb_typeof(item.value) <> 'string' or btrim(item.value #>> '{}') = '') then
    raise exception using errcode = '22023', message = 'invalid AD roster';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rosters'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rollback_shadow'));
  perform 1 from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope in ('ad_review', 'ad_game') for update;
  if (select count(*) from public.bess_dispatch_daily_state state
       where state.day_key = p_day_key and (
         (state.scope = 'ad_review' and state.version = p_expected_review_version)
         or (state.scope = 'ad_game' and state.version = p_expected_game_version)
       )) <> 2 then
    raise exception using errcode = '40001', message = 'AD_ROSTER_UPDATE_CONFLICT';
  end if;
  update public.bess_dispatch_daily_state state
     set roster = p_roster,
         off_duty = coalesce((
           select jsonb_agg(item.value order by item.ordinality)
             from jsonb_array_elements_text(p_roster) with ordinality item(value, ordinality)
            where exists (select 1 from public.bess_dispatch_person_status status
                           where status.day_key = p_day_key and status.person_name = item.value and status.off_duty)
         ), '[]'::jsonb),
         version = state.version + 1,
         updated_at = now()
   where state.day_key = p_day_key and state.scope in ('ad_review', 'ad_game');
  perform public.bess_sync_legacy_ad_shadow(p_day_key);
  return query select state.* from public.bess_dispatch_daily_state state
    where state.day_key = p_day_key and state.scope in ('ad_review', 'ad_game') order by state.scope;
end;
$$;

create or replace function public.bess_assign_next(
  p_day_key date, p_scope text, p_request_id text, p_direction text,
  p_roster jsonb default null, p_expires_at timestamptz default null,
  p_context jsonb default '{}'::jsonb
) returns table (assignee text, roster jsonb, direction text, replayed boolean, original_message_id text)
language plpgsql security definer set search_path = '' as $$
declare
  v_state public.bess_dispatch_daily_state%rowtype;
  v_existing public.bess_dispatch_assignments%rowtype;
  v_count integer; v_index bigint; v_anchor_index bigint; v_i integer;
begin
  if p_scope is null or p_scope not in ('default', 'ad', 'ad_review', 'ad_game') then
    raise exception using errcode = '22023', message = 'invalid dispatch scope';
  end if;
  if p_scope = 'ad' then
    raise exception using errcode = 'P0001', message = 'LEGACY_AD_CURSOR_UNREPRESENTABLE';
  end if;
  if p_request_id is null or btrim(p_request_id) = '' or p_direction not in ('forward', 'reverse') then
    raise exception using errcode = '22023', message = 'invalid assignment arguments';
  end if;
  if p_roster is not null then
    if p_scope in ('ad_review', 'ad_game') then
      perform * from public.bess_initialize_ad_rosters(p_day_key, p_roster, p_expires_at);
    else
      insert into public.bess_dispatch_daily_state(day_key, scope, roster, expires_at)
      values (p_day_key, p_scope, p_roster, p_expires_at)
      on conflict (day_key, scope) do nothing;
    end if;
  end if;
  if p_scope in ('ad_review', 'ad_game') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rollback_shadow'));
  end if;
  select state.* into v_state from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope = p_scope and state.expires_at > now() for update;
  if not found then raise exception using errcode = 'P0002', message = 'daily roster is not initialized or expired'; end if;
  select assignment.* into v_existing from public.bess_dispatch_assignments assignment
   where assignment.day_key = p_day_key and assignment.scope = p_scope and assignment.request_id = p_request_id;
  if found then
    if p_scope in ('ad_review', 'ad_game') then
      perform public.bess_sync_legacy_ad_shadow(p_day_key);
      insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, request_context, created_at)
      values (p_day_key, 'ad', p_request_id, v_existing.assignee, v_existing.direction,
              v_existing.request_context, v_existing.created_at)
      on conflict (day_key, scope, request_id) do update
        set assignee = excluded.assignee, direction = excluded.direction, request_context = excluded.request_context;
    end if;
    return query select v_existing.assignee, v_state.roster, v_existing.direction, true,
      (select pending.original_message_id from public.bess_dispatch_pending_forms pending
        where pending.request_id = p_request_id order by pending.created_at desc limit 1);
    return;
  end if;
  v_count := jsonb_array_length(v_state.roster);
  if v_count < 1 then raise exception using errcode = '22023', message = 'stored roster is invalid'; end if;
  select item.ordinality - 1 into v_anchor_index
    from jsonb_array_elements_text(v_state.roster) with ordinality item(value, ordinality)
   where btrim(item.value) = nullif(btrim(p_context ->> 'anchor_assignee'), '') limit 1;
  if v_anchor_index is not null then
    v_index := case when p_direction = 'forward' then (v_anchor_index + 1) % v_count
                    else (v_anchor_index - 1 + v_count) % v_count end;
  elsif p_direction = 'forward' then v_index := v_state.forward_cursor % v_count;
  else v_index := v_count - 1 - (v_state.reverse_cursor % v_count); end if;
  for v_i in 0..v_count-1 loop
    assignee := btrim(v_state.roster ->> v_index::integer);
    if p_scope in ('ad_review', 'ad_game') then
      exit when not exists (select 1 from public.bess_dispatch_person_status status
        where status.day_key = p_day_key and status.person_name = assignee and status.off_duty);
    else
      exit when not (v_state.off_duty ? assignee);
    end if;
    v_index := case when p_direction = 'forward' then (v_index + 1) % v_count
                    else (v_index - 1 + v_count) % v_count end;
    if v_i = v_count - 1 then raise exception using errcode = 'P0001', message = 'ALL_OFF_DUTY'; end if;
  end loop;
  if p_direction = 'forward' then
    update public.bess_dispatch_daily_state state set forward_cursor = v_index + 1, updated_at = now()
     where state.day_key = p_day_key and state.scope = p_scope;
  else
    update public.bess_dispatch_daily_state state set reverse_cursor = v_count - v_index, updated_at = now()
     where state.day_key = p_day_key and state.scope = p_scope;
  end if;
  roster := v_state.roster; direction := p_direction; replayed := false;
  select pending.original_message_id into original_message_id from public.bess_dispatch_pending_forms pending
    where pending.request_id = p_request_id order by pending.created_at desc limit 1;
  insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, request_context)
  values (p_day_key, p_scope, p_request_id, assignee, p_direction, coalesce(p_context, '{}'::jsonb));
  if p_scope in ('ad_review', 'ad_game') then
    perform public.bess_sync_legacy_ad_shadow(p_day_key);
    insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, request_context)
    values (p_day_key, 'ad', p_request_id, assignee, p_direction, coalesce(p_context, '{}'::jsonb))
    on conflict (day_key, scope, request_id) do update
      set assignee = excluded.assignee, direction = excluded.direction, request_context = excluded.request_context;
  end if;
  return next;
end;
$$;

create or replace function public.bess_assign_specific(
  p_day_key date, p_scope text, p_request_id text, p_assignee text,
  p_context jsonb default '{}'::jsonb
) returns table (assignee text, replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_state public.bess_dispatch_daily_state%rowtype;
  v_existing public.bess_dispatch_assignments%rowtype;
begin
  if p_scope not in ('default', 'ad', 'ad_review', 'ad_game') then
    raise exception using errcode = '22023', message = 'invalid dispatch scope';
  end if;
  if p_scope in ('ad_review', 'ad_game') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rollback_shadow'));
  end if;
  select state.* into v_state from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope = p_scope and state.expires_at > now() for update;
  if not found then raise exception using errcode = 'P0002', message = 'daily roster is not initialized or expired'; end if;
  if not exists (select 1 from jsonb_array_elements_text(v_state.roster) item(value)
                  where btrim(item.value) = btrim(p_assignee)) then
    raise exception using errcode = '22023', message = 'assignee is not in roster';
  end if;
  if (p_scope in ('ad_review', 'ad_game') and exists (
        select 1 from public.bess_dispatch_person_status status
         where status.day_key = p_day_key and status.person_name = btrim(p_assignee) and status.off_duty
      )) or (p_scope not in ('ad_review', 'ad_game') and v_state.off_duty ? btrim(p_assignee)) then
    raise exception using errcode = '22023', message = 'assignee is off duty';
  end if;
  select assignment.* into v_existing from public.bess_dispatch_assignments assignment
   where assignment.day_key = p_day_key and assignment.scope = p_scope and assignment.request_id = p_request_id;
  if found then
    if p_scope in ('ad_review', 'ad_game') then
      perform public.bess_sync_legacy_ad_shadow(p_day_key);
      insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, request_context, created_at)
      values (p_day_key, 'ad', p_request_id, v_existing.assignee, v_existing.direction,
              v_existing.request_context, v_existing.created_at)
      on conflict (day_key, scope, request_id) do update
        set assignee = excluded.assignee, direction = excluded.direction, request_context = excluded.request_context;
    end if;
    return query select v_existing.assignee, true;
    return;
  end if;
  insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, request_context)
  values (p_day_key, p_scope, p_request_id, btrim(p_assignee), 'specified', coalesce(p_context, '{}'::jsonb));
  if p_scope in ('ad_review', 'ad_game') then
    perform public.bess_sync_legacy_ad_shadow(p_day_key);
    insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, request_context)
    values (p_day_key, 'ad', p_request_id, btrim(p_assignee), 'specified', coalesce(p_context, '{}'::jsonb))
    on conflict (day_key, scope, request_id) do update
      set assignee = excluded.assignee, direction = excluded.direction, request_context = excluded.request_context;
  end if;
  return query select btrim(p_assignee), false;
end;
$$;

create or replace function public.bess_calibrate_cursor(
  p_day_key date, p_scope text, p_direction text, p_assignee text, p_roster jsonb
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
declare v_state public.bess_dispatch_daily_state%rowtype; v_index integer;
begin
  if p_scope not in ('default', 'ad', 'ad_review', 'ad_game') or p_direction not in ('forward', 'reverse') then
    raise exception using errcode = '22023', message = 'invalid calibration scope or direction';
  end if;
  if p_scope = 'ad' then
    raise exception using errcode = 'P0001', message = 'LEGACY_AD_CURSOR_UNREPRESENTABLE';
  end if;
  select state.* into v_state from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope = p_scope and state.expires_at > now() for update;
  if not found then raise exception using errcode = 'P0002', message = 'DAILY_STATE_NOT_FOUND'; end if;
  if p_roster is null or p_roster <> v_state.roster then raise exception using errcode = 'P0001', message = 'ROSTER_CHANGED'; end if;
  select item.ordinality - 1 into v_index from jsonb_array_elements_text(v_state.roster) with ordinality item(value, ordinality)
   where btrim(item.value) = nullif(btrim(p_assignee), '') limit 1;
  if v_index is null then raise exception using errcode = 'P0001', message = 'ASSIGNEE_NOT_IN_ROSTER'; end if;
  if p_direction = 'forward' then
    return query update public.bess_dispatch_daily_state state set forward_cursor = v_index + 1, updated_at = now()
      where state.day_key = p_day_key and state.scope = p_scope returning state.*;
  else
    return query update public.bess_dispatch_daily_state state
      set reverse_cursor = jsonb_array_length(v_state.roster) - v_index, updated_at = now()
      where state.day_key = p_day_key and state.scope = p_scope returning state.*;
  end if;
end;
$$;

create or replace function public.bess_update_roster_status(
  p_day_key date, p_scope text, p_off_duty jsonb, p_expected_version bigint
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
declare v_state public.bess_dispatch_daily_state%rowtype;
begin
  if p_scope not in ('default', 'ad', 'ad_review', 'ad_game') or jsonb_typeof(p_off_duty) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid status update';
  end if;
  if p_scope in ('ad_review', 'ad_game') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rollback_shadow'));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_status'));
  end if;
  select state.* into v_state from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope = p_scope for update;
  if not found or v_state.version <> p_expected_version then return; end if;
  if exists (select 1 from jsonb_array_elements_text(p_off_duty) item(value)
             where not v_state.roster ? item.value) then
    raise exception using errcode = '22023', message = 'off-duty person is not in roster';
  end if;
  if p_scope in ('ad_review', 'ad_game') then
    insert into public.bess_dispatch_person_status(day_key, person_name, off_duty, updated_at)
    select p_day_key, item.value, true, now() from jsonb_array_elements_text(p_off_duty) item(value)
    on conflict (day_key, person_name) do update set off_duty = true, updated_at = now();
    update public.bess_dispatch_person_status status set off_duty = false, updated_at = now()
     where status.day_key = p_day_key and status.off_duty
       and v_state.roster ? status.person_name and not (p_off_duty ? status.person_name);
    update public.bess_dispatch_daily_state state
       set off_duty = p_off_duty, version = state.version + 1, updated_at = now()
     where state.day_key = p_day_key and state.scope in ('ad_review', 'ad_game');
    perform public.bess_sync_legacy_ad_shadow(p_day_key);
  else
    update public.bess_dispatch_daily_state state
       set off_duty = p_off_duty, version = state.version + 1, updated_at = now()
     where state.day_key = p_day_key and state.scope = p_scope;
  end if;
  return query select state.* from public.bess_dispatch_daily_state state
    where state.day_key = p_day_key and state.scope = p_scope;
end;
$$;

revoke all on function public.bess_sync_legacy_ad_shadow(date) from public, anon, authenticated, service_role;
revoke all on function public.bess_initialize_ad_rosters(date,jsonb,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.bess_initialize_ad_rosters(date,jsonb,timestamptz) to service_role;
revoke all on function public.bess_replace_ad_rosters(date,jsonb,bigint,bigint) from public, anon, authenticated, service_role;
grant execute on function public.bess_replace_ad_rosters(date,jsonb,bigint,bigint) to service_role;
revoke all on function public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb) to service_role;
revoke all on function public.bess_assign_specific(date,text,text,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.bess_assign_specific(date,text,text,text,jsonb) to service_role;
revoke all on function public.bess_calibrate_cursor(date,text,text,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.bess_calibrate_cursor(date,text,text,text,jsonb) to service_role;
revoke all on function public.bess_update_roster_status(date,text,jsonb,bigint) from public, anon, authenticated, service_role;
grant execute on function public.bess_update_roster_status(date,text,jsonb,bigint) to service_role;

commit;
