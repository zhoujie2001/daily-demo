-- 20261023_isolate_ad_off_duty.sql
-- 完全隔离 ad_review 与 ad_game 的人员在岗/离岗状态。
-- 不再读写共享的人员状态表，回归使用各 Scope 独立的 daily_state.off_duty。
begin;

-- 1. 重定义 bess_initialize_ad_rosters：初始化时不再参考共享表，且默认 off_duty 为空。
create or replace function public.bess_initialize_ad_rosters(
  p_day_key date,
  p_roster jsonb,
  p_expires_at timestamptz
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.bess_dispatch_daily_state%rowtype;
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

  -- 状态隔离：初始化时不再从共享表聚合，直接设为 []。
  insert into public.bess_dispatch_daily_state(
    day_key, scope, roster, forward_cursor, reverse_cursor, off_duty, version, expires_at
  )
  select p_day_key, lane.scope, p_roster, 0, 0, '[]'::jsonb, 1, p_expires_at
    from (values ('ad_review'::text), ('ad_game'::text)) lane(scope)
  on conflict (day_key, scope) do nothing;

  perform public.bess_sync_legacy_ad_shadow(p_day_key);
  return query select state.* from public.bess_dispatch_daily_state state
    where state.day_key = p_day_key and state.scope in ('ad_review', 'ad_game') order by state.scope;
end;
$$;

-- 2. 重定义 bess_replace_ad_rosters：根据各 Scope 现有的 off_duty 独立过滤。
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

  -- 状态隔离：根据各 Scope 自己的 off_duty 独立进行过滤，不再读共享表。
  update public.bess_dispatch_daily_state state
     set roster = p_roster,
         off_duty = coalesce((
           select jsonb_agg(item.value order by item.ordinality)
             from jsonb_array_elements_text(p_roster) with ordinality item(value, ordinality)
            where state.off_duty ? item.value
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

-- 3. 重定义 bess_update_roster_status：停止向共享表写入，且仅更新当前 Scope。
create or replace function public.bess_update_roster_status(
  p_day_key date, p_scope text, p_off_duty jsonb, p_expected_version bigint
) returns setof public.bess_dispatch_daily_state language plpgsql security definer set search_path = '' as $$
declare v_state public.bess_dispatch_daily_state%rowtype;
begin
  if p_scope not in ('default', 'test_default', 'ad', 'ad_review', 'ad_game') or jsonb_typeof(p_off_duty) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid status update';
  end if;
  if p_scope in ('ad_review', 'ad_game') then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rollback_shadow'));
    -- 移除 ad_status 全局锁调用（不再有全局竞争）
  end if;
  select state.* into v_state from public.bess_dispatch_daily_state state where state.day_key = p_day_key and state.scope = p_scope for update;
  if not found or v_state.version <> p_expected_version then return; end if;
  if exists (select 1 from jsonb_array_elements_text(p_off_duty) item(value)
             where not v_state.roster ? item.value) then
    raise exception using errcode = '22023', message = 'off-duty person is not in roster';
  end if;

  -- 状态隔离：不再操作共享的人员状态表。
  -- 仅更新请求的 scope，不再联动更新配对 Scope。
  update public.bess_dispatch_daily_state state set off_duty = p_off_duty, version = state.version + 1,
    forward_version = state.forward_version + 1, reverse_version = state.reverse_version + 1, updated_at = now()
   where state.day_key = p_day_key and state.scope = p_scope;

  if p_scope in ('ad_review', 'ad_game') then
    perform public.bess_sync_legacy_ad_shadow(p_day_key);
  end if;

  return query select state.* from public.bess_dispatch_daily_state state where state.day_key = p_day_key and state.scope = p_scope;
end;
$$;

-- 4. 重定义 bess_assign_next：派单时移除对共享表的引用，直接使用 state.off_duty。
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
  if p_scope is null or p_scope not in ('default', 'test_default', 'ad', 'ad_review', 'ad_game') then
    raise exception using errcode = '22023', message = 'invalid dispatch scope';
  end if;
  if p_scope = 'ad' then
    raise exception using errcode = 'P0001', message = 'LEGACY_AD_CURSOR_UNREPRESENTABLE';
  end if;
  if p_request_id is null or btrim(p_request_id) = '' or p_direction not in ('forward', 'reverse') then
    raise exception using errcode = '22023', message = 'invalid assignment arguments';
  end if;

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
    -- 状态隔离：统一使用 state.off_duty。
    if v_state.off_duty ? assignee then
      v_steps := v_steps + 1;
      v_index := case when p_direction = 'forward' then (v_index + 1) % v_count
                      else (v_index - 1 + v_count) % v_count end;
      if v_i = v_count - 1 then raise exception using errcode = 'P0001', message = 'ALL_OFF_DUTY'; end if;
    else
      exit;
    end if;
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

-- 5. 重定义 bess_assign_batch：派单时移除对共享表的引用，直接使用 state.off_duty。
create or replace function public.bess_assign_batch(
  p_day_key date, p_scope text, p_request_ids text[], p_direction text,
  p_roster jsonb default null, p_expires_at timestamptz default null,
  p_contexts jsonb default '[]'::jsonb, p_expected_version bigint default null,
  p_expected_cursor_version bigint default null
) returns table (
  request_id text, assignee text, roster jsonb, direction text, replayed boolean,
  original_message_id text, version bigint, forward_version bigint,
  reverse_version bigint, assignment_seq bigint
)
language plpgsql security definer set search_path = '' as $$
declare
  v_state public.bess_dispatch_daily_state%rowtype;
  v_existing public.bess_dispatch_assignments%rowtype;
  v_count integer;
  v_cursor bigint;
  v_total_steps integer := 0;
  v_i integer;
  v_j integer;
  v_req_id text;
  v_ctx jsonb;
  v_assignee text;
  v_step integer;
  v_new_seq bigint;
  v_idx bigint;
  v_any_new boolean := false;
  v_replay_indices integer[] := array[]::integer[];
begin
  if p_scope is null or p_scope not in ('default', 'test_default', 'ad', 'ad_review', 'ad_game') then
    raise exception using errcode = '22023', message = 'invalid dispatch scope';
  end if;
  if p_scope = 'ad' then
    raise exception using errcode = 'P0001', message = 'LEGACY_AD_CURSOR_UNREPRESENTABLE';
  end if;
  if p_request_ids is null or array_length(p_request_ids, 1) = 0 or p_direction not in ('forward', 'reverse') then
    raise exception using errcode = '22023', message = 'invalid assignment arguments';
  end if;

  for v_j in 1..array_length(p_request_ids, 1) loop
    v_req_id := p_request_ids[v_j];
    v_ctx := coalesce(p_contexts->(v_j-1), '{}'::jsonb);
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(
      p_day_key::text || ':' || p_scope || ':' || v_req_id
    ));
    select assignment.* into v_existing
      from public.bess_dispatch_assignments assignment
     where assignment.day_key = p_day_key and assignment.scope = p_scope
       and assignment.request_id = v_req_id;
    if found then
      if nullif(btrim(v_existing.request_context ->> 'sheetId'), '') is not null
         and nullif(btrim(v_ctx ->> 'sheetId'), '') is not null
         and btrim(v_existing.request_context ->> 'sheetId') <> btrim(v_ctx ->> 'sheetId') then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONTEXT_MISMATCH:sheetId';
      end if;
      if nullif(btrim(v_existing.request_context ->> 'targetCategory'), '') is not null
         and nullif(btrim(v_ctx ->> 'targetCategory'), '') is not null
         and btrim(v_existing.request_context ->> 'targetCategory') <> btrim(v_ctx ->> 'targetCategory') then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONTEXT_MISMATCH:targetCategory';
      end if;
      v_replay_indices := array_append(v_replay_indices, v_j);
    else
      v_any_new := true;
    end if;
  end loop;

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

  if v_any_new then
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
  else
    select state.* into v_state from public.bess_dispatch_daily_state state
     where state.day_key = p_day_key and state.scope = p_scope;
    if not found then raise exception using errcode = 'P0002', message = 'daily roster is not initialized'; end if;
  end if;

  v_count := jsonb_array_length(v_state.roster);
  if v_count < 1 then raise exception using errcode = '22023', message = 'stored roster is invalid'; end if;
  v_cursor := case when p_direction = 'forward' then v_state.forward_cursor else v_state.reverse_cursor end;
  v_new_seq := v_state.assignment_seq;

  for v_j in 1..array_length(p_request_ids, 1) loop
    v_req_id := p_request_ids[v_j];
    v_ctx := coalesce(p_contexts->(v_j-1), '{}'::jsonb);
    if v_j = any(v_replay_indices) then
      select assignment.* into v_existing
        from public.bess_dispatch_assignments assignment
       where assignment.day_key = p_day_key and assignment.scope = p_scope
         and assignment.request_id = v_req_id;
      request_id := v_req_id; assignee := v_existing.assignee; roster := v_state.roster;
      direction := v_existing.direction; replayed := true;
      select pending.original_message_id into original_message_id from public.bess_dispatch_pending_forms pending
       where pending.request_id = v_req_id order by pending.created_at desc limit 1;
      version := v_state.version; forward_version := v_state.forward_version;
      reverse_version := v_state.reverse_version; assignment_seq := v_existing.assignment_seq;
      return next;
    else
      v_idx := case when p_direction = 'forward' then (v_cursor + v_total_steps) % v_count
                    else v_count - 1 - ((v_cursor + v_total_steps) % v_count) end;
      v_step := 0;
      for v_i in 0..v_count-1 loop
        v_assignee := btrim(v_state.roster ->> v_idx::integer);
        -- 状态隔离：统一使用 state.off_duty。
        if v_state.off_duty ? v_assignee then
          v_step := v_step + 1;
          v_idx := case when p_direction = 'forward' then (v_idx + 1) % v_count else (v_idx - 1 + v_count) % v_count end;
          if v_i = v_count - 1 then raise exception using errcode = 'P0001', message = 'ALL_OFF_DUTY'; end if;
        else
          exit;
        end if;
      end loop;
      v_new_seq := v_new_seq + 1;
      v_total_steps := v_total_steps + v_step + 1;
      insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, assignment_seq, request_context)
      values (p_day_key, p_scope, v_req_id, v_assignee, p_direction, v_new_seq, v_ctx);
      if p_scope in ('ad_review', 'ad_game') then
        perform public.bess_sync_legacy_ad_shadow(p_day_key);
        insert into public.bess_dispatch_assignments(day_key, scope, request_id, assignee, direction, assignment_seq, request_context)
        values (p_day_key, 'ad', v_req_id, v_assignee, p_direction, v_new_seq, v_ctx)
        on conflict (day_key, scope, request_id) do update set assignee = excluded.assignee,
          direction = excluded.direction, assignment_seq = excluded.assignment_seq, request_context = excluded.request_context;
      end if;
      request_id := v_req_id; assignee := v_assignee; roster := v_state.roster;
      direction := p_direction; replayed := false;
      select pending.original_message_id into original_message_id from public.bess_dispatch_pending_forms pending
        where pending.request_id = v_req_id order by pending.created_at desc limit 1;
      version := v_state.version;
      if p_direction = 'forward' then
         forward_version := v_state.forward_version + 1;
         reverse_version := v_state.reverse_version;
      else
         forward_version := v_state.forward_version;
         reverse_version := v_state.reverse_version + 1;
      end if;
      assignment_seq := v_new_seq;
      return next;
    end if;
  end loop;
  if v_total_steps > 0 then
    if p_direction = 'forward' then
      update public.bess_dispatch_daily_state state set forward_cursor = v_cursor + v_total_steps,
        forward_version = v_state.forward_version + 1, assignment_seq = v_new_seq, updated_at = now()
       where state.day_key = p_day_key and state.scope = p_scope;
    else
      update public.bess_dispatch_daily_state state set reverse_cursor = v_cursor + v_total_steps,
        reverse_version = v_state.reverse_version + 1, assignment_seq = v_new_seq, updated_at = now()
       where state.day_key = p_day_key and state.scope = p_scope;
    end if;
  end if;
end;
$$;

-- 6. 重定义 bess_assign_specific：派单时移除对共享表的引用，直接使用 state.off_duty。
create or replace function public.bess_assign_specific(
  p_day_key date, p_scope text, p_request_id text, p_assignee text, p_context jsonb default '{}'::jsonb
) returns table (assignee text, replayed boolean, version bigint, forward_version bigint, reverse_version bigint, assignment_seq bigint)
language plpgsql security definer set search_path = '' as $$
declare v_state public.bess_dispatch_daily_state%rowtype; v_existing public.bess_dispatch_assignments%rowtype;
begin
  if p_scope not in ('default', 'test_default', 'ad', 'ad_review', 'ad_game') then raise exception using errcode = '22023', message = 'invalid dispatch scope'; end if;
  if p_scope in ('ad_review', 'ad_game') then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rollback_shadow')); end if;
  select state.* into v_state from public.bess_dispatch_daily_state state where state.day_key = p_day_key and state.scope = p_scope and state.expires_at > now() for update;
  if not found then raise exception using errcode = 'P0002', message = 'daily roster is not initialized or expired'; end if;
  if not exists (select 1 from jsonb_array_elements_text(v_state.roster) item(value)
                 where btrim(item.value) = btrim(p_assignee)) then
    raise exception using errcode = '22023', message = 'assignee is not in roster';
  end if;
  -- 状态隔离：统一使用 v_state.off_duty。
  if v_state.off_duty ? btrim(p_assignee) then
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

commit;
