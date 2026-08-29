-- BESS P1 自动派单持久化与原子轮转（在 Supabase SQL Editor 执行）
create table if not exists public.bess_dispatch_daily_state (
  day_key date primary key,
  roster jsonb not null check (jsonb_typeof(roster) = 'array' and jsonb_array_length(roster) > 0),
  forward_cursor bigint not null default 0 check (forward_cursor >= 0),
  reverse_cursor bigint not null default 0 check (reverse_cursor >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bess_dispatch_pending_forms (
  form_message_id text primary key,
  request_id text not null,
  original_message_id text not null,
  chat_id text not null,
  request_context jsonb not null,
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (request_id)
);
alter table public.bess_dispatch_pending_forms add column if not exists completed_at timestamptz;

create table if not exists public.bess_dispatch_assignments (
  id bigint generated always as identity primary key,
  day_key date not null references public.bess_dispatch_daily_state(day_key) on delete cascade,
  request_id text not null,
  assignee text not null,
  direction text not null check (direction in ('forward', 'reverse')),
  request_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (day_key, request_id)
);

create index if not exists bess_dispatch_state_expiry_idx on public.bess_dispatch_daily_state(expires_at);
create index if not exists bess_dispatch_pending_expiry_idx on public.bess_dispatch_pending_forms(expires_at);

drop function if exists public.bess_assign_next(date,text,text,jsonb,timestamptz,jsonb);
create function public.bess_assign_next(
  p_day_key date,
  p_request_id text,
  p_direction text,
  p_roster jsonb default null,
  p_expires_at timestamptz default null,
  p_context jsonb default '{}'::jsonb
) returns table (assignee text, roster jsonb, direction text, replayed boolean, original_message_id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.bess_dispatch_daily_state%rowtype;
  v_existing public.bess_dispatch_assignments%rowtype;
  v_count integer;
  v_index bigint;
  v_original_message_id text;
begin
  if p_direction not in ('forward', 'reverse') then raise exception 'invalid direction'; end if;
  if p_request_id is null or p_request_id = '' then raise exception 'request id required'; end if;

  if p_roster is not null then
    if jsonb_typeof(p_roster) <> 'array' or jsonb_array_length(p_roster) = 0 then raise exception 'invalid roster'; end if;
    insert into public.bess_dispatch_daily_state(day_key, roster, expires_at)
    values (p_day_key, p_roster, p_expires_at)
    on conflict (day_key) do nothing;
  end if;

  select * into v_state from public.bess_dispatch_daily_state
  where day_key = p_day_key and expires_at > now() for update;
  if not found then raise exception 'daily roster is not initialized or expired'; end if;

  select pf.original_message_id into v_original_message_id
  from public.bess_dispatch_pending_forms pf
  where pf.request_id = p_request_id
  order by pf.created_at desc limit 1;

  select * into v_existing from public.bess_dispatch_assignments
  where day_key = p_day_key and request_id = p_request_id;
  if found then
    return query select v_existing.assignee, v_state.roster, v_existing.direction, true, v_original_message_id;
    return;
  end if;

  v_count := jsonb_array_length(v_state.roster);
  if p_direction = 'forward' then
    v_index := v_state.forward_cursor % v_count;
    update public.bess_dispatch_daily_state set forward_cursor = forward_cursor + 1, updated_at = now() where day_key = p_day_key;
  else
    v_index := v_count - 1 - (v_state.reverse_cursor % v_count);
    update public.bess_dispatch_daily_state set reverse_cursor = reverse_cursor + 1, updated_at = now() where day_key = p_day_key;
  end if;

  assignee := v_state.roster ->> v_index::integer;
  roster := v_state.roster;
  direction := p_direction;
  replayed := false;
  original_message_id := v_original_message_id;
  insert into public.bess_dispatch_assignments(day_key, request_id, assignee, direction, request_context)
  values (p_day_key, p_request_id, assignee, p_direction, coalesce(p_context, '{}'::jsonb));
  return next;
end;
$$;

alter table public.bess_dispatch_daily_state enable row level security;
alter table public.bess_dispatch_pending_forms enable row level security;
alter table public.bess_dispatch_assignments enable row level security;
revoke all on public.bess_dispatch_daily_state, public.bess_dispatch_pending_forms, public.bess_dispatch_assignments from anon, authenticated;
revoke all on function public.bess_assign_next(date,text,text,jsonb,timestamptz,jsonb) from public, anon, authenticated;
grant all on public.bess_dispatch_daily_state, public.bess_dispatch_pending_forms, public.bess_dispatch_assignments to service_role;
grant usage, select on sequence public.bess_dispatch_assignments_id_seq to service_role;
grant execute on function public.bess_assign_next(date,text,text,jsonb,timestamptz,jsonb) to service_role;
