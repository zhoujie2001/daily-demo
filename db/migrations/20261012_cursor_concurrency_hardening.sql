-- 20261012_cursor_concurrency_hardening.sql
-- 绝对环形游标、先幂等后 CAS，以及历史 overload 的完整物理清理。
begin;

-- 生产已有 0..N bounded 值本来就是第一圈绝对步数；不做数据 UPDATE，避免错误放大。
comment on column public.bess_dispatch_daily_state.forward_cursor is
  'Monotonic absolute consumed-step count; next forward index is cursor % roster_length';
comment on column public.bess_dispatch_daily_state.reverse_cursor is
  'Monotonic absolute consumed-step count; next reverse index is roster_length - 1 - (cursor % roster_length)';

do $drop_all_historical_write_overloads$
declare
  v_sig text;
  v_sigs constant text[] := array[
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
    if pg_catalog.to_regprocedure('public.' || v_sig) is not null then
      execute format('revoke execute on function public.%s from public, anon, authenticated, service_role', v_sig);
      execute format('drop function public.%s', v_sig);
    end if;
  end loop;
end;
$drop_all_historical_write_overloads$;

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
  v_count integer;
  v_index bigint;
  v_cursor bigint;
  v_steps integer := 0;
  v_i integer;
  v_new_seq bigint;
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

  -- Idempotency precedes roster initialization and every CAS check. A replay is
  -- read-only with respect to cursor/version/seq, including an old CAS token.
  -- The request-key advisory lock closes the absent-row race without touching
  -- roster/cursor state; the waiter observes the winner as a normal replay.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(
    p_day_key::text || ':' || p_scope || ':' || p_request_id
  ));
  select assignment.* into v_existing
    from public.bess_dispatch_assignments assignment
   where assignment.day_key = p_day_key and assignment.scope = p_scope
     and assignment.request_id = p_request_id;
  if found then
    if nullif(btrim(v_existing.request_context ->> 'sheetId'), '') is not null
       and nullif(btrim(coalesce(p_context, '{}'::jsonb) ->> 'sheetId'), '') is not null
       and btrim(v_existing.request_context ->> 'sheetId') <> btrim(p_context ->> 'sheetId') then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONTEXT_MISMATCH:sheetId';
    end if;
    if nullif(btrim(v_existing.request_context ->> 'targetCategory'), '') is not null
       and nullif(btrim(coalesce(p_context, '{}'::jsonb) ->> 'targetCategory'), '') is not null
       and btrim(v_existing.request_context ->> 'targetCategory') <> btrim(p_context ->> 'targetCategory') then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONTEXT_MISMATCH:targetCategory';
    end if;
    select state.* into v_state from public.bess_dispatch_daily_state state
     where state.day_key = p_day_key and state.scope = p_scope;
    if not found then raise exception using errcode = 'P0002', message = 'daily roster is not initialized'; end if;
    if p_scope in ('ad_review', 'ad_game') then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rollback_shadow'));
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

  v_count := jsonb_array_length(v_state.roster);
  if v_count < 1 then raise exception using errcode = '22023', message = 'stored roster is invalid'; end if;
  v_cursor := case when p_direction = 'forward' then v_state.forward_cursor else v_state.reverse_cursor end;
  v_index := case when p_direction = 'forward' then v_cursor % v_count
                  else v_count - 1 - (v_cursor % v_count) end;
  for v_i in 0..v_count-1 loop
    assignee := btrim(v_state.roster ->> v_index::integer);
    if p_scope in ('ad_review', 'ad_game') then
      exit when not exists (select 1 from public.bess_dispatch_person_status status
        where status.day_key = p_day_key and status.person_name = assignee and status.off_duty);
    else
      exit when not (v_state.off_duty ? assignee);
    end if;
    v_steps := v_steps + 1;
    v_index := case when p_direction = 'forward' then (v_index + 1) % v_count
                    else (v_index - 1 + v_count) % v_count end;
    if v_i = v_count - 1 then raise exception using errcode = 'P0001', message = 'ALL_OFF_DUTY'; end if;
  end loop;

  v_new_seq := v_state.assignment_seq + 1;
  insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, assignment_seq, request_context)
  values (p_day_key, p_scope, p_request_id, assignee, p_direction, v_new_seq, coalesce(p_context, '{}'::jsonb));
  if p_direction = 'forward' then
    update public.bess_dispatch_daily_state state set forward_cursor = v_cursor + v_steps + 1,
      forward_version = v_state.forward_version + 1, assignment_seq = v_new_seq, updated_at = now()
     where state.day_key = p_day_key and state.scope = p_scope;
    forward_version := v_state.forward_version + 1; reverse_version := v_state.reverse_version;
  else
    update public.bess_dispatch_daily_state state set reverse_cursor = v_cursor + v_steps + 1,
      reverse_version = v_state.reverse_version + 1, assignment_seq = v_new_seq, updated_at = now()
     where state.day_key = p_day_key and state.scope = p_scope;
    forward_version := v_state.forward_version; reverse_version := v_state.reverse_version + 1;
  end if;
  roster := v_state.roster; direction := p_direction; replayed := false;
  version := v_state.version; assignment_seq := v_new_seq;
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
declare
  v_state public.bess_dispatch_daily_state%rowtype;
  v_index integer;
  v_count integer;
  v_current bigint;
  v_residue bigint;
  v_lifted bigint;
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

  v_count := jsonb_array_length(v_state.roster);
  v_current := case when p_direction = 'forward' then v_state.forward_cursor else v_state.reverse_cursor end;
  v_residue := case when p_direction = 'forward' then (v_index + 1) % v_count
                    else (v_count - v_index) % v_count end;
  v_lifted := v_current + ((v_residue - (v_current % v_count) + v_count) % v_count);
  if p_direction = 'forward' then
    return query update public.bess_dispatch_daily_state state set forward_cursor = v_lifted,
      forward_version = state.forward_version + 1, updated_at = now()
      where state.day_key = p_day_key and state.scope = p_scope returning state.*;
  else
    return query update public.bess_dispatch_daily_state state set reverse_cursor = v_lifted,
      reverse_version = state.reverse_version + 1, updated_at = now()
      where state.day_key = p_day_key and state.scope = p_scope returning state.*;
  end if;
end;
$$;

revoke all on function public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint) from public, anon, authenticated, service_role;
revoke all on function public.bess_calibrate_cursor(date,text,text,text,jsonb,bigint,bigint) from public, anon, authenticated, service_role;
revoke all on function public.bess_update_roster_status(date,text,jsonb,bigint) from public, anon, authenticated, service_role;
grant execute on function public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint) to service_role;
grant execute on function public.bess_calibrate_cursor(date,text,text,text,jsonb,bigint,bigint) to service_role;
grant execute on function public.bess_update_roster_status(date,text,jsonb,bigint) to service_role;

commit;
