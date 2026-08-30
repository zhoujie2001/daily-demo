-- BESS P1 自动派单：可重复执行的结构迁移与权限加固（Supabase/PostgreSQL）。
--
-- 执行顺序：
--   1. 先执行本文件；2. 再执行 db/bess-dispatch-verify.sql。
-- 幂等边界：
--   * CREATE TABLE/COLUMN/INDEX 使用 IF [NOT] EXISTS；函数保持原 RPC 签名并使用
--     CREATE OR REPLACE；策略在同一事务内重建；权限先回收再按最小集合授予。
--   * 重复执行不会删除表、清空表，也不会 UPDATE/覆盖已有业务行。
--   * 若已有同名对象的结构与预期不兼容，本迁移不会尝试猜测或改写业务数据；
--     后续函数创建或验证脚本会明确失败，需人工修复结构/脏数据。
-- 安全边界：
--   * public 下三张业务表均 ENABLE + FORCE RLS；显式策略只面向 service_role。
--   * anon/authenticated/PUBLIC 无表、序列及 RPC 权限；service_role 仅获常规 DML、
--     identity 序列 USAGE、public schema USAGE 与必要 RPC EXECUTE
--     （不授予序列 SELECT/UPDATE 或表 TRUNCATE/REFERENCES/TRIGGER）。
--   * SECURITY DEFINER RPC 固定空 search_path、全限定对象名且不执行动态 SQL。
--   * 本文件不包含密码、Token、Service Role Key 或任何部署敏感值。

begin;

create table if not exists public.bess_dispatch_daily_state (
  day_key date primary key,
  roster jsonb not null
    check (jsonb_typeof(roster) = 'array' and jsonb_array_length(roster) > 0),
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

-- 从早期版本升级时只补充可空状态列；不回填、不覆盖已有行。
alter table public.bess_dispatch_pending_forms
  add column if not exists completed_at timestamptz;

create table if not exists public.bess_dispatch_assignments (
  id bigint generated always as identity primary key,
  day_key date not null
    references public.bess_dispatch_daily_state(day_key) on delete cascade,
  request_id text not null,
  assignee text not null,
  direction text not null check (direction in ('forward', 'reverse')),
  request_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (day_key, request_id)
);

create index if not exists bess_dispatch_state_expiry_idx
  on public.bess_dispatch_daily_state (expires_at);
create index if not exists bess_dispatch_pending_expiry_idx
  on public.bess_dispatch_pending_forms (expires_at);

-- 只读 preflight：同输入签名的历史函数若 OUT 名称/类型/顺序不兼容，
-- CREATE OR REPLACE 无法安全改变返回契约。此时在任何函数 DDL 前明确失败，
-- 不 DROP 函数，也不改写任何业务数据。
do $rpc_contract_preflight$
declare
  v_function regprocedure := to_regprocedure(
    'public.bess_assign_next(date,text,text,jsonb,timestamp with time zone,jsonb)'
  );
begin
  if v_function is not null and not exists (
    select 1
    from pg_catalog.pg_proc as p
    where p.oid = v_function
      and p.proretset
      and p.prorettype = 'record'::regtype
      and p.proargnames = array[
        'p_day_key','p_request_id','p_direction','p_roster','p_expires_at','p_context',
        'assignee','roster','direction','replayed','original_message_id'
      ]
      and p.proargmodes = array['i','i','i','i','i','i','t','t','t','t','t']::"char"[]
      and p.proallargtypes = array[
        'date'::regtype, 'text'::regtype, 'text'::regtype, 'jsonb'::regtype,
        'timestamptz'::regtype, 'jsonb'::regtype, 'text'::regtype, 'jsonb'::regtype,
        'text'::regtype, 'boolean'::regtype, 'text'::regtype
      ]::oid[]
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'existing bess_assign_next RPC has an incompatible OUT contract; migration aborted without dropping the function or modifying business data';
  end if;
end
$rpc_contract_preflight$;

-- CREATE OR REPLACE 保留 REST/RPC 名称、六个入参（含默认值）及五列返回结构。
create or replace function public.bess_assign_next(
  p_day_key date,
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
  v_original_message_id text;
begin
  if p_day_key is null then
    raise exception using errcode = '22004', message = 'day key required';
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

    insert into public.bess_dispatch_daily_state(day_key, roster, expires_at)
    values (p_day_key, p_roster, p_expires_at)
    on conflict (day_key) do nothing;
  end if;

  select state.*
    into v_state
    from public.bess_dispatch_daily_state as state
   where state.day_key = p_day_key
     and state.expires_at > now()
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'daily roster is not initialized or expired';
  end if;

  -- 防御旧数据：避免 NULL/非字符串名单导致静默派出空负责人。
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
     and assignment.request_id = p_request_id;

  if found then
    return query
      select v_existing.assignee,
             v_state.roster,
             v_existing.direction,
             true,
             v_original_message_id;
    return;
  end if;

  v_count := jsonb_array_length(v_state.roster);
  if p_direction = 'forward' then
    v_index := v_state.forward_cursor % v_count;
    update public.bess_dispatch_daily_state as state
       set forward_cursor = state.forward_cursor + 1,
           updated_at = now()
     where state.day_key = p_day_key;
  else
    v_index := v_count - 1 - (v_state.reverse_cursor % v_count);
    update public.bess_dispatch_daily_state as state
       set reverse_cursor = state.reverse_cursor + 1,
           updated_at = now()
     where state.day_key = p_day_key;
  end if;

  assignee := v_state.roster ->> v_index::integer;
  roster := v_state.roster;
  direction := p_direction;
  replayed := false;
  original_message_id := v_original_message_id;

  insert into public.bess_dispatch_assignments(
    day_key, request_id, assignee, direction, request_context
  ) values (
    p_day_key, p_request_id, assignee, p_direction, coalesce(p_context, '{}'::jsonb)
  );

  return next;
end;
$$;

alter table public.bess_dispatch_daily_state enable row level security;
alter table public.bess_dispatch_daily_state force row level security;
alter table public.bess_dispatch_pending_forms enable row level security;
alter table public.bess_dispatch_pending_forms force row level security;
alter table public.bess_dispatch_assignments enable row level security;
alter table public.bess_dispatch_assignments force row level security;

-- 策略重建包含在事务中，重复执行结果一致且不存在无策略窗口。
-- 为消除历史遗留的宽松策略，先从系统目录枚举并安全引用标识符后全部移除；
-- 动态 SQL 仅用于 DDL 标识符，不接收任何外部输入，RPC 本身不使用动态 SQL。
do $drop_policies$
declare
  v_policy record;
begin
  for v_policy in
    select schemaname, tablename, policyname
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in (
        'bess_dispatch_daily_state',
        'bess_dispatch_pending_forms',
        'bess_dispatch_assignments'
      )
  loop
    execute format(
      'drop policy %I on %I.%I',
      v_policy.policyname,
      v_policy.schemaname,
      v_policy.tablename
    );
  end loop;
end
$drop_policies$;

create policy bess_dispatch_service_role_only
  on public.bess_dispatch_daily_state
  for all
  to service_role
  using (true)
  with check (true);

create policy bess_dispatch_service_role_only
  on public.bess_dispatch_pending_forms
  for all
  to service_role
  using (true)
  with check (true);

create policy bess_dispatch_service_role_only
  on public.bess_dispatch_assignments
  for all
  to service_role
  using (true)
  with check (true);

-- public schema 可能承载项目其他应用；不得全局 REVOKE PUBLIC/anon/authenticated 的
-- schema 权限，仅确保 service_role 能解析本迁移使用的全限定对象。
grant usage on schema public to service_role;

-- 先清除本迁移对象的历史宽授权，再仅授予服务端调用所需权限。
revoke all on table
  public.bess_dispatch_daily_state,
  public.bess_dispatch_pending_forms,
  public.bess_dispatch_assignments
from public, anon, authenticated, service_role;

grant select, insert, update, delete on table
  public.bess_dispatch_daily_state,
  public.bess_dispatch_pending_forms,
  public.bess_dispatch_assignments
  to service_role;

revoke all on sequence public.bess_dispatch_assignments_id_seq
  from public, anon, authenticated, service_role;
grant usage on sequence public.bess_dispatch_assignments_id_seq
  to service_role;

revoke all on function public.bess_assign_next(date, text, text, jsonb, timestamptz, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.bess_assign_next(date, text, text, jsonb, timestamptz, jsonb)
  to service_role;

commit;
