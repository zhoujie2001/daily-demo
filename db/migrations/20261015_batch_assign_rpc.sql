-- 20261015_batch_assign_rpc.sql
-- Batch assignment RPC with scope awareness and cursor hardening.
begin;

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
  if p_scope is null or p_scope not in ('default', 'ad', 'ad_review', 'ad_game') then
    raise exception using errcode = '22023', message = 'invalid dispatch scope';
  end if;
  if p_scope = 'ad' then
    raise exception using errcode = 'P0001', message = 'LEGACY_AD_CURSOR_UNREPRESENTABLE';
  end if;
  if p_request_ids is null or array_length(p_request_ids, 1) = 0 or p_direction not in ('forward', 'reverse') then
    raise exception using errcode = '22023', message = 'invalid assignment arguments';
  end if;

  -- 1. Pre-check for replays and context compatibility (Idempotency precedes CAS)
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
      -- Idempotency context compatibility check (matching 20261012)
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

  -- 2. Initialize roster if provided
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

  -- 3. Lock state and CAS check (only if there are new requests to process)
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

  -- 4. Final pass: produce results
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
      -- Calculate next for new request
      v_idx := case when p_direction = 'forward' then (v_cursor + v_total_steps) % v_count
                    else v_count - 1 - ((v_cursor + v_total_steps) % v_count) end;
      v_step := 0;
      for v_i in 0..v_count-1 loop
        v_assignee := btrim(v_state.roster ->> v_idx::integer);
        if p_scope in ('ad_review', 'ad_game') then
          exit when not exists (select 1 from public.bess_dispatch_person_status status
            where status.day_key = p_day_key and status.person_name = v_assignee and status.off_duty);
        else
          exit when not (v_state.off_duty ? v_assignee);
        end if;
        v_step := v_step + 1;
        v_idx := case when p_direction = 'forward' then (v_idx + 1) % v_count
                        else (v_idx - 1 + v_count) % v_count end;
        if v_i = v_count - 1 then raise exception using errcode = 'P0001', message = 'ALL_OFF_DUTY'; end if;
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

  -- 5. Finalize state
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

grant execute on function public.bess_assign_batch(date,text,text[],text,jsonb,timestamptz,jsonb,bigint,bigint) to service_role;

commit;
