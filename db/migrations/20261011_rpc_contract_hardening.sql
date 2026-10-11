-- 20261011_rpc_contract_hardening.sql
-- 统一 PostgREST 写 RPC 为 9/7/4 参数契约，并增加方向级 CAS 与原子派单序号。
begin;

alter table public.bess_dispatch_daily_state
  add column if not exists forward_version bigint not null default 1,
  add column if not exists reverse_version bigint not null default 1,
  add column if not exists assignment_seq bigint not null default 0;
alter table public.bess_dispatch_assignments
  add column if not exists assignment_seq bigint;

-- 旧 overload 必须物理删除，否则 PostgREST 会返回 HTTP 300。先回收权限再删除；不存在时跳过。
do $drop_legacy_rpc_overloads$
declare
  v_sig text;
  v_sigs text[] := array[
    'bess_assign_next(date,text,text,jsonb,timestamptz,jsonb)',
    'bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb)',
    'bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb,bigint)',
    'bess_calibrate_cursor(date,text,jsonb)',
    'bess_calibrate_cursor(date,text,text,jsonb)',
    'bess_calibrate_cursor(date,text,text,text,jsonb)',
    'bess_calibrate_cursor(date,text,text,text,jsonb,bigint)',
    'bess_update_roster_status(date,jsonb,bigint)'
  ];
begin
  foreach v_sig in array v_sigs loop
    if to_regprocedure('public.' || v_sig) is not null then
      execute format('revoke execute on function public.%s from public, anon, authenticated, service_role', v_sig);
      execute format('drop function public.%s', v_sig);
    end if;
  end loop;
end;
$drop_legacy_rpc_overloads$;

-- 名单替换会使两个方向的游标快照同时失效，必须同步推进方向版本。
create or replace function public.bess_replace_ad_rosters(
  p_day_key date, p_roster jsonb, p_expected_review_version bigint, p_expected_game_version bigint
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
         forward_version = state.forward_version + 1,
         reverse_version = state.reverse_version + 1,
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
  p_context jsonb default '{}'::jsonb, p_expected_version bigint default null,
  p_expected_cursor_version bigint default null
) returns table (
  assignee text, roster jsonb, direction text, replayed boolean,
  original_message_id text, version bigint, forward_version bigint,
  reverse_version bigint, assignment_seq bigint
)
language plpgsql security definer set search_path = '' as $$
declare
  v_state public.bess_dispatch_daily_state%rowtype;
  v_existing public.bess_dispatch_assignments%rowtype;
  v_count integer; v_index bigint; v_anchor_index bigint; v_i integer; v_new_seq bigint;
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
      values (p_day_key, p_scope, p_roster, p_expires_at) on conflict (day_key, scope) do nothing;
    end if;
  end if;
  if p_scope in ('ad_review', 'ad_game') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rollback_shadow'));
  end if;
  select state.* into v_state from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope = p_scope and state.expires_at > now() for update;
  if not found then raise exception using errcode = 'P0002', message = 'daily roster is not initialized or expired'; end if;
  if p_expected_version is not null and v_state.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'CAS_ROSTER_VERSION_MISMATCH';
  end if;
  if p_direction = 'forward' and p_expected_cursor_version is not null
     and v_state.forward_version <> p_expected_cursor_version then
    raise exception using errcode = 'P0001', message = 'CAS_FORWARD_CURSOR_MISMATCH';
  end if;
  if p_direction = 'reverse' and p_expected_cursor_version is not null
     and v_state.reverse_version <> p_expected_cursor_version then
    raise exception using errcode = 'P0001', message = 'CAS_REVERSE_CURSOR_MISMATCH';
  end if;
  select assignment.* into v_existing from public.bess_dispatch_assignments assignment
   where assignment.day_key = p_day_key and assignment.scope = p_scope and assignment.request_id = p_request_id;
  if found then
    if p_scope in ('ad_review', 'ad_game') then
      perform public.bess_sync_legacy_ad_shadow(p_day_key);
      insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, assignment_seq, request_context, created_at)
      values (p_day_key, 'ad', p_request_id, v_existing.assignee, v_existing.direction,
              v_existing.assignment_seq, v_existing.request_context, v_existing.created_at)
      on conflict (day_key, scope, request_id) do update set assignee = excluded.assignee,
        direction = excluded.direction, assignment_seq = excluded.assignment_seq, request_context = excluded.request_context;
    end if;
    return query select v_existing.assignee, v_state.roster, v_existing.direction, true,
      (select pending.original_message_id from public.bess_dispatch_pending_forms pending
        where pending.request_id = p_request_id order by pending.created_at desc limit 1),
      v_state.version, v_state.forward_version, v_state.reverse_version, v_existing.assignment_seq;
    return;
  end if;
  v_count := jsonb_array_length(v_state.roster);
  if v_count < 1 then raise exception using errcode = '22023', message = 'stored roster is invalid'; end if;
  select item.ordinality - 1 into v_anchor_index
    from jsonb_array_elements_text(v_state.roster) with ordinality item(value, ordinality)
   where btrim(item.value) = nullif(btrim(p_context ->> 'anchor_assignee'), '') limit 1;
  if v_anchor_index is not null then
    if p_direction = 'forward' then
      v_index := (v_anchor_index + 1) % v_count;
      if v_index < v_state.forward_cursor % v_count and v_state.forward_cursor > 0 then v_index := v_state.forward_cursor % v_count; end if;
    else
      v_index := (v_anchor_index - 1 + v_count) % v_count;
      if (v_count - 1 - v_index) < v_state.reverse_cursor % v_count and v_state.reverse_cursor > 0 then
        v_index := v_count - 1 - (v_state.reverse_cursor % v_count);
      end if;
    end if;
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
    v_index := case when p_direction = 'forward' then (v_index + 1) % v_count else (v_index - 1 + v_count) % v_count end;
    if v_i = v_count - 1 then raise exception using errcode = 'P0001', message = 'ALL_OFF_DUTY'; end if;
  end loop;
  v_new_seq := v_state.assignment_seq + 1;
  insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, assignment_seq, request_context)
  values (p_day_key, p_scope, p_request_id, assignee, p_direction, v_new_seq, coalesce(p_context, '{}'::jsonb));
  if p_direction = 'forward' then
    update public.bess_dispatch_daily_state state set forward_cursor = v_index + 1,
      forward_version = v_state.forward_version + 1, assignment_seq = v_new_seq, updated_at = now()
     where state.day_key = p_day_key and state.scope = p_scope;
    forward_version := v_state.forward_version + 1; reverse_version := v_state.reverse_version;
  else
    update public.bess_dispatch_daily_state state set reverse_cursor = v_count - v_index,
      reverse_version = v_state.reverse_version + 1, assignment_seq = v_new_seq, updated_at = now()
     where state.day_key = p_day_key and state.scope = p_scope;
    forward_version := v_state.forward_version; reverse_version := v_state.reverse_version + 1;
  end if;
  roster := v_state.roster; direction := p_direction; replayed := false; version := v_state.version; assignment_seq := v_new_seq;
  select pending.original_message_id into original_message_id from public.bess_dispatch_pending_forms pending
   where pending.request_id = p_request_id order by pending.created_at desc limit 1;
  if p_scope in ('ad_review', 'ad_game') then
    perform public.bess_sync_legacy_ad_shadow(p_day_key);
    insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, assignment_seq, request_context)
    values (p_day_key, 'ad', p_request_id, assignee, p_direction, v_new_seq, coalesce(p_context, '{}'::jsonb))
    on conflict (day_key, scope, request_id) do update set assignee = excluded.assignee,
      direction = excluded.direction, assignment_seq = excluded.assignment_seq, request_context = excluded.request_context;
  end if;
  return next;
end;
$$;

create or replace function public.bess_calibrate_cursor(
  p_day_key date, p_scope text, p_direction text, p_assignee text, p_roster jsonb,
  p_expected_version bigint default null, p_expected_cursor_version bigint default null
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
declare v_state public.bess_dispatch_daily_state%rowtype; v_index integer;
begin
  if p_scope not in ('default', 'ad', 'ad_review', 'ad_game') or p_direction not in ('forward', 'reverse') then
    raise exception using errcode = '22023', message = 'invalid calibration scope or direction';
  end if;
  if p_scope = 'ad' then raise exception using errcode = 'P0001', message = 'LEGACY_AD_CURSOR_UNREPRESENTABLE'; end if;
  select state.* into v_state from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope = p_scope and state.expires_at > now() for update;
  if not found then raise exception using errcode = 'P0002', message = 'DAILY_STATE_NOT_FOUND'; end if;
  if p_expected_version is not null and v_state.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'CAS_ROSTER_VERSION_MISMATCH';
  end if;
  if p_direction = 'forward' and p_expected_cursor_version is not null and v_state.forward_version <> p_expected_cursor_version then
    raise exception using errcode = 'P0001', message = 'CAS_FORWARD_CURSOR_MISMATCH';
  end if;
  if p_direction = 'reverse' and p_expected_cursor_version is not null and v_state.reverse_version <> p_expected_cursor_version then
    raise exception using errcode = 'P0001', message = 'CAS_REVERSE_CURSOR_MISMATCH';
  end if;
  if p_roster is null or p_roster <> v_state.roster then raise exception using errcode = 'P0001', message = 'ROSTER_CHANGED'; end if;
  select item.ordinality - 1 into v_index from jsonb_array_elements_text(v_state.roster) with ordinality item(value, ordinality)
   where btrim(item.value) = nullif(btrim(p_assignee), '') limit 1;
  if v_index is null then raise exception using errcode = 'P0001', message = 'ASSIGNEE_NOT_IN_ROSTER'; end if;
  if p_direction = 'forward' then
    return query update public.bess_dispatch_daily_state state set forward_cursor = v_index + 1,
      forward_version = state.forward_version + 1, updated_at = now()
      where state.day_key = p_day_key and state.scope = p_scope returning state.*;
  else
    return query update public.bess_dispatch_daily_state state set reverse_cursor = jsonb_array_length(v_state.roster) - v_index,
      reverse_version = state.reverse_version + 1, updated_at = now()
      where state.day_key = p_day_key and state.scope = p_scope returning state.*;
  end if;
end;
$$;

-- 同签名 OUT 契约变化必须先删再建。
do $$ begin
  if to_regprocedure('public.bess_assign_specific(date,text,text,text,jsonb)') is not null then
    revoke execute on function public.bess_assign_specific(date,text,text,text,jsonb) from public, anon, authenticated, service_role;
    drop function public.bess_assign_specific(date,text,text,text,jsonb);
  end if;
end $$;
create function public.bess_assign_specific(
  p_day_key date, p_scope text, p_request_id text, p_assignee text, p_context jsonb default '{}'::jsonb
) returns table (assignee text, replayed boolean, version bigint, forward_version bigint, reverse_version bigint, assignment_seq bigint)
language plpgsql security definer set search_path = '' as $$
declare v_state public.bess_dispatch_daily_state%rowtype; v_existing public.bess_dispatch_assignments%rowtype;
begin
  if p_scope not in ('default', 'ad', 'ad_review', 'ad_game') then raise exception using errcode = '22023', message = 'invalid dispatch scope'; end if;
  if p_scope in ('ad_review', 'ad_game') then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rollback_shadow')); end if;
  select state.* into v_state from public.bess_dispatch_daily_state state where state.day_key = p_day_key and state.scope = p_scope and state.expires_at > now() for update;
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
  select assignment.* into v_existing from public.bess_dispatch_assignments assignment where assignment.day_key = p_day_key and assignment.scope = p_scope and assignment.request_id = p_request_id;
  if found then return query select v_existing.assignee, true, v_state.version, v_state.forward_version, v_state.reverse_version, v_existing.assignment_seq; return; end if;
  insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, assignment_seq, request_context)
  values (p_day_key, p_scope, p_request_id, btrim(p_assignee), 'specified', null, coalesce(p_context, '{}'::jsonb));
  if p_scope in ('ad_review', 'ad_game') then
    perform public.bess_sync_legacy_ad_shadow(p_day_key);
    insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, assignment_seq, request_context)
    values (p_day_key, 'ad', p_request_id, btrim(p_assignee), 'specified', null, coalesce(p_context, '{}'::jsonb))
    on conflict (day_key, scope, request_id) do update set assignee = excluded.assignee, direction = excluded.direction,
      assignment_seq = excluded.assignment_seq, request_context = excluded.request_context;
  end if;
  return query select btrim(p_assignee), false, v_state.version, v_state.forward_version, v_state.reverse_version, null::bigint;
end;
$$;

create or replace function public.bess_update_roster_status(
  p_day_key date, p_scope text, p_off_duty jsonb, p_expected_version bigint
) returns setof public.bess_dispatch_daily_state language plpgsql security definer set search_path = '' as $$
declare v_state public.bess_dispatch_daily_state%rowtype;
begin
  if p_scope not in ('default', 'ad', 'ad_review', 'ad_game') or jsonb_typeof(p_off_duty) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid status update';
  end if;
  if p_scope in ('ad_review', 'ad_game') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rollback_shadow'));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_status'));
  end if;
  select state.* into v_state from public.bess_dispatch_daily_state state where state.day_key = p_day_key and state.scope = p_scope for update;
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
     where status.day_key = p_day_key and status.off_duty and v_state.roster ? status.person_name and not (p_off_duty ? status.person_name);
    update public.bess_dispatch_daily_state state set off_duty = p_off_duty, version = state.version + 1,
      forward_version = state.forward_version + 1, reverse_version = state.reverse_version + 1, updated_at = now()
     where state.day_key = p_day_key and state.scope in ('ad_review', 'ad_game');
    perform public.bess_sync_legacy_ad_shadow(p_day_key);
  else
    update public.bess_dispatch_daily_state state set off_duty = p_off_duty, version = state.version + 1,
      forward_version = state.forward_version + 1, reverse_version = state.reverse_version + 1, updated_at = now()
     where state.day_key = p_day_key and state.scope = p_scope;
  end if;
  return query select state.* from public.bess_dispatch_daily_state state where state.day_key = p_day_key and state.scope = p_scope;
end;
$$;

revoke all on function public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint) from public, anon, authenticated, service_role;
revoke all on function public.bess_calibrate_cursor(date,text,text,text,jsonb,bigint,bigint) from public, anon, authenticated, service_role;
revoke all on function public.bess_assign_specific(date,text,text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.bess_update_roster_status(date,text,jsonb,bigint) from public, anon, authenticated, service_role;
grant execute on function public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint) to service_role;
grant execute on function public.bess_calibrate_cursor(date,text,text,text,jsonb,bigint,bigint) to service_role;
grant execute on function public.bess_assign_specific(date,text,text,text,jsonb) to service_role;
grant execute on function public.bess_update_roster_status(date,text,jsonb,bigint) to service_role;

commit;
