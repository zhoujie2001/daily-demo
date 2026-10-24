-- Add a third, independent AD emergency roster lane without rewriting the published
-- 20261024_ad_status_confirmation_emergency_cursor migration.
--
-- Compatibility / rollback:
-- * Existing ad_review/ad_game rows and assignments are not deleted or rewritten.
-- * Emergency state is copied once from ad_review; assignment history is intentionally
--   not copied, so the new lane starts with independent cursors and versions.
-- * The legacy four-argument bess_replace_ad_rosters overload remains as a wrapper
--   for rolling deployments. New callers use the five-argument overload.
-- * A rollback may switch application traffic back to ad_review and leave the new
--   state dormant. Dropping ad_emergency data is intentionally not automated.
begin;

create or replace function public.bess_is_valid_dispatch_scope(p_scope text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(
    p_scope in ('default', 'test_default', 'ad', 'ad_review', 'ad_game', 'ad_emergency')
    or (
      p_scope ~ '^(ad_isolation|ad_game_isolation):[a-z0-9][a-z0-9_-]{0,31}$'
      and pg_catalog.split_part(p_scope, ':', 2) not in ('ad', 'ad_game')
    ), false
  )
$$;
revoke all on function public.bess_is_valid_dispatch_scope(text) from public, anon, authenticated, service_role;
grant execute on function public.bess_is_valid_dispatch_scope(text) to service_role;

alter table public.bess_dispatch_daily_state drop constraint if exists bess_dispatch_daily_state_scope_check;
alter table public.bess_dispatch_daily_state add constraint bess_dispatch_daily_state_scope_check
  check (public.bess_is_valid_dispatch_scope(scope)) not valid;
alter table public.bess_dispatch_daily_state validate constraint bess_dispatch_daily_state_scope_check;
alter table public.bess_dispatch_assignments drop constraint if exists bess_dispatch_assignments_scope_check;
alter table public.bess_dispatch_assignments add constraint bess_dispatch_assignments_scope_check
  check (public.bess_is_valid_dispatch_scope(scope)) not valid;
alter table public.bess_dispatch_assignments validate constraint bess_dispatch_assignments_scope_check;

alter table public.bess_dispatch_status_confirmations
  drop constraint if exists bess_dispatch_status_confirmations_scope_check;
alter table public.bess_dispatch_status_confirmations
  add constraint bess_dispatch_status_confirmations_scope_check
  check (scope in ('ad_review', 'ad_game', 'ad_emergency')) not valid;
alter table public.bess_dispatch_status_confirmations
  validate constraint bess_dispatch_status_confirmations_scope_check;

-- Seed one durable, independent emergency state for every existing review day.
insert into public.bess_dispatch_daily_state(
  day_key, scope, roster, forward_cursor, reverse_cursor, emergency_forward_cursor,
  off_duty, version, forward_version, reverse_version, emergency_forward_version,
  assignment_seq, expires_at, created_at, updated_at, roster_revision,
  status_confirmed, confirmed_roster_revision, status_confirmed_at, status_confirmed_by
)
select state.day_key, 'ad_emergency', state.roster, 0, 0, 0,
       state.off_duty, 1, 1, 1, 1, 0, state.expires_at, now(), now(),
       state.roster_revision, true, state.roster_revision, now(), state.status_confirmed_by
  from public.bess_dispatch_daily_state state
 where state.scope = 'ad_review'
on conflict (day_key, scope) do nothing;

-- Confirmation metadata remains callback-compatible, but is no longer a dispatch gate.
update public.bess_dispatch_daily_state state
   set status_confirmed = true,
       confirmed_roster_revision = state.roster_revision,
       status_confirmed_at = coalesce(state.status_confirmed_at, state.updated_at)
 where state.scope in ('ad_review', 'ad_game', 'ad_emergency')
   and (not state.status_confirmed
        or state.confirmed_roster_revision is distinct from state.roster_revision);

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
     or jsonb_array_length(p_updates) not between 1 and 3
     or nullif(btrim(p_confirmation_operation_id), '') is null
     or nullif(btrim(p_submission_hash), '') is null then
    raise exception using errcode = '22023', message = 'invalid AD status confirmation';
  end if;
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
   where state.day_key = p_day_key and state.scope in ('ad_review', 'ad_game', 'ad_emergency')
   order by state.scope for update;
  select count(*) into v_count from jsonb_array_elements(p_updates) item
   where item->>'scope' in ('ad_review', 'ad_game', 'ad_emergency');
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
       set off_duty = v_update->'off_duty', status_confirmed = true,
           confirmed_roster_revision = state.roster_revision,
           status_confirmed_at = now(), status_confirmed_by = p_confirmed_by,
           version = state.version + 1, forward_version = state.forward_version + 1,
           reverse_version = state.reverse_version + 1,
           emergency_forward_version = state.emergency_forward_version + 1,
           updated_at = now()
     where state.day_key = p_day_key and state.scope = v_update->>'scope';
  end loop;
  select jsonb_build_object('replayed', false,
    'states', jsonb_agg(to_jsonb(state) order by state.scope)) into v_result
    from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key
     and state.scope in (select item->>'scope' from jsonb_array_elements(p_updates) item);
  for v_update in select value from jsonb_array_elements(p_updates) loop
    insert into public.bess_dispatch_status_confirmations(day_key, scope, roster_revision, confirmed_by)
    values (p_day_key, v_update->>'scope', (v_update->>'expected_roster_revision')::bigint, p_confirmed_by)
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
              where state.day_key = p_day_key and state.scope in ('ad_review','ad_game','ad_emergency')
                and state.roster <> p_roster) then
    raise exception using errcode = 'P0001', message = 'ROSTER_CHANGED';
  end if;
  insert into public.bess_dispatch_daily_state(
    day_key, scope, roster, forward_cursor, reverse_cursor, emergency_forward_cursor,
    off_duty, version, forward_version, reverse_version, emergency_forward_version,
    roster_revision, status_confirmed, confirmed_roster_revision, expires_at
  ) select p_day_key, lane.scope, p_roster, 0, 0, 0, '[]'::jsonb,
           1, 1, 1, 1, 1, true, 1, p_expires_at
      from (values ('ad_review'::text), ('ad_game'::text), ('ad_emergency'::text)) lane(scope)
  on conflict (day_key, scope) do nothing;
  perform public.bess_sync_legacy_ad_shadow(p_day_key);
  return query select state.* from public.bess_dispatch_daily_state state
    where state.day_key = p_day_key and state.scope in ('ad_review','ad_game','ad_emergency') order by state.scope;
end;
$$;
revoke all on function public.bess_initialize_ad_rosters(date,jsonb,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.bess_initialize_ad_rosters(date,jsonb,timestamptz) to service_role;

create or replace function public.bess_replace_ad_rosters(
  p_day_key date, p_roster jsonb, p_expected_review_version bigint,
  p_expected_game_version bigint, p_expected_emergency_version bigint
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
begin
  if p_day_key is null or jsonb_typeof(p_roster) <> 'array' or jsonb_array_length(p_roster) = 0 then
    raise exception using errcode = '22023', message = 'invalid AD roster replacement';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rosters'));
  perform 1 from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope in ('ad_review','ad_game','ad_emergency') for update;
  if (select count(*) from public.bess_dispatch_daily_state state where state.day_key = p_day_key and
      ((state.scope='ad_review' and state.version=p_expected_review_version)
       or (state.scope='ad_game' and state.version=p_expected_game_version)
       or (state.scope='ad_emergency' and state.version=p_expected_emergency_version))) <> 3 then
    raise exception using errcode = '40001', message = 'AD_ROSTER_UPDATE_CONFLICT';
  end if;
  update public.bess_dispatch_daily_state state
     set roster = p_roster,
         off_duty = coalesce((select jsonb_agg(person.value order by person.ordinality)
           from jsonb_array_elements_text(p_roster) with ordinality person(value, ordinality)
          where state.off_duty ? person.value), '[]'::jsonb),
         roster_revision = state.roster_revision + 1,
         status_confirmed = true, confirmed_roster_revision = state.roster_revision + 1,
         status_confirmed_at = now(), status_confirmed_by = null,
         version = state.version + 1, forward_version = state.forward_version + 1,
         reverse_version = state.reverse_version + 1,
         emergency_forward_version = state.emergency_forward_version + 1,
         updated_at = now()
   where state.day_key = p_day_key and state.scope in ('ad_review','ad_game','ad_emergency');
  perform public.bess_sync_legacy_ad_shadow(p_day_key);
  return query select state.* from public.bess_dispatch_daily_state state
   where state.day_key=p_day_key and state.scope in ('ad_review','ad_game','ad_emergency') order by state.scope;
end;
$$;
revoke all on function public.bess_replace_ad_rosters(date,jsonb,bigint,bigint,bigint) from public, anon, authenticated, service_role;
grant execute on function public.bess_replace_ad_rosters(date,jsonb,bigint,bigint,bigint) to service_role;

-- Keep the published four-argument API for an old application instance during rollout.
create or replace function public.bess_replace_ad_rosters(
  p_day_key date, p_roster jsonb, p_expected_review_version bigint, p_expected_game_version bigint
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
declare v_emergency_version bigint;
begin
  select state.version into v_emergency_version
    from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope = 'ad_emergency';
  if v_emergency_version is null then
    raise exception using errcode = '40001', message = 'AD_ROSTER_UPDATE_CONFLICT';
  end if;
  return query select * from public.bess_replace_ad_rosters(
    p_day_key, p_roster, p_expected_review_version, p_expected_game_version, v_emergency_version
  );
end;
$$;
revoke all on function public.bess_replace_ad_rosters(date,jsonb,bigint,bigint) from public, anon, authenticated, service_role;
grant execute on function public.bess_replace_ad_rosters(date,jsonb,bigint,bigint) to service_role;

commit;
