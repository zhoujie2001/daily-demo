-- Keep Qianchuan forward and local-promo reverse cursors fully independent.
-- This replaces only the current scope-aware production RPC signature and keeps
-- its five-column return contract, idempotency key and daily-state row lock.
begin;

-- CREATE OR REPLACE cannot change OUT columns safely. Abort before function DDL
-- if an object with the production input signature has an incompatible contract.
do $rpc_contract_preflight$
declare
  v_function regprocedure := to_regprocedure(
    'public.bess_assign_next(date,text,text,text,jsonb,timestamp with time zone,jsonb)'
  );
begin
  if v_function is not null and not exists (
    select 1
      from pg_catalog.pg_proc as p
     where p.oid = v_function
       and p.proretset
       and p.prorettype = 'record'::regtype
       and p.proargnames = array[
         'p_day_key','p_scope','p_request_id','p_direction','p_roster','p_expires_at','p_context',
         'assignee','roster','direction','replayed','original_message_id'
       ]
       and p.proargmodes = array['i','i','i','i','i','i','i','t','t','t','t','t']::"char"[]
       and p.proallargtypes = array[
         'date'::regtype, 'text'::regtype, 'text'::regtype, 'text'::regtype,
         'jsonb'::regtype, 'timestamptz'::regtype, 'jsonb'::regtype,
         'text'::regtype, 'jsonb'::regtype, 'text'::regtype, 'boolean'::regtype,
         'text'::regtype
       ]::oid[]
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'existing scope-aware bess_assign_next RPC has an incompatible OUT contract';
  end if;
end
$rpc_contract_preflight$;

create or replace function public.bess_assign_next(
  p_day_key date,
  p_scope text,
  p_request_id text,
  p_direction text,
  p_roster jsonb default null,
  p_expires_at timestamptz default null,
  p_context jsonb default '{}'::jsonb
) returns table (
  assignee text,
  roster jsonb,
  direction text,
  replayed boolean,
  original_message_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.bess_dispatch_daily_state%rowtype;
  v_existing public.bess_dispatch_assignments%rowtype;
  v_count integer;
  v_index bigint;
  v_anchor_index bigint;
  v_original_message_id text;
  v_i integer;
begin
  if p_day_key is null then
    raise exception using errcode = '22004', message = 'day key required';
  end if;
  if p_scope is null or p_scope not in ('default', 'ad') then
    raise exception using errcode = '22023', message = 'invalid dispatch scope';
  end if;
  if p_request_id is null or btrim(p_request_id) = '' then
    raise exception using errcode = '22023', message = 'request id required';
  end if;
  if p_direction is null or p_direction not in ('forward', 'reverse') then
    raise exception using errcode = '22023', message = 'invalid direction';
  end if;

  if p_roster is not null then
    if p_expires_at is null or p_expires_at <= now() then
      raise exception using errcode = '22023', message = 'future expiry required for roster initialization';
    end if;
    if jsonb_typeof(p_roster) <> 'array' or jsonb_array_length(p_roster) = 0 then
      raise exception using errcode = '22023', message = 'invalid roster';
    end if;
    if exists (
      select 1
        from jsonb_array_elements(p_roster) as item(value)
       where jsonb_typeof(item.value) <> 'string'
          or btrim(item.value #>> '{}') = ''
    ) then
      raise exception using errcode = '22023', message = 'roster entries must be non-empty strings';
    end if;

    insert into public.bess_dispatch_daily_state(day_key, scope, roster, expires_at)
    values (p_day_key, p_scope, p_roster, p_expires_at)
    on conflict (day_key, scope) do nothing;
  end if;

  select state.*
    into v_state
    from public.bess_dispatch_daily_state as state
   where state.day_key = p_day_key
     and state.scope = p_scope
     and state.expires_at > now()
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'daily roster is not initialized or expired';
  end if;

  if jsonb_typeof(v_state.roster) <> 'array'
     or jsonb_array_length(v_state.roster) = 0
     or exists (
       select 1
         from jsonb_array_elements(v_state.roster) as item(value)
        where jsonb_typeof(item.value) <> 'string'
           or btrim(item.value #>> '{}') = ''
     ) then
    raise exception using errcode = '22023', message = 'stored roster is invalid';
  end if;

  select pending.original_message_id
    into v_original_message_id
    from public.bess_dispatch_pending_forms as pending
   where pending.request_id = p_request_id
   order by pending.created_at desc
   limit 1;

  select assignment.*
    into v_existing
    from public.bess_dispatch_assignments as assignment
   where assignment.day_key = p_day_key
     and assignment.scope = p_scope
     and assignment.request_id = p_request_id;

  if found then
    return query
      select v_existing.assignee, v_state.roster, v_existing.direction, true,
             v_original_message_id;
    return;
  end if;

  v_count := jsonb_array_length(v_state.roster);

  select item.ordinality - 1
    into v_anchor_index
    from jsonb_array_elements_text(v_state.roster) with ordinality as item(value, ordinality)
   where btrim(item.value) = nullif(btrim(p_context ->> 'anchor_assignee'), '')
   limit 1;

  if v_anchor_index is not null then
    if p_direction = 'forward' then
      v_index := (v_anchor_index + 1) % v_count;
    else
      v_index := (v_anchor_index - 1 + v_count) % v_count;
    end if;
  elsif p_direction = 'forward' then
    v_index := v_state.forward_cursor % v_count;
  else
    v_index := v_count - 1 - (v_state.reverse_cursor % v_count);
  end if;

  for v_i in 0..v_count-1 loop
    assignee := btrim(v_state.roster ->> v_index::integer);
    if not (v_state.off_duty ? assignee) then
      exit;
    end if;
    if p_direction = 'forward' then
      v_index := (v_index + 1) % v_count;
    else
      v_index := (v_index - 1 + v_count) % v_count;
    end if;
    if v_i = v_count - 1 then
      raise exception using errcode = 'P0001', message = 'ALL_OFF_DUTY';
    end if;
  end loop;

  if p_direction = 'forward' then
    update public.bess_dispatch_daily_state as state
       set forward_cursor = v_index + 1,
           updated_at = now()
     where state.day_key = p_day_key
       and state.scope = p_scope;
  else
    update public.bess_dispatch_daily_state as state
       set reverse_cursor = v_count - v_index,
           updated_at = now()
     where state.day_key = p_day_key
       and state.scope = p_scope;
  end if;

  roster := v_state.roster;
  direction := p_direction;
  replayed := false;
  original_message_id := v_original_message_id;

  insert into public.bess_dispatch_assignments(
    day_key, scope, request_id, assignee, direction, request_context
  ) values (
    p_day_key, p_scope, p_request_id, assignee, p_direction,
    coalesce(p_context, '{}'::jsonb)
  );

  return next;
end;
$$;

revoke all on function public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.bess_assign_next(date,text,text,text,jsonb,timestamptz,jsonb)
  to service_role;

commit;
