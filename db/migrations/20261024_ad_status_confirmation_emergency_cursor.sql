-- AD roster-revision status confirmation and independent emergency forward lane.
begin;

alter table public.bess_dispatch_daily_state
  add column if not exists emergency_forward_cursor bigint not null default 0,
  add column if not exists emergency_forward_version bigint not null default 1,
  add column if not exists roster_revision bigint not null default 1,
  add column if not exists status_confirmed boolean not null default false,
  add column if not exists confirmed_roster_revision bigint,
  add column if not exists status_confirmed_at timestamptz,
  add column if not exists status_confirmed_by text;

alter table public.bess_dispatch_daily_state
  drop constraint if exists bess_dispatch_daily_state_emergency_forward_cursor_check;
alter table public.bess_dispatch_daily_state
  add constraint bess_dispatch_daily_state_emergency_forward_cursor_check check (emergency_forward_cursor >= 0);
alter table public.bess_dispatch_daily_state
  drop constraint if exists bess_dispatch_daily_state_emergency_forward_version_check;
alter table public.bess_dispatch_daily_state
  add constraint bess_dispatch_daily_state_emergency_forward_version_check check (emergency_forward_version >= 1);
alter table public.bess_dispatch_daily_state
  drop constraint if exists bess_dispatch_daily_state_roster_revision_check;
alter table public.bess_dispatch_daily_state
  add constraint bess_dispatch_daily_state_roster_revision_check check (roster_revision >= 1);

-- Non-AD is never gated. Existing AD scopes that have already assigned work are
-- confirmed for their current roster revision; untouched AD scopes remain pending.
update public.bess_dispatch_daily_state state
   set status_confirmed = true,
       confirmed_roster_revision = state.roster_revision,
       status_confirmed_at = coalesce(state.status_confirmed_at, state.updated_at)
 where state.scope not in ('ad_review', 'ad_game')
    or exists (select 1 from public.bess_dispatch_assignments assignment
                where assignment.day_key = state.day_key and assignment.scope = state.scope);

alter table public.bess_dispatch_assignments
  drop constraint if exists bess_dispatch_assignments_direction_check;
alter table public.bess_dispatch_assignments
  add constraint bess_dispatch_assignments_direction_check
  check (direction in ('forward', 'reverse', 'emergency_forward', 'specified')) not valid;
alter table public.bess_dispatch_assignments
  validate constraint bess_dispatch_assignments_direction_check;

create table if not exists public.bess_dispatch_status_confirmations (
  day_key date not null,
  scope text not null check (scope in ('ad_review', 'ad_game')),
  roster_revision bigint not null check (roster_revision >= 1),
  confirmed_at timestamptz not null default now(),
  confirmed_by text,
  primary key (day_key, scope, roster_revision)
);
create table if not exists public.bess_dispatch_confirmation_operations (
  confirmation_operation_id text primary key,
  submission_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.bess_dispatch_status_confirmations enable row level security;
drop policy if exists bess_dispatch_service_role_only on public.bess_dispatch_status_confirmations;
create policy bess_dispatch_service_role_only on public.bess_dispatch_status_confirmations
  for all to service_role using (true) with check (true);
revoke all on table public.bess_dispatch_status_confirmations from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.bess_dispatch_status_confirmations to service_role;
alter table public.bess_dispatch_confirmation_operations enable row level security;
drop policy if exists bess_dispatch_service_role_only on public.bess_dispatch_confirmation_operations;
create policy bess_dispatch_service_role_only on public.bess_dispatch_confirmation_operations
  for all to service_role using (true) with check (true);
revoke all on table public.bess_dispatch_confirmation_operations from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.bess_dispatch_confirmation_operations to service_role;

create or replace function public.bess_update_ad_roster_statuses(
  p_day_key date, p_updates jsonb, p_confirmation_operation_id text,
  p_submission_hash text, p_confirmed_by text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_previous public.bess_dispatch_confirmation_operations%rowtype;
  v_update jsonb;
  v_state public.bess_dispatch_daily_state%rowtype;
  v_result jsonb;
  v_count integer;
begin
  if p_day_key is null or jsonb_typeof(p_updates) <> 'array'
     or jsonb_array_length(p_updates) not between 1 and 2
     or nullif(btrim(p_confirmation_operation_id), '') is null
     or nullif(btrim(p_submission_hash), '') is null then
    raise exception using errcode = '22023', message = 'invalid AD status confirmation';
  end if;

  -- Serialize callbacks for the day, then replay before any current-version CAS.
  -- A successful callback retry therefore returns its first result rather than conflict.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_status_confirmation'));
  select operation.* into v_previous
    from public.bess_dispatch_confirmation_operations operation
   where operation.confirmation_operation_id = p_confirmation_operation_id;
  if found then
    if v_previous.submission_hash <> p_submission_hash then
      raise exception using errcode = 'P0001', message = 'CONFIRMATION_OPERATION_MISMATCH';
    end if;
    return v_previous.result || jsonb_build_object('replayed', true);
  end if;

  perform 1 from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope in ('ad_review', 'ad_game')
   order by state.scope for update;

  select count(*) into v_count from jsonb_array_elements(p_updates) item
   where item->>'scope' in ('ad_review', 'ad_game');
  if v_count <> jsonb_array_length(p_updates)
     or v_count <> (select count(distinct item->>'scope') from jsonb_array_elements(p_updates) item) then
    raise exception using errcode = '22023', message = 'invalid AD status scope set';
  end if;

  for v_update in select value from jsonb_array_elements(p_updates) loop
    select state.* into v_state from public.bess_dispatch_daily_state state
     where state.day_key = p_day_key and state.scope = v_update->>'scope';
    if not found
       or v_state.version <> (v_update->>'expected_version')::bigint
       or v_state.roster_revision <> (v_update->>'expected_roster_revision')::bigint then
      raise exception using errcode = '40001', message = 'AD_STATUS_UPDATE_CONFLICT';
    end if;
    if jsonb_typeof(v_update->'off_duty') <> 'array'
       or exists (select 1 from jsonb_array_elements_text(v_update->'off_duty') person(name)
                   where not v_state.roster ? person.name) then
      raise exception using errcode = '22023', message = 'off-duty person is not in roster';
    end if;
  end loop;

  for v_update in select value from jsonb_array_elements(p_updates) loop
    update public.bess_dispatch_daily_state state
       set off_duty = v_update->'off_duty',
           status_confirmed = true,
           confirmed_roster_revision = state.roster_revision,
           status_confirmed_at = now(), status_confirmed_by = p_confirmed_by,
           version = state.version + 1,
           forward_version = state.forward_version + 1,
           reverse_version = state.reverse_version + 1,
           emergency_forward_version = state.emergency_forward_version + 1,
           updated_at = now()
     where state.day_key = p_day_key and state.scope = v_update->>'scope';
  end loop;

  select jsonb_build_object(
    'replayed', false,
    'states', jsonb_agg(to_jsonb(state) order by state.scope)
  ) into v_result
    from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key
     and state.scope in (select item->>'scope' from jsonb_array_elements(p_updates) item);

  -- One row per scope+revision is the confirmation identity. The operation id
  -- is only callback idempotency and can differ across card chunks.
  for v_update in select value from jsonb_array_elements(p_updates) loop
    insert into public.bess_dispatch_status_confirmations(
      day_key, scope, roster_revision, confirmed_by
    ) values (
      p_day_key, v_update->>'scope', (v_update->>'expected_roster_revision')::bigint,
      p_confirmed_by
    )
    on conflict (day_key, scope, roster_revision) do update
      set confirmed_at = now(), confirmed_by = excluded.confirmed_by;
  end loop;
  insert into public.bess_dispatch_confirmation_operations(
    confirmation_operation_id, submission_hash, result
  ) values (p_confirmation_operation_id, p_submission_hash, v_result);
  return v_result;
end;
$$;
revoke all on function public.bess_update_ad_roster_statuses(date,jsonb,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.bess_update_ad_roster_statuses(date,jsonb,text,text,text) to service_role;

-- AD initialization always creates both scopes, each with an explicit first-confirm pending state.
create or replace function public.bess_initialize_ad_rosters(
  p_day_key date, p_roster jsonb, p_expires_at timestamptz
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
begin
  if p_day_key is null or p_expires_at is null or p_expires_at <= now()
     or jsonb_typeof(p_roster) <> 'array' or jsonb_array_length(p_roster) = 0
     or exists (select 1 from jsonb_array_elements_text(p_roster) item(value)
                where nullif(btrim(item.value), '') is null) then
    raise exception using errcode = '22023', message = 'invalid AD roster initialization';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rosters'));
  if exists (select 1 from public.bess_dispatch_daily_state state
              where state.day_key = p_day_key and state.scope in ('ad_review','ad_game')
                and state.roster <> p_roster) then
    raise exception using errcode = 'P0001', message = 'ROSTER_CHANGED';
  end if;
  insert into public.bess_dispatch_daily_state(
    day_key, scope, roster, forward_cursor, reverse_cursor, emergency_forward_cursor,
    off_duty, version, forward_version, reverse_version, emergency_forward_version,
    roster_revision, status_confirmed, confirmed_roster_revision, expires_at
  ) select p_day_key, lane.scope, p_roster, 0, 0, 0, '[]'::jsonb,
           1, 1, 1, 1, 1, false, null, p_expires_at
      from (values ('ad_review'::text), ('ad_game'::text)) lane(scope)
  on conflict (day_key, scope) do nothing;
  perform public.bess_sync_legacy_ad_shadow(p_day_key);
  return query select state.* from public.bess_dispatch_daily_state state
    where state.day_key = p_day_key and state.scope in ('ad_review','ad_game') order by state.scope;
end;
$$;

create or replace function public.bess_replace_ad_rosters(
  p_day_key date, p_roster jsonb, p_expected_review_version bigint, p_expected_game_version bigint
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
begin
  if p_day_key is null or jsonb_typeof(p_roster) <> 'array' or jsonb_array_length(p_roster) = 0 then
    raise exception using errcode = '22023', message = 'invalid AD roster replacement';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rosters'));
  perform 1 from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope in ('ad_review','ad_game') for update;
  if (select count(*) from public.bess_dispatch_daily_state state where state.day_key = p_day_key and
      ((state.scope='ad_review' and state.version=p_expected_review_version)
       or (state.scope='ad_game' and state.version=p_expected_game_version))) <> 2 then
    raise exception using errcode = '40001', message = 'AD_ROSTER_UPDATE_CONFLICT';
  end if;
  update public.bess_dispatch_daily_state state
     set roster = p_roster,
         off_duty = coalesce((select jsonb_agg(person.value order by person.ordinality)
           from jsonb_array_elements_text(p_roster) with ordinality person(value, ordinality)
          where state.off_duty ? person.value), '[]'::jsonb),
         roster_revision = state.roster_revision + 1,
         status_confirmed = false, confirmed_roster_revision = null,
         status_confirmed_at = null, status_confirmed_by = null,
         version = state.version + 1, forward_version = state.forward_version + 1,
         reverse_version = state.reverse_version + 1,
         emergency_forward_version = state.emergency_forward_version + 1,
         updated_at = now()
   where state.day_key = p_day_key and state.scope in ('ad_review','ad_game');
  perform public.bess_sync_legacy_ad_shadow(p_day_key);
  return query select state.* from public.bess_dispatch_daily_state state
   where state.day_key=p_day_key and state.scope in ('ad_review','ad_game') order by state.scope;
end;
$$;

create or replace function public.bess_update_roster_status(
  p_day_key date, p_scope text, p_off_duty jsonb, p_expected_version bigint
) returns setof public.bess_dispatch_daily_state language plpgsql security definer set search_path = '' as $$
declare v_state public.bess_dispatch_daily_state%rowtype;
begin
  if p_scope not in ('default','test_default','ad','ad_review','ad_game') or jsonb_typeof(p_off_duty)<>'array' then
    raise exception using errcode='22023', message='invalid status update';
  end if;
  select state.* into v_state from public.bess_dispatch_daily_state state
   where state.day_key=p_day_key and state.scope=p_scope for update;
  if not found or v_state.version<>p_expected_version then return; end if;
  if exists (select 1 from jsonb_array_elements_text(p_off_duty) person(name) where not v_state.roster ? person.name) then
    raise exception using errcode='22023', message='off-duty person is not in roster';
  end if;
  update public.bess_dispatch_daily_state state set off_duty=p_off_duty,
    version=state.version+1, forward_version=state.forward_version+1,
    reverse_version=state.reverse_version+1,
    emergency_forward_version=state.emergency_forward_version+1, updated_at=now()
   where state.day_key=p_day_key and state.scope=p_scope;
  return query select state.* from public.bess_dispatch_daily_state state where state.day_key=p_day_key and state.scope=p_scope;
end;
$$;

-- Replace direction-sensitive functions. Keep every legacy parameter signature and
-- legacy OUT-column prefix stable for DB-first rollout compatibility. The new
-- emergency_forward_version OUT column is appended last. AD confirmation is
-- intentionally enforced by the new Node service before these RPCs are called,
-- so an old deployment can continue using the unchanged signatures during rollout.
drop function if exists public.bess_calibrate_and_assign_next(date,text,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint);
drop function if exists public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint);
drop function if exists public.bess_assign_batch(date,text,text[],text,jsonb,timestamptz,jsonb,bigint,bigint);
drop function if exists public.bess_assign_specific(date,text,text,text,jsonb);
drop function if exists public.bess_calibrate_cursor(date,text,text,text,jsonb,bigint,bigint);

create function public.bess_calibrate_cursor(
  p_day_key date, p_scope text, p_direction text, p_assignee text, p_roster jsonb,
  p_expected_version bigint default null, p_expected_cursor_version bigint default null
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
declare v_state public.bess_dispatch_daily_state%rowtype; v_index integer; v_count integer; v_cursor bigint; v_residue bigint;
begin
  if p_direction not in ('forward','reverse','emergency_forward') then raise exception using errcode='22023', message='INVALID_DIRECTION'; end if;
  select state.* into v_state from public.bess_dispatch_daily_state state
   where state.day_key=p_day_key and state.scope=p_scope and state.expires_at>now() for update;
  if not found then raise exception using errcode='P0002', message='DAILY_STATE_NOT_FOUND'; end if;
  if p_expected_version is not null and v_state.version<>p_expected_version then raise exception using errcode='P0001', message='CAS_ROSTER_VERSION_MISMATCH'; end if;
  if p_direction='forward' and p_expected_cursor_version is not null and v_state.forward_version<>p_expected_cursor_version then raise exception using errcode='P0001', message='CAS_FORWARD_CURSOR_MISMATCH'; end if;
  if p_direction='reverse' and p_expected_cursor_version is not null and v_state.reverse_version<>p_expected_cursor_version then raise exception using errcode='P0001', message='CAS_REVERSE_CURSOR_MISMATCH'; end if;
  if p_direction='emergency_forward' and p_expected_cursor_version is not null and v_state.emergency_forward_version<>p_expected_cursor_version then raise exception using errcode='P0001', message='CAS_EMERGENCY_FORWARD_CURSOR_MISMATCH'; end if;
  if p_roster<>v_state.roster then raise exception using errcode='P0001', message='ROSTER_CHANGED'; end if;
  select item.ordinality-1 into v_index from jsonb_array_elements_text(v_state.roster) with ordinality item(value,ordinality) where btrim(item.value)=btrim(p_assignee) limit 1;
  if v_index is null then raise exception using errcode='P0001', message='ASSIGNEE_NOT_IN_ROSTER'; end if;
  v_count:=jsonb_array_length(v_state.roster);
  if p_direction='reverse' then v_cursor:=v_state.reverse_cursor; v_residue:=(v_count-v_index)%v_count;
  elsif p_direction='emergency_forward' then v_cursor:=v_state.emergency_forward_cursor; v_residue:=(v_index+1)%v_count;
  else v_cursor:=v_state.forward_cursor; v_residue:=(v_index+1)%v_count; end if;
  v_cursor:=v_cursor+((v_residue-(v_cursor%v_count)+v_count)%v_count);
  if p_direction='forward' then update public.bess_dispatch_daily_state state set forward_cursor=v_cursor,forward_version=state.forward_version+1,updated_at=now() where state.day_key=p_day_key and state.scope=p_scope;
  elsif p_direction='reverse' then update public.bess_dispatch_daily_state state set reverse_cursor=v_cursor,reverse_version=state.reverse_version+1,updated_at=now() where state.day_key=p_day_key and state.scope=p_scope;
  else update public.bess_dispatch_daily_state state set emergency_forward_cursor=v_cursor,emergency_forward_version=state.emergency_forward_version+1,updated_at=now() where state.day_key=p_day_key and state.scope=p_scope; end if;
  return query select state.* from public.bess_dispatch_daily_state state where state.day_key=p_day_key and state.scope=p_scope;
end;
$$;

create function public.bess_assign_next(
  p_day_key date, p_scope text, p_request_id text, p_direction text,
  p_roster jsonb default null, p_expires_at timestamptz default null,
  p_context jsonb default '{}'::jsonb, p_expected_version bigint default null,
  p_expected_cursor_version bigint default null
) returns table (assignee text, roster jsonb, direction text, replayed boolean,
  original_message_id text, version bigint, forward_version bigint, reverse_version bigint,
  assignment_seq bigint, emergency_forward_version bigint)
language plpgsql security definer set search_path = '' as $$
declare v_state public.bess_dispatch_daily_state%rowtype; v_existing public.bess_dispatch_assignments%rowtype;
  v_count integer; v_index bigint; v_cursor bigint; v_steps integer:=0; v_i integer; v_seq bigint;
begin
  if p_direction not in ('forward','reverse','emergency_forward') then raise exception using errcode='22023', message='invalid assignment arguments'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text||':'||p_scope||':'||p_request_id));
  select a.* into v_existing from public.bess_dispatch_assignments a where a.day_key=p_day_key and a.scope=p_scope and a.request_id=p_request_id;
  if found then
    select state.* into strict v_state from public.bess_dispatch_daily_state state where state.day_key=p_day_key and state.scope=p_scope;
    return query select v_existing.assignee,v_state.roster,v_existing.direction,true,null::text,v_state.version,v_state.forward_version,v_state.reverse_version,v_existing.assignment_seq,v_state.emergency_forward_version; return;
  end if;
  if p_roster is not null then
    if p_scope in ('ad_review','ad_game') then perform * from public.bess_initialize_ad_rosters(p_day_key,p_roster,p_expires_at);
    else insert into public.bess_dispatch_daily_state(day_key,scope,roster,expires_at,status_confirmed,confirmed_roster_revision) values(p_day_key,p_scope,p_roster,p_expires_at,true,1) on conflict(day_key,scope) do nothing; end if;
  end if;
  select state.* into v_state from public.bess_dispatch_daily_state state where state.day_key=p_day_key and state.scope=p_scope and state.expires_at>now() for update;
  if not found then raise exception using errcode='P0002',message='daily roster is not initialized or expired'; end if;
  if p_expected_version is not null and v_state.version<>p_expected_version then raise exception using errcode='P0001',message='CAS_ROSTER_VERSION_MISMATCH'; end if;
  if p_direction='forward' and p_expected_cursor_version is not null and v_state.forward_version<>p_expected_cursor_version then raise exception using errcode='P0001',message='CAS_FORWARD_CURSOR_MISMATCH'; end if;
  if p_direction='reverse' and p_expected_cursor_version is not null and v_state.reverse_version<>p_expected_cursor_version then raise exception using errcode='P0001',message='CAS_REVERSE_CURSOR_MISMATCH'; end if;
  if p_direction='emergency_forward' and p_expected_cursor_version is not null and v_state.emergency_forward_version<>p_expected_cursor_version then raise exception using errcode='P0001',message='CAS_EMERGENCY_FORWARD_CURSOR_MISMATCH'; end if;
  v_count:=jsonb_array_length(v_state.roster);
  v_cursor:=case p_direction when 'forward' then v_state.forward_cursor when 'reverse' then v_state.reverse_cursor else v_state.emergency_forward_cursor end;
  v_index:=case when p_direction='reverse' then v_count-1-(v_cursor%v_count) else v_cursor%v_count end;
  for v_i in 0..v_count-1 loop
    assignee:=btrim(v_state.roster->>v_index::integer); exit when not(v_state.off_duty?assignee);
    v_steps:=v_steps+1; v_index:=case when p_direction='reverse' then (v_index-1+v_count)%v_count else (v_index+1)%v_count end;
    if v_i=v_count-1 then raise exception using errcode='P0001',message='ALL_OFF_DUTY'; end if;
  end loop;
  v_seq:=v_state.assignment_seq+1;
  insert into public.bess_dispatch_assignments(day_key,scope,request_id,assignee,direction,assignment_seq,request_context) values(p_day_key,p_scope,p_request_id,assignee,p_direction,v_seq,coalesce(p_context,'{}'::jsonb));
  if p_direction='forward' then update public.bess_dispatch_daily_state state set forward_cursor=v_cursor+v_steps+1,forward_version=state.forward_version+1,assignment_seq=v_seq,updated_at=now() where state.day_key=p_day_key and state.scope=p_scope;
  elsif p_direction='reverse' then update public.bess_dispatch_daily_state state set reverse_cursor=v_cursor+v_steps+1,reverse_version=state.reverse_version+1,assignment_seq=v_seq,updated_at=now() where state.day_key=p_day_key and state.scope=p_scope;
  else update public.bess_dispatch_daily_state state set emergency_forward_cursor=v_cursor+v_steps+1,emergency_forward_version=state.emergency_forward_version+1,assignment_seq=v_seq,updated_at=now() where state.day_key=p_day_key and state.scope=p_scope; end if;
  select state.* into strict v_state from public.bess_dispatch_daily_state state where state.day_key=p_day_key and state.scope=p_scope;
  roster:=v_state.roster; direction:=p_direction; replayed:=false; version:=v_state.version; forward_version:=v_state.forward_version; reverse_version:=v_state.reverse_version; emergency_forward_version:=v_state.emergency_forward_version; assignment_seq:=v_seq; return next;
end;
$$;

create function public.bess_assign_batch(
  p_day_key date,p_scope text,p_request_ids text[],p_direction text,p_roster jsonb default null,
  p_expires_at timestamptz default null,p_contexts jsonb default '[]'::jsonb,
  p_expected_version bigint default null,p_expected_cursor_version bigint default null
) returns table(request_id text,assignee text,roster jsonb,direction text,replayed boolean,
  original_message_id text,version bigint,forward_version bigint,reverse_version bigint,
  assignment_seq bigint,emergency_forward_version bigint)
language plpgsql security definer set search_path='' as $$
declare
  v_state public.bess_dispatch_daily_state%rowtype; v_existing public.bess_dispatch_assignments%rowtype;
  v_count integer; v_cursor bigint; v_total_steps integer:=0; v_i integer; v_j integer;
  v_req_id text; v_ctx jsonb; v_assignee text; v_step integer; v_new_seq bigint; v_idx bigint;
  v_any_new boolean:=false; v_replay_indices integer[]:=array[]::integer[];
begin
  if p_scope is null or p_scope not in ('default','test_default','ad','ad_review','ad_game')
     or p_scope='ad' or p_request_ids is null or array_length(p_request_ids,1)=0
     or p_direction not in ('forward','reverse','emergency_forward') then
    raise exception using errcode='22023',message='invalid assignment arguments';
  end if;
  if exists (select 1 from unnest(p_request_ids) id group by id having count(*)>1) then
    raise exception using errcode='22023',message='duplicate request id';
  end if;
  for v_j in 1..array_length(p_request_ids,1) loop
    v_req_id:=p_request_ids[v_j]; v_ctx:=coalesce(p_contexts->(v_j-1),'{}'::jsonb);
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text||':'||p_scope||':'||v_req_id));
    select assignment.* into v_existing from public.bess_dispatch_assignments assignment
     where assignment.day_key=p_day_key and assignment.scope=p_scope and assignment.request_id=v_req_id;
    if found then
      if nullif(btrim(v_existing.request_context->>'sheetId'),'') is not null
         and nullif(btrim(v_ctx->>'sheetId'),'') is not null
         and btrim(v_existing.request_context->>'sheetId')<>btrim(v_ctx->>'sheetId') then
        raise exception using errcode='P0001',message='IDEMPOTENCY_CONTEXT_MISMATCH:sheetId';
      end if;
      if nullif(btrim(v_existing.request_context->>'targetCategory'),'') is not null
         and nullif(btrim(v_ctx->>'targetCategory'),'') is not null
         and btrim(v_existing.request_context->>'targetCategory')<>btrim(v_ctx->>'targetCategory') then
        raise exception using errcode='P0001',message='IDEMPOTENCY_CONTEXT_MISMATCH:targetCategory';
      end if;
      v_replay_indices:=array_append(v_replay_indices,v_j);
    else v_any_new:=true; end if;
  end loop;
  if p_roster is not null then
    if p_scope in ('ad_review','ad_game') then perform * from public.bess_initialize_ad_rosters(p_day_key,p_roster,p_expires_at);
    else insert into public.bess_dispatch_daily_state(day_key,scope,roster,expires_at,status_confirmed,confirmed_roster_revision)
      values(p_day_key,p_scope,p_roster,p_expires_at,true,1) on conflict(day_key,scope) do nothing; end if;
  end if;
  if v_any_new then
    select state.* into v_state from public.bess_dispatch_daily_state state
     where state.day_key=p_day_key and state.scope=p_scope and state.expires_at>now() for update;
    if not found then raise exception using errcode='P0002',message='daily roster is not initialized or expired'; end if;
    if p_expected_version is not null and v_state.version<>p_expected_version then raise exception using errcode='P0001',message='CAS_ROSTER_VERSION_MISMATCH'; end if;
    if p_direction='forward' and p_expected_cursor_version is not null and v_state.forward_version<>p_expected_cursor_version then raise exception using errcode='P0001',message='CAS_FORWARD_CURSOR_MISMATCH'; end if;
    if p_direction='reverse' and p_expected_cursor_version is not null and v_state.reverse_version<>p_expected_cursor_version then raise exception using errcode='P0001',message='CAS_REVERSE_CURSOR_MISMATCH'; end if;
    if p_direction='emergency_forward' and p_expected_cursor_version is not null and v_state.emergency_forward_version<>p_expected_cursor_version then raise exception using errcode='P0001',message='CAS_EMERGENCY_FORWARD_CURSOR_MISMATCH'; end if;
  else
    select state.* into v_state from public.bess_dispatch_daily_state state where state.day_key=p_day_key and state.scope=p_scope;
    if not found then raise exception using errcode='P0002',message='daily roster is not initialized'; end if;
  end if;
  v_count:=jsonb_array_length(v_state.roster);
  if v_count<1 then raise exception using errcode='22023',message='stored roster is invalid'; end if;
  v_cursor:=case p_direction when 'forward' then v_state.forward_cursor when 'reverse' then v_state.reverse_cursor else v_state.emergency_forward_cursor end;
  v_new_seq:=v_state.assignment_seq;
  for v_j in 1..array_length(p_request_ids,1) loop
    v_req_id:=p_request_ids[v_j]; v_ctx:=coalesce(p_contexts->(v_j-1),'{}'::jsonb);
    if v_j=any(v_replay_indices) then
      select assignment.* into strict v_existing from public.bess_dispatch_assignments assignment
       where assignment.day_key=p_day_key and assignment.scope=p_scope and assignment.request_id=v_req_id;
      request_id:=v_req_id;assignee:=v_existing.assignee;roster:=v_state.roster;direction:=v_existing.direction;replayed:=true;assignment_seq:=v_existing.assignment_seq;
    else
      v_idx:=case when p_direction='reverse' then v_count-1-((v_cursor+v_total_steps)%v_count) else (v_cursor+v_total_steps)%v_count end;
      v_step:=0;
      for v_i in 0..v_count-1 loop
        v_assignee:=btrim(v_state.roster->>v_idx::integer);
        exit when not(v_state.off_duty?v_assignee);
        v_step:=v_step+1; v_idx:=case when p_direction='reverse' then (v_idx-1+v_count)%v_count else (v_idx+1)%v_count end;
        if v_i=v_count-1 then raise exception using errcode='P0001',message='ALL_OFF_DUTY'; end if;
      end loop;
      v_new_seq:=v_new_seq+1; v_total_steps:=v_total_steps+v_step+1;
      insert into public.bess_dispatch_assignments(day_key,scope,request_id,assignee,direction,assignment_seq,request_context)
       values(p_day_key,p_scope,v_req_id,v_assignee,p_direction,v_new_seq,v_ctx);
      request_id:=v_req_id;assignee:=v_assignee;roster:=v_state.roster;direction:=p_direction;replayed:=false;assignment_seq:=v_new_seq;
    end if;
    select pending.original_message_id into original_message_id from public.bess_dispatch_pending_forms pending where pending.request_id=v_req_id order by pending.created_at desc limit 1;
    version:=v_state.version;
    forward_version:=v_state.forward_version+case when v_total_steps>0 and p_direction='forward' then 1 else 0 end;
    reverse_version:=v_state.reverse_version+case when v_total_steps>0 and p_direction='reverse' then 1 else 0 end;
    emergency_forward_version:=v_state.emergency_forward_version+case when v_total_steps>0 and p_direction='emergency_forward' then 1 else 0 end;
    return next;
  end loop;
  if v_total_steps>0 then
    if p_direction='forward' then update public.bess_dispatch_daily_state state set forward_cursor=v_cursor+v_total_steps,forward_version=state.forward_version+1,assignment_seq=v_new_seq,updated_at=now() where state.day_key=p_day_key and state.scope=p_scope;
    elsif p_direction='reverse' then update public.bess_dispatch_daily_state state set reverse_cursor=v_cursor+v_total_steps,reverse_version=state.reverse_version+1,assignment_seq=v_new_seq,updated_at=now() where state.day_key=p_day_key and state.scope=p_scope;
    else update public.bess_dispatch_daily_state state set emergency_forward_cursor=v_cursor+v_total_steps,emergency_forward_version=state.emergency_forward_version+1,assignment_seq=v_new_seq,updated_at=now() where state.day_key=p_day_key and state.scope=p_scope; end if;
  end if;
end;
$$;

create function public.bess_assign_specific(p_day_key date,p_scope text,p_request_id text,p_assignee text,p_context jsonb default '{}'::jsonb)
returns table(assignee text,replayed boolean,version bigint,forward_version bigint,reverse_version bigint,assignment_seq bigint,emergency_forward_version bigint)
language plpgsql security definer set search_path='' as $$
declare v_state public.bess_dispatch_daily_state%rowtype;v_existing public.bess_dispatch_assignments%rowtype;
begin
  select state.* into v_state from public.bess_dispatch_daily_state state where state.day_key=p_day_key and state.scope=p_scope and state.expires_at>now() for update;
  if not found then raise exception using errcode='P0002',message='daily roster is not initialized or expired'; end if;
  if not(v_state.roster?btrim(p_assignee)) or v_state.off_duty?btrim(p_assignee) then raise exception using errcode='22023',message='assignee unavailable'; end if;
  select a.* into v_existing from public.bess_dispatch_assignments a where a.day_key=p_day_key and a.scope=p_scope and a.request_id=p_request_id;
  if found then return query select v_existing.assignee,true,v_state.version,v_state.forward_version,v_state.reverse_version,v_existing.assignment_seq,v_state.emergency_forward_version;return;end if;
  insert into public.bess_dispatch_assignments(day_key,scope,request_id,assignee,direction,request_context) values(p_day_key,p_scope,p_request_id,btrim(p_assignee),'specified',coalesce(p_context,'{}'::jsonb));
  return query select btrim(p_assignee),false,v_state.version,v_state.forward_version,v_state.reverse_version,null::bigint,v_state.emergency_forward_version;
end;
$$;

create function public.bess_calibrate_and_assign_next(
  p_day_key date,p_scope text,p_request_id text,p_direction text,p_assignee text,p_roster jsonb,
  p_expires_at timestamptz default null,p_context jsonb default '{}'::jsonb,
  p_expected_version bigint default null,p_expected_cursor_version bigint default null
) returns table(assignee text,roster jsonb,direction text,replayed boolean,original_message_id text,
  version bigint,forward_version bigint,reverse_version bigint,assignment_seq bigint,emergency_forward_version bigint)
language plpgsql security definer set search_path='' as $$
declare v_state public.bess_dispatch_daily_state%rowtype;v_existing public.bess_dispatch_assignments%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text||':'||p_scope||':'||p_request_id));
  select a.* into v_existing from public.bess_dispatch_assignments a where a.day_key=p_day_key and a.scope=p_scope and a.request_id=p_request_id;
  if found then return query select * from public.bess_assign_next(p_day_key,p_scope,p_request_id,p_direction,null,p_expires_at,p_context,p_expected_version,p_expected_cursor_version);return;end if;
  perform * from public.bess_calibrate_cursor(p_day_key,p_scope,p_direction,p_assignee,p_roster,p_expected_version,p_expected_cursor_version);
  select state.* into strict v_state from public.bess_dispatch_daily_state state where state.day_key=p_day_key and state.scope=p_scope;
  return query select * from public.bess_assign_next(p_day_key,p_scope,p_request_id,p_direction,null,p_expires_at,p_context,v_state.version,
    case p_direction when 'forward' then v_state.forward_version when 'reverse' then v_state.reverse_version else v_state.emergency_forward_version end);
end;
$$;

revoke all on function public.bess_calibrate_cursor(date,text,text,text,jsonb,bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function public.bess_assign_batch(date,text,text[],text,jsonb,timestamptz,jsonb,bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function public.bess_assign_specific(date,text,text,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.bess_calibrate_and_assign_next(date,text,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.bess_calibrate_cursor(date,text,text,text,jsonb,bigint,bigint) to service_role;
grant execute on function public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint) to service_role;
grant execute on function public.bess_assign_batch(date,text,text[],text,jsonb,timestamptz,jsonb,bigint,bigint) to service_role;
grant execute on function public.bess_assign_specific(date,text,text,text,jsonb) to service_role;
grant execute on function public.bess_calibrate_and_assign_next(date,text,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint) to service_role;

commit;
