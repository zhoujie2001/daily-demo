-- Operational rollback for roster-revision confirmation and emergency-forward dispatch.
-- Additive daily-state columns are intentionally retained: the currently deployed RPC
-- return row types and historical state may depend on them. This restores pre-feature
-- behavior without deleting off_duty or cursor history.
begin;

-- Never silently reinterpret an emergency assignment as a legacy direction.
do $$
begin
  if exists (select 1 from public.bess_dispatch_assignments where direction = 'emergency_forward') then
    raise exception using errcode = 'P0001',
      message = 'ROLLBACK_BLOCKED_EMERGENCY_ASSIGNMENTS_EXIST';
  end if;
end;
$$;

-- Remove the confirmation write entry point before its ledgers.
revoke all on function public.bess_update_ad_roster_statuses(date,jsonb,text,text,text)
  from public, anon, authenticated, service_role;
drop function if exists public.bess_update_ad_roster_statuses(date,jsonb,text,text,text);

-- Restore AD roster writers so future initialization/replacement also remains ungated.
create or replace function public.bess_initialize_ad_rosters(
  p_day_key date, p_roster jsonb, p_expires_at timestamptz
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
begin
  if p_day_key is null or p_expires_at is null or p_expires_at <= now()
     or jsonb_typeof(p_roster) <> 'array' or jsonb_array_length(p_roster) = 0 then
    raise exception using errcode = '22023', message = 'invalid AD roster initialization';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rosters'));
  if exists (select 1 from public.bess_dispatch_daily_state state
             where state.day_key=p_day_key and state.scope in ('ad_review','ad_game') and state.roster<>p_roster) then
    raise exception using errcode='P0001',message='ROSTER_CHANGED';
  end if;
  insert into public.bess_dispatch_daily_state(
    day_key,scope,roster,forward_cursor,reverse_cursor,emergency_forward_cursor,off_duty,
    version,forward_version,reverse_version,emergency_forward_version,roster_revision,
    status_confirmed,confirmed_roster_revision,expires_at
  ) select p_day_key,lane.scope,p_roster,0,0,0,'[]'::jsonb,1,1,1,1,1,true,1,p_expires_at
      from (values ('ad_review'::text),('ad_game'::text)) lane(scope)
     on conflict(day_key,scope) do nothing;
  perform public.bess_sync_legacy_ad_shadow(p_day_key);
  return query select state.* from public.bess_dispatch_daily_state state
    where state.day_key=p_day_key and state.scope in ('ad_review','ad_game') order by state.scope;
end;
$$;

create or replace function public.bess_replace_ad_rosters(
  p_day_key date,p_roster jsonb,p_expected_review_version bigint,p_expected_game_version bigint
) returns setof public.bess_dispatch_daily_state
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text || ':ad_rosters'));
  perform 1 from public.bess_dispatch_daily_state state
   where state.day_key=p_day_key and state.scope in ('ad_review','ad_game') for update;
  if (select count(*) from public.bess_dispatch_daily_state state where state.day_key=p_day_key and
      ((state.scope='ad_review' and state.version=p_expected_review_version)
       or (state.scope='ad_game' and state.version=p_expected_game_version)))<>2 then
    raise exception using errcode='40001',message='AD_ROSTER_UPDATE_CONFLICT';
  end if;
  update public.bess_dispatch_daily_state state set roster=p_roster,
    off_duty=coalesce((select jsonb_agg(person.value order by person.ordinality)
      from jsonb_array_elements_text(p_roster) with ordinality person(value,ordinality)
      where state.off_duty?person.value),'[]'::jsonb),
    roster_revision=state.roster_revision+1,status_confirmed=true,
    confirmed_roster_revision=state.roster_revision+1,status_confirmed_at=now(),
    version=state.version+1,forward_version=state.forward_version+1,
    reverse_version=state.reverse_version+1,emergency_forward_version=state.emergency_forward_version+1,
    updated_at=now()
   where state.day_key=p_day_key and state.scope in ('ad_review','ad_game');
  perform public.bess_sync_legacy_ad_shadow(p_day_key);
  return query select state.* from public.bess_dispatch_daily_state state
   where state.day_key=p_day_key and state.scope in ('ad_review','ad_game') order by state.scope;
end;
$$;

-- Disable the confirmation gate while retaining the existing per-scope off_duty values.
update public.bess_dispatch_daily_state state
   set status_confirmed = true,
       confirmed_roster_revision = state.roster_revision,
       status_confirmed_at = coalesce(state.status_confirmed_at, now()),
       updated_at = now()
 where state.scope in ('ad_review', 'ad_game');

drop table if exists public.bess_dispatch_confirmation_operations;
drop table if exists public.bess_dispatch_status_confirmations;

alter table public.bess_dispatch_assignments
  drop constraint if exists bess_dispatch_assignments_direction_check;
alter table public.bess_dispatch_assignments
  add constraint bess_dispatch_assignments_direction_check
  check (direction in ('forward', 'reverse', 'specified')) not valid;
alter table public.bess_dispatch_assignments
  validate constraint bess_dispatch_assignments_direction_check;

-- Keep emergency_forward_*, roster_revision and confirmation columns as inert additive
-- compatibility columns. Dropping them while the versioned RPCs return daily_state rows
-- is unsafe; a later maintenance migration may remove them after all callers/RPCs roll back.
commit;
