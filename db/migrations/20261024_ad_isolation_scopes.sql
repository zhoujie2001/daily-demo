-- 20261024_ad_isolation_scopes.sql
-- Add bounded, run-scoped AD test lanes without widening dispatch scope to arbitrary text.
-- Isolation lanes use daily_state.off_duty and never participate in legacy AD shadows.
begin;

create or replace function public.bess_is_valid_dispatch_scope(p_scope text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_scope in ('default', 'test_default', 'ad', 'ad_review', 'ad_game')
    or (
      p_scope ~ '^(ad_isolation|ad_game_isolation):[a-z0-9][a-z0-9_-]{0,31}$'
      and pg_catalog.split_part(p_scope, ':', 2) not in ('ad', 'ad_game')
    ),
    false
  )
$$;

revoke all on function public.bess_is_valid_dispatch_scope(text)
  from public, anon, authenticated, service_role;
grant execute on function public.bess_is_valid_dispatch_scope(text)
  to service_role;

alter table public.bess_dispatch_daily_state
  drop constraint if exists bess_dispatch_daily_state_scope_check;
alter table public.bess_dispatch_daily_state
  add constraint bess_dispatch_daily_state_scope_check
  check (public.bess_is_valid_dispatch_scope(scope));

alter table public.bess_dispatch_assignments
  drop constraint if exists bess_dispatch_assignments_scope_check;
alter table public.bess_dispatch_assignments
  add constraint bess_dispatch_assignments_scope_check
  check (public.bess_is_valid_dispatch_scope(scope));

-- Preserve the currently deployed hardened RPC bodies and replace only their exact
-- five-scope guard. This is intentionally fail-closed if an unexpected body is present.
do $migration$
declare
  v_oid oid;
  v_signature text;
  v_definition text;
  v_old constant text := 'p_scope not in (''default'', ''test_default'', ''ad'', ''ad_review'', ''ad_game'')';
  v_new constant text := 'not public.bess_is_valid_dispatch_scope(p_scope)';
begin
  foreach v_signature in array array[
    'public.bess_assign_next(date,text,text,text,jsonb,timestamp with time zone,jsonb,bigint,bigint)',
    'public.bess_assign_specific(date,text,text,text,jsonb)',
    'public.bess_calibrate_cursor(date,text,text,text,jsonb,bigint,bigint)',
    'public.bess_update_roster_status(date,text,jsonb,bigint)',
    'public.bess_assign_batch(date,text,text[],text,jsonb,timestamp with time zone,jsonb,bigint,bigint)'
  ] loop
    v_oid := pg_catalog.to_regprocedure(v_signature);
    if v_oid is null then
      raise exception using errcode = 'P0001', message = format('required dispatch RPC missing: %s', v_signature);
    end if;
    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    if pg_catalog.strpos(pg_catalog.lower(v_definition), 'bess_dispatch_person_status') > 0 then
      raise exception using errcode = 'P0001', message = format(
        'unsafe shared person_status reference in dispatch RPC: %s', v_signature
      );
    end if;
    if pg_catalog.strpos(v_definition, v_old) > 0 then
      execute pg_catalog.replace(v_definition, v_old, v_new);
    elsif pg_catalog.strpos(v_definition, v_new) = 0 then
      raise exception using errcode = 'P0001', message = format('scope guard not found in dispatch RPC: %s', v_signature);
    end if;
  end loop;
end;
$migration$;

-- Atomic manual-anchor recovery delegates to guarded RPCs, but validates at its
-- own boundary as well so malformed scopes cannot reach either operation.
create or replace function public.bess_calibrate_and_assign_next(
  p_day_key date, p_scope text, p_request_id text, p_direction text,
  p_assignee text, p_roster jsonb, p_expires_at timestamptz default null,
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
begin
  if not public.bess_is_valid_dispatch_scope(p_scope) then
    raise exception using errcode = '22023', message = 'invalid dispatch scope';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(
    p_day_key::text || ':' || p_scope || ':' || p_request_id
  ));
  select assignment.* into v_existing
    from public.bess_dispatch_assignments assignment
   where assignment.day_key = p_day_key and assignment.scope = p_scope
     and assignment.request_id = p_request_id;
  if found then
    return query select * from public.bess_assign_next(
      p_day_key, p_scope, p_request_id, p_direction, null, p_expires_at,
      coalesce(p_context, '{}'::jsonb), p_expected_version, p_expected_cursor_version
    );
    return;
  end if;
  perform * from public.bess_calibrate_cursor(
    p_day_key, p_scope, p_direction, p_assignee, p_roster,
    p_expected_version, p_expected_cursor_version
  );
  select state.* into strict v_state
    from public.bess_dispatch_daily_state state
   where state.day_key = p_day_key and state.scope = p_scope;
  return query select * from public.bess_assign_next(
    p_day_key, p_scope, p_request_id, p_direction, null, p_expires_at,
    coalesce(p_context, '{}'::jsonb), v_state.version,
    case when p_direction = 'forward' then v_state.forward_version else v_state.reverse_version end
  );
end;
$$;

revoke all on function public.bess_calibrate_and_assign_next(date,text,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.bess_calibrate_and_assign_next(date,text,text,text,text,jsonb,timestamptz,jsonb,bigint,bigint)
  to service_role;

commit;
