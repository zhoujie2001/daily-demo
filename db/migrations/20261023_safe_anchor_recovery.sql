-- Safe anchor recovery: calibration and allocation are one database transaction.
-- There is intentionally no client-side compatibility fallback. A deployment
-- without this RPC must fail closed rather than claim atomic recovery.
begin;

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
  -- Serialize the absent-row decision before touching the cursor. A replay must
  -- remain read-only, including when it races the original request.
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

  -- The state row lock is shared by calibration and assignment. The first RPC
  -- validates roster + both CAS tokens and advances only the selected direction.
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
