-- BESS 双 scope 自动派单：只读迁移验收脚本（PostgreSQL 15）。
--
-- 执行顺序：db/bess-dispatch.sql 后按时间顺序执行派单 migration，再执行本文件。
-- 本脚本只读系统目录，不读取业务行，也不创建、修改或删除对象。
begin transaction read only;

do $verify$
declare
  v_errors text[] := array[]::text[];
  v_table regclass;
  v_function regprocedure;
  v_role oid;
  v_count integer;
  v_definition text;
  v_name text;
  v_signature text;
  v_column text[];
  v_columns text[][] := array[
    ['bess_dispatch_daily_state', 'day_key', 'date', 'NO'],
    ['bess_dispatch_daily_state', 'scope', 'text', 'NO'],
    ['bess_dispatch_daily_state', 'roster', 'jsonb', 'NO'],
    ['bess_dispatch_daily_state', 'forward_cursor', 'bigint', 'NO'],
    ['bess_dispatch_daily_state', 'reverse_cursor', 'bigint', 'NO'],
    ['bess_dispatch_daily_state', 'off_duty', 'jsonb', 'NO'],
    ['bess_dispatch_daily_state', 'version', 'bigint', 'NO'],
    ['bess_dispatch_daily_state', 'expires_at', 'timestamp with time zone', 'NO'],
    ['bess_dispatch_daily_state', 'created_at', 'timestamp with time zone', 'NO'],
    ['bess_dispatch_daily_state', 'updated_at', 'timestamp with time zone', 'NO'],
    ['bess_dispatch_pending_forms', 'form_message_id', 'text', 'NO'],
    ['bess_dispatch_pending_forms', 'request_id', 'text', 'NO'],
    ['bess_dispatch_pending_forms', 'original_message_id', 'text', 'NO'],
    ['bess_dispatch_pending_forms', 'chat_id', 'text', 'NO'],
    ['bess_dispatch_pending_forms', 'request_context', 'jsonb', 'NO'],
    ['bess_dispatch_pending_forms', 'expires_at', 'timestamp with time zone', 'NO'],
    ['bess_dispatch_pending_forms', 'completed_at', 'timestamp with time zone', 'YES'],
    ['bess_dispatch_pending_forms', 'created_at', 'timestamp with time zone', 'NO'],
    ['bess_dispatch_assignments', 'id', 'bigint', 'NO'],
    ['bess_dispatch_assignments', 'day_key', 'date', 'NO'],
    ['bess_dispatch_assignments', 'scope', 'text', 'NO'],
    ['bess_dispatch_assignments', 'request_id', 'text', 'NO'],
    ['bess_dispatch_assignments', 'assignee', 'text', 'NO'],
    ['bess_dispatch_assignments', 'direction', 'text', 'NO'],
    ['bess_dispatch_assignments', 'request_context', 'jsonb', 'NO'],
    ['bess_dispatch_assignments', 'created_at', 'timestamp with time zone', 'NO'],
    ['bess_dispatch_person_status', 'day_key', 'date', 'NO'],
    ['bess_dispatch_person_status', 'person_name', 'text', 'NO'],
    ['bess_dispatch_person_status', 'off_duty', 'boolean', 'NO'],
    ['bess_dispatch_person_status', 'updated_at', 'timestamp with time zone', 'NO']
  ];
begin
  foreach v_name in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = v_name) then
      v_errors := array_append(v_errors, format('缺少数据库角色 %I', v_name));
    end if;
  end loop;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role')
     and not has_schema_privilege('service_role', 'public', 'USAGE') then
    v_errors := array_append(v_errors, 'service_role 缺少 public schema USAGE');
  end if;

  -- 四张受保护表必须同时启用并强制 RLS。
  foreach v_name in array array[
    'bess_dispatch_daily_state', 'bess_dispatch_pending_forms',
    'bess_dispatch_assignments', 'bess_dispatch_person_status'
  ] loop
    v_table := to_regclass(format('public.%I', v_name));
    if v_table is null then
      v_errors := array_append(v_errors, format('缺少表 public.%I', v_name));
    elsif not exists (
      select 1 from pg_catalog.pg_class c
       where c.oid = v_table and c.relrowsecurity and c.relforcerowsecurity
    ) then
      v_errors := array_append(v_errors, format('表 public.%I 未同时 ENABLE/FORCE RLS', v_name));
    end if;
  end loop;

  foreach v_column slice 1 in array v_columns loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = v_column[1]
         and column_name = v_column[2] and data_type = v_column[3]
         and is_nullable = v_column[4]
    ) then
      v_errors := array_append(v_errors, format(
        '列不符合预期 public.%I.%I（类型=%s，可空=%s）',
        v_column[1], v_column[2], v_column[3], v_column[4]
      ));
    end if;
  end loop;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bess_dispatch_assignments'
       and column_name = 'id' and is_identity = 'YES' and identity_generation = 'ALWAYS'
  ) then
    v_errors := array_append(v_errors, 'assignments.id 不是 GENERATED ALWAYS identity');
  end if;

  -- 基础默认值也是迁移契约；避免结构存在但写入语义漂移。
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bess_dispatch_daily_state'
       and column_name = 'forward_cursor' and column_default = '0'
  ) then v_errors := array_append(v_errors, 'daily_state.forward_cursor 缺少默认值 0'); end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bess_dispatch_daily_state'
       and column_name = 'reverse_cursor' and column_default = '0'
  ) then v_errors := array_append(v_errors, 'daily_state.reverse_cursor 缺少默认值 0'); end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bess_dispatch_daily_state'
       and column_name = 'off_duty' and column_default = '''[]''::jsonb'
  ) then v_errors := array_append(v_errors, 'daily_state.off_duty 缺少默认值 []'); end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bess_dispatch_daily_state'
       and column_name = 'version' and column_default = '1'
  ) then v_errors := array_append(v_errors, 'daily_state.version 缺少默认值 1'); end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bess_dispatch_daily_state'
       and column_name = 'scope' and column_default = '''default''::text'
  ) then v_errors := array_append(v_errors, 'daily_state.scope 缺少默认值 default'); end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bess_dispatch_assignments'
       and column_name = 'scope' and column_default = '''default''::text'
  ) then v_errors := array_append(v_errors, 'assignments.scope 缺少默认值 default'); end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bess_dispatch_assignments'
       and column_name = 'request_context' and column_default = '''{}''::jsonb'
  ) then v_errors := array_append(v_errors, 'assignments.request_context 缺少默认值 {}'); end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bess_dispatch_person_status'
       and column_name = 'off_duty' and column_default = 'false'
  ) then v_errors := array_append(v_errors, 'person_status.off_duty 缺少默认值 false'); end if;

  -- 当前双 scope 键契约以及所有基础主键/唯一键。
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_pending_forms')
       and c.contype = 'p' and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (form_message_id)'
  ) then
    v_errors := array_append(v_errors, 'pending_forms 缺少 PRIMARY KEY (form_message_id)');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_pending_forms')
       and c.contype = 'u' and pg_get_constraintdef(c.oid) = 'UNIQUE (request_id)'
  ) then
    v_errors := array_append(v_errors, 'pending_forms 缺少 UNIQUE (request_id)');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_assignments')
       and c.contype = 'p' and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
  ) then
    v_errors := array_append(v_errors, 'assignments 缺少 PRIMARY KEY (id)');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_daily_state')
       and c.contype = 'p' and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (day_key, scope)'
  ) then
    v_errors := array_append(v_errors, 'daily_state 缺少 PRIMARY KEY (day_key, scope)');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_assignments')
       and c.contype = 'u'
       and pg_get_constraintdef(c.oid) = 'UNIQUE (day_key, scope, request_id)'
  ) then
    v_errors := array_append(v_errors, 'assignments 缺少 UNIQUE (day_key, scope, request_id)');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_assignments')
       and c.contype = 'f'
       and c.confrelid = to_regclass('public.bess_dispatch_daily_state')
       and pg_get_constraintdef(c.oid) =
         'FOREIGN KEY (day_key, scope) REFERENCES bess_dispatch_daily_state(day_key, scope) ON DELETE CASCADE'
  ) then
    v_errors := array_append(v_errors, 'assignments 缺少 scoped daily_state 外键或级联删除');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_person_status')
       and c.contype = 'p' and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (day_key, person_name)'
  ) then
    v_errors := array_append(v_errors, 'person_status 缺少 PRIMARY KEY (day_key, person_name)');
  end if;

  -- CHECK 域必须精确相等，不能只包含预期字面量后继续放行非法值。
  foreach v_name in array array['bess_dispatch_daily_state', 'bess_dispatch_assignments'] loop
    if not exists (
      select 1 from pg_catalog.pg_constraint c
       where c.conrelid = to_regclass(format('public.%I', v_name)) and c.contype = 'c'
         and pg_get_constraintdef(c.oid) =
           'CHECK ((scope = ANY (ARRAY[''default''::text, ''ad''::text, ''ad_review''::text, ''ad_game''::text])))'
    ) then
      v_errors := array_append(v_errors, format('%I 的 scope CHECK 不是精确四值域', v_name));
    end if;
  end loop;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_assignments') and c.contype = 'c'
       and pg_get_constraintdef(c.oid) =
         'CHECK ((direction = ANY (ARRAY[''forward''::text, ''reverse''::text, ''specified''::text])))'
  ) then
    v_errors := array_append(v_errors, 'assignments.direction CHECK 不是精确三值域');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_daily_state') and c.contype = 'c'
       and pg_get_constraintdef(c.oid) =
         'CHECK (((jsonb_typeof(roster) = ''array''::text) AND (jsonb_array_length(roster) > 0)))'
  ) then
    v_errors := array_append(v_errors, 'daily_state 缺少非空 JSON 数组 roster CHECK');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_daily_state') and c.contype = 'c'
       and pg_get_constraintdef(c.oid) = 'CHECK ((jsonb_typeof(off_duty) = ''array''::text))'
  ) then
    v_errors := array_append(v_errors, 'daily_state 缺少 off_duty JSON 数组 CHECK');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_daily_state') and c.contype = 'c'
       and pg_get_constraintdef(c.oid) = 'CHECK ((forward_cursor >= 0))'
  ) then
    v_errors := array_append(v_errors, 'daily_state 缺少 forward_cursor 非负 CHECK');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_daily_state') and c.contype = 'c'
       and pg_get_constraintdef(c.oid) = 'CHECK ((reverse_cursor >= 0))'
  ) then
    v_errors := array_append(v_errors, 'daily_state 缺少 reverse_cursor 非负 CHECK');
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = to_regclass('public.bess_dispatch_person_status') and c.contype = 'c'
       and pg_get_constraintdef(c.oid) = 'CHECK ((btrim(person_name) <> ''''::text))'
  ) then
    v_errors := array_append(v_errors, 'person_status 缺少非空 person_name CHECK');
  end if;

  foreach v_name in array array['bess_dispatch_state_expiry_idx', 'bess_dispatch_pending_expiry_idx'] loop
    if to_regclass(format('public.%I', v_name)) is null then
      v_errors := array_append(v_errors, format('缺少索引 public.%I', v_name));
    else
      select pg_get_indexdef(to_regclass(format('public.%I', v_name))) into v_definition;
      if v_definition not like '% USING btree (expires_at)' then
        v_errors := array_append(v_errors, format('索引 public.%I 未按 expires_at 建立 btree', v_name));
      end if;
    end if;
  end loop;

  -- 每张表仅允许 service_role 的严格 ALL policy。
  select oid into v_role from pg_catalog.pg_roles where rolname = 'service_role';
  if v_role is not null then
    foreach v_name in array array[
      'bess_dispatch_daily_state', 'bess_dispatch_pending_forms',
      'bess_dispatch_assignments', 'bess_dispatch_person_status'
    ] loop
      select count(*) into v_count from pg_catalog.pg_policy p
       where p.polrelid = to_regclass(format('public.%I', v_name))
         and p.polname = 'bess_dispatch_service_role_only'
         and p.polcmd = '*' and p.polpermissive and p.polroles = array[v_role]
         and pg_get_expr(p.polqual, p.polrelid) = 'true'
         and pg_get_expr(p.polwithcheck, p.polrelid) = 'true';
      if v_count <> 1 or (
        select count(*) from pg_catalog.pg_policy p
         where p.polrelid = to_regclass(format('public.%I', v_name))
      ) <> 1 then
        v_errors := array_append(v_errors, format('表 public.%I 的 RLS policy 不是唯一 service_role-only ALL', v_name));
      end if;
    end loop;
  end if;

  -- anon/authenticated 对所有表（含新 scope/person status）零权限；service_role 仅 CRUD。
  foreach v_name in array array[
    'bess_dispatch_daily_state', 'bess_dispatch_pending_forms',
    'bess_dispatch_assignments', 'bess_dispatch_person_status'
  ] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
       and has_table_privilege('anon', format('public.%I', v_name),
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      v_errors := array_append(v_errors, format('anon 仍可访问 public.%I', v_name));
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
       and has_table_privilege('authenticated', format('public.%I', v_name),
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      v_errors := array_append(v_errors, format('authenticated 仍可访问 public.%I', v_name));
    end if;
    if v_role is not null and not (
      has_table_privilege('service_role', format('public.%I', v_name), 'SELECT')
      and has_table_privilege('service_role', format('public.%I', v_name), 'INSERT')
      and has_table_privilege('service_role', format('public.%I', v_name), 'UPDATE')
      and has_table_privilege('service_role', format('public.%I', v_name), 'DELETE')
    ) then
      v_errors := array_append(v_errors, format('service_role 缺少 public.%I CRUD', v_name));
    end if;
    if v_role is not null and has_table_privilege('service_role', format('public.%I', v_name),
      'TRUNCATE,REFERENCES,TRIGGER') then
      v_errors := array_append(v_errors, format('service_role 对 public.%I 拥有超出 CRUD 的权限', v_name));
    end if;
  end loop;

  -- identity 序列仅允许 service_role USAGE；PUBLIC/客户端角色零权限。
  if to_regclass('public.bess_dispatch_assignments_id_seq') is null then
    v_errors := array_append(v_errors, '缺少 identity 序列 bess_dispatch_assignments_id_seq');
  else
    if exists (
      select 1 from pg_catalog.pg_class c,
        lateral aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) acl
       where c.oid = to_regclass('public.bess_dispatch_assignments_id_seq')
         and acl.grantee = 0
         and acl.privilege_type in ('USAGE', 'SELECT', 'UPDATE')
    ) then
      v_errors := array_append(v_errors, 'PUBLIC 仍有 assignments identity 序列权限');
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
       and has_sequence_privilege('anon', 'public.bess_dispatch_assignments_id_seq', 'USAGE,SELECT,UPDATE') then
      v_errors := array_append(v_errors, 'anon 仍有 assignments identity 序列权限');
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
       and has_sequence_privilege('authenticated', 'public.bess_dispatch_assignments_id_seq', 'USAGE,SELECT,UPDATE') then
      v_errors := array_append(v_errors, 'authenticated 仍有 assignments identity 序列权限');
    end if;
    if v_role is not null then
      if not has_sequence_privilege('service_role', 'public.bess_dispatch_assignments_id_seq', 'USAGE') then
        v_errors := array_append(v_errors, 'service_role 缺少 assignments identity 序列 USAGE');
      end if;
      if has_sequence_privilege('service_role', 'public.bess_dispatch_assignments_id_seq', 'SELECT,UPDATE') then
        v_errors := array_append(v_errors, 'service_role 拥有不必要的 assignments identity 序列 SELECT/UPDATE');
      end if;
    end if;
  end if;

  -- 当前全部写 RPC：固定 search_path、SECURITY DEFINER，且仅 service_role 可执行。
  foreach v_signature in array array[
    'public.bess_assign_next(date,text,text,text,jsonb,timestamp with time zone,jsonb)',
    'public.bess_assign_specific(date,text,text,text,jsonb)',
    'public.bess_calibrate_cursor(date,text,text,text,jsonb)',
    'public.bess_update_roster_status(date,text,jsonb,bigint)',
    'public.bess_initialize_ad_rosters(date,jsonb,timestamp with time zone)',
    'public.bess_replace_ad_rosters(date,jsonb,bigint,bigint)'
  ] loop
    v_function := to_regprocedure(v_signature);
    if v_function is null then
      v_errors := array_append(v_errors, format('缺少 RPC %s', v_signature));
    else
      if not exists (
        select 1 from pg_catalog.pg_proc p
         where p.oid = v_function and p.prosecdef
           and exists (
             select 1 from unnest(p.proconfig) config(value)
              where split_part(config.value, '=', 1) = 'search_path'
                and btrim(translate(split_part(config.value, '=', 2), chr(34), '')) = ''
           )
      ) then
        v_errors := array_append(v_errors, format('RPC %s 不是 SECURITY DEFINER + 空 search_path', v_signature));
      end if;
      if exists (
        select 1 from pg_catalog.pg_proc p,
          lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
         where p.oid = v_function and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      )
         or (exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
             and has_function_privilege('anon', v_function, 'EXECUTE'))
         or (exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
             and has_function_privilege('authenticated', v_function, 'EXECUTE')) then
        v_errors := array_append(v_errors, format('未授权角色仍可执行 RPC %s', v_signature));
      end if;
      if v_role is not null and not has_function_privilege('service_role', v_function, 'EXECUTE') then
        v_errors := array_append(v_errors, format('service_role 缺少 RPC %s EXECUTE', v_signature));
      end if;
    end if;
  end loop;

  -- scope-aware 签名、返回契约与双名单/rollback 语义。
  v_function := to_regprocedure(
    'public.bess_assign_next(date,text,text,text,jsonb,timestamp with time zone,jsonb)'
  );
  if v_function is not null then
    if not exists (
      select 1 from pg_catalog.pg_proc p where p.oid = v_function
       and p.proretset and p.prorettype = 'record'::regtype and p.pronargdefaults = 3
       and regexp_replace(
         pg_get_expr(p.proargdefaults, 0),
         '[[:space:]]+',
         ' ',
         'g'
       ) = 'NULL::jsonb, NULL::timestamp with time zone, ''{}''::jsonb'
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
      v_errors := array_append(v_errors, 'scope-aware bess_assign_next 输入/默认值/五列返回契约不符');
    end if;
    v_definition := lower(pg_get_functiondef(v_function));
    if v_definition not like '%p_scope = ''ad''%legacy_ad_cursor_unrepresentable%'
       or v_definition not like '%p_scope not in (''default'', ''ad'', ''ad_review'', ''ad_game'')%'
       or v_definition not like '%bess_sync_legacy_ad_shadow(p_day_key)%'
       or v_definition not like '%on conflict (day_key, scope, request_id)%' then
      v_errors := array_append(v_errors, 'bess_assign_next 缺少四 scope、legacy fail-closed 或 rollback assignment shadow');
    end if;
  end if;

  v_function := to_regprocedure('public.bess_calibrate_cursor(date,text,text,text,jsonb)');
  if v_function is not null then
    v_definition := lower(pg_get_functiondef(v_function));
    if v_definition not like '%p_scope = ''ad''%legacy_ad_cursor_unrepresentable%'
       or v_definition not like '%p_direction = ''forward''%forward_cursor%'
       or v_definition not like '%reverse_cursor%' then
      v_errors := array_append(v_errors, 'bess_calibrate_cursor 缺少 legacy fail-closed 或方向隔离');
    end if;
  end if;

  v_function := to_regprocedure('public.bess_assign_specific(date,text,text,text,jsonb)');
  if v_function is not null then
    v_definition := lower(pg_get_functiondef(v_function));
    if v_definition not like '%''ad_review''%''ad_game''%'
       or v_definition not like '%bess_dispatch_person_status%'
       or v_definition not like '%on conflict (day_key, scope, request_id)%' then
      v_errors := array_append(v_errors, 'bess_assign_specific 缺少双 scope 人员状态或 rollback assignment shadow');
    end if;
  end if;

  v_function := to_regprocedure('public.bess_update_roster_status(date,text,jsonb,bigint)');
  if v_function is not null then
    v_definition := lower(pg_get_functiondef(v_function));
    if v_definition not like '%bess_dispatch_person_status%'
       or v_definition not like '%scope in (''ad_review'', ''ad_game'')%'
       or v_definition not like '%bess_sync_legacy_ad_shadow(p_day_key)%' then
      v_errors := array_append(v_errors, 'bess_update_roster_status 缺少跨双 scope 人员状态同步');
    end if;
  end if;

  foreach v_signature in array array[
    'public.bess_initialize_ad_rosters(date,jsonb,timestamp with time zone)',
    'public.bess_replace_ad_rosters(date,jsonb,bigint,bigint)'
  ] loop
    v_function := to_regprocedure(v_signature);
    if v_function is not null then
      v_definition := lower(pg_get_functiondef(v_function));
      if v_definition not like '%''ad_review''%''ad_game''%'
         or v_definition not like '%bess_sync_legacy_ad_shadow(p_day_key)%' then
        v_errors := array_append(v_errors, format('双名单 RPC %s 未原子维护两 scope 或 rollback shadow', v_signature));
      end if;
    end if;
  end loop;

  v_function := to_regprocedure('public.bess_sync_legacy_ad_shadow(date)');
  if v_function is null then
    v_errors := array_append(v_errors, '缺少 rollback shadow RPC bess_sync_legacy_ad_shadow(date)');
  else
    v_definition := lower(pg_get_functiondef(v_function));
    if v_definition not like '%''ad_review''%' or v_definition not like '%''ad_game''%'
       or v_definition not like '%p_day_key, ''ad''%0, 0%'
       or exists (
        select 1 from pg_catalog.pg_proc p,
          lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
         where p.oid = v_function and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      )
       or (v_role is not null and has_function_privilege('service_role', v_function, 'EXECUTE')) then
      v_errors := array_append(v_errors, 'rollback shadow RPC 结构或不可直接调用权限不符');
    end if;
  end if;

  -- 旧入口可以保留供回滚，但所有应用角色必须已撤权。
  foreach v_signature in array array[
    'public.bess_assign_next(date,text,text,jsonb,timestamp with time zone,jsonb)',
    'public.bess_update_roster_status(date,jsonb,bigint)'
  ] loop
    v_function := to_regprocedure(v_signature);
    if v_function is not null and (
      exists (
        select 1 from pg_catalog.pg_proc p,
          lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
         where p.oid = v_function and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      )
      or (exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
          and has_function_privilege('anon', v_function, 'EXECUTE'))
      or (exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
          and has_function_privilege('authenticated', v_function, 'EXECUTE'))
      or (v_role is not null and has_function_privilege('service_role', v_function, 'EXECUTE'))
    ) then
      v_errors := array_append(v_errors, format('旧 RPC %s 仍可被应用角色执行', v_signature));
    end if;
  end loop;

  -- 基线接单 RPC 仍须存在并保持最小权限。
  v_function := to_regprocedure(
    'public.bess_claim_ingest(text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone)'
  );
  if v_function is null then
    v_errors := array_append(v_errors, '缺少原子接单 RPC bess_claim_ingest');
  elsif exists (
        select 1 from pg_catalog.pg_proc p,
          lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
         where p.oid = v_function and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      )
     or (exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
         and has_function_privilege('anon', v_function, 'EXECUTE'))
     or (exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
         and has_function_privilege('authenticated', v_function, 'EXECUTE'))
     or (v_role is not null and not has_function_privilege('service_role', v_function, 'EXECUTE')) then
    v_errors := array_append(v_errors, 'bess_claim_ingest 执行权限不符合最小权限');
  end if;

  if cardinality(v_errors) > 0 then
    raise exception using errcode = 'P0001',
      message = 'BESS dispatch 验证失败：' || array_to_string(v_errors, E'\n - ', E'\n - ');
  end if;
  raise notice 'BESS dispatch 双 scope 验证通过：结构、RLS、权限、RPC 与 rollback shadow 均符合预期。';
end
$verify$;

select 'PASS' as status,
       'BESS dispatch dual-scope schema and security verification passed' as detail;
rollback;
