-- Prevent a sheet-anchor calibration in one dispatch direction from moving
-- the independent cursor used by the opposite direction.
-- Keep the previous overload during rolling deployment; callers that send
-- p_direction resolve to this signature while old callers keep working.
begin;

create or replace function public.bess_calibrate_cursor(
  p_day_key date,
  p_scope text,
  p_direction text,
  p_assignee text,
  p_roster jsonb
)
returns setof public.bess_dispatch_daily_state
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_state public.bess_dispatch_daily_state%rowtype;
  v_index integer;
begin
  if p_scope not in ('default', 'ad') then
    raise exception 'INVALID_SCOPE' using errcode = 'P0001';
  end if;
  if p_direction not in ('forward', 'reverse') then
    raise exception 'INVALID_DIRECTION' using errcode = 'P0001';
  end if;

  select * into v_state
    from public.bess_dispatch_daily_state as state
   where state.day_key = p_day_key
     and state.scope = p_scope
     and state.expires_at > now()
   for update;

  if not found then
    raise exception 'DAILY_STATE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_roster is null or jsonb_typeof(p_roster) <> 'array' or p_roster <> v_state.roster then
    raise exception 'ROSTER_CHANGED' using errcode = 'P0001';
  end if;

  select item.ordinality - 1 into v_index
    from jsonb_array_elements_text(v_state.roster) with ordinality as item(value, ordinality)
   where btrim(item.value) = nullif(btrim(p_assignee), '')
   limit 1;
  if v_index is null then
    raise exception 'ASSIGNEE_NOT_IN_ROSTER' using errcode = 'P0001';
  end if;

  if p_direction = 'forward' then
    return query
      update public.bess_dispatch_daily_state as state
         set forward_cursor = v_index + 1,
             updated_at = now()
       where state.day_key = p_day_key and state.scope = p_scope
       returning state.*;
  else
    return query
      update public.bess_dispatch_daily_state as state
         set reverse_cursor = jsonb_array_length(v_state.roster) - v_index,
             updated_at = now()
       where state.day_key = p_day_key and state.scope = p_scope
       returning state.*;
  end if;
end;
$$;

revoke all on function public.bess_calibrate_cursor(date,text,text,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.bess_calibrate_cursor(date,text,text,text,jsonb)
  to service_role;

commit;
