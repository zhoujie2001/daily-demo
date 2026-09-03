-- BESS P1 自动派单：只读迁移验收脚本（Supabase/PostgreSQL）。
--
-- 执行顺序：先执行 db/bess-dispatch.sql，再单独执行本文件。
-- 只读边界：事务显式设为 READ ONLY；仅查询系统目录/权限并以 RAISE EXCEPTION
-- 报告不符合项，不创建、修改或删除任何对象/业务数据。
-- 幂等边界：可重复执行；成功仅输出一行验证结果，失败会一次性列出全部已发现问题。
-- 安全边界：脚本不读取业务行内容，也不包含密码、Token、Service Role Key 或敏感值。

begin transaction read only;

do $verify$
declare
  v_errors text[] := array[]::text[];
  v_table regclass;
  v_function regprocedure;
  v_role oid;
  v_count integer;
  v_rls_enabled boolean;
  v_rls_forced boolean;
  v_definition text;
  v_columns text[][] := array[
    ['bess_dispatch_daily_state', 'day_key', 'date', 'NO'],
    ['bess_dispatch_daily_state', 'roster', 'jsonb', 'NO'],
    ['bess_dispatch_daily_state', 'forward_cursor', 'bigint', 'NO'],
    ['bess_dispatch_daily_state', 'reverse_cursor', 'bigint', 'NO'],
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
    ['bess_dispatch_assignments', 'request_id', 'text', 'NO'],
    ['bess_dispatch_assignments', 'assignee', 'text', 'NO'],
    ['bess_dispatch_assignments', 'direction', 'text', 'NO'],
    ['bess_dispatch_assignments', 'request_context', 'jsonb', 'NO'],
    ['bess_dispatch_assignments', 'created_at', 'timestamp with time zone', 'NO']
  ];
  v_column text[];
  v_name text;
begin
  -- 角色是后续权限检查的前置条件。
  foreach v_name in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = v_name) then
      v_errors := array_append(v_errors, format('缺少数据库角色 %I', v_name));
    end if;
  end loop;

  -- 不改变 public schema 的全局授权模型，只确认服务端角色能够解析对象。
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role')
     and not has_schema_privilege('service_role', 'public', 'USAGE')
  then
    v_errors := array_append(v_errors, 'service_role 缺少 public schema USAGE');
  end if;

  -- 表、RLS enabled/forced。
  foreach v_name in array array[
    'bess_dispatch_daily_state',
    'bess_dispatch_pending_forms',
    'bess_dispatch_assignments'
  ] loop
    v_table := to_regclass(format('public.%I', v_name));
    if v_table is null then
      v_errors := array_append(v_errors, format('缺少表 public.%I', v_name));
    else
      select c.relrowsecurity, c.relforcerowsecurity
        into strict v_rls_enabled, v_rls_forced
        from pg_catalog.pg_class as c
        where c.oid = v_table;
      if not v_rls_enabled then
        v_errors := array_append(v_errors, format('表 public.%I 未 ENABLE ROW LEVEL SECURITY', v_name));
      end if;
      if not v_rls_forced then
        v_errors := array_append(v_errors, format('表 public.%I 未 FORCE ROW LEVEL SECURITY', v_name));
      end if;
    end if;
  end loop;

  -- 必需列的数据类型与可空性；额外列不影响兼容性。
  foreach v_column slice 1 in array v_columns loop
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = v_column[1]
        and column_name = v_column[2]
        and data_type = v_column[3]
        and is_nullable = v_column[4]
    ) then
      v_errors := array_append(
        v_errors,
        format('列不符合预期 public.%I.%I（类型=%s，可空=%s）',
          v_column[1], v_column[2], v_column[3], v_column[4])
      );
    end if;
  end loop;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bess_dispatch_assignments'
      and column_name = 'id' and is_identity = 'YES'
      and identity_generation = 'ALWAYS'
  ) then
    v_errors := array_append(v_errors, 'public.bess_dispatch_assignments.id 不是 GENERATED ALWAYS identity');
  end if;

  -- 默认值。
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bess_dispatch_daily_state'
      and column_name = 'forward_cursor' and column_default = '0'
  ) then v_errors := array_append(v_errors, 'forward_cursor 缺少默认值 0'); end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bess_dispatch_daily_state'
      and column_name = 'reverse_cursor' and column_default = '0'
  ) then v_errors := array_append(v_errors, 'reverse_cursor 缺少默认值 0'); end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bess_dispatch_assignments'
      and column_name = 'request_context' and column_default = '''{}''::jsonb'
  ) then v_errors := array_append(v_errors, 'assignments.request_context 缺少默认值空 JSON 对象'); end if;

  -- PK / UK / FK / CHECK 约束按约束语义检查，不依赖自动生成的约束名。
  if not exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = to_regclass('public.bess_dispatch_daily_state')
      and c.contype = 'p' and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (day_key)'
  ) then v_errors := array_append(v_errors, 'daily_state 缺少 day_key 主键'); end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = to_regclass('public.bess_dispatch_pending_forms')
      and c.contype = 'p' and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (form_message_id)'
  ) then v_errors := array_append(v_errors, 'pending_forms 缺少 form_message_id 主键'); end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = to_regclass('public.bess_dispatch_pending_forms')
      and c.contype = 'u' and pg_get_constraintdef(c.oid) = 'UNIQUE (request_id)'
  ) then v_errors := array_append(v_errors, 'pending_forms 缺少 request_id 唯一约束'); end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = to_regclass('public.bess_dispatch_assignments')
      and c.contype = 'p' and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (id)'
  ) then v_errors := array_append(v_errors, 'assignments 缺少 id 主键'); end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = to_regclass('public.bess_dispatch_assignments')
      and c.contype = 'u' and pg_get_constraintdef(c.oid) = 'UNIQUE (day_key, request_id)'
  ) then v_errors := array_append(v_errors, 'assignments 缺少 (day_key, request_id) 唯一约束'); end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = to_regclass('public.bess_dispatch_assignments')
      and c.contype = 'f'
      and c.confrelid = to_regclass('public.bess_dispatch_daily_state')
      and pg_get_constraintdef(c.oid) = 'FOREIGN KEY (day_key) REFERENCES bess_dispatch_daily_state(day_key) ON DELETE CASCADE'
  ) then v_errors := array_append(v_errors, 'assignments 缺少 day_key 外键或 ON DELETE CASCADE'); end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = to_regclass('public.bess_dispatch_daily_state') and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like 'CHECK (((jsonb_typeof(roster) = ''array''::text) AND (jsonb_array_length(roster) > 0)))%'
  ) then v_errors := array_append(v_errors, 'daily_state 缺少非空 JSON 数组 roster CHECK'); end if;

  if (select count(*) from pg_catalog.pg_constraint c
      where c.conrelid = to_regclass('public.bess_dispatch_daily_state') and c.contype = 'c'
        and pg_get_constraintdef(c.oid) like 'CHECK ((%cursor >= 0))') < 2
  then v_errors := array_append(v_errors, 'daily_state 缺少两个 cursor 非负 CHECK'); end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = to_regclass('public.bess_dispatch_assignments') and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like 'CHECK ((direction = ANY (ARRAY[%''forward''%''reverse''%])))'
  ) then v_errors := array_append(v_errors, 'assignments 缺少 direction 枚举 CHECK'); end if;

  -- 非唯一业务索引及其列顺序。
  foreach v_name in array array[
    'bess_dispatch_state_expiry_idx',
    'bess_dispatch_pending_expiry_idx'
  ] loop
    if to_regclass(format('public.%I', v_name)) is null then
      v_errors := array_append(v_errors, format('缺少索引 public.%I', v_name));
    else
      select pg_get_indexdef(to_regclass(format('public.%I', v_name))) into v_definition;
      if v_definition not like '% USING btree (expires_at)' then
        v_errors := array_append(v_errors, format('索引 public.%I 未按 expires_at 建立 btree', v_name));
      end if;
    end if;
  end loop;

  -- 每张表只能存在预期的 service_role 全操作策略；anon/authenticated 无策略入口。
  select oid into v_role from pg_catalog.pg_roles where rolname = 'service_role';
  if v_role is not null then
    foreach v_name in array array[
      'bess_dispatch_daily_state',
      'bess_dispatch_pending_forms',
      'bess_dispatch_assignments'
    ] loop
      select count(*) into v_count
      from pg_catalog.pg_policy p
      where p.polrelid = to_regclass(format('public.%I', v_name))
        and p.polname = 'bess_dispatch_service_role_only'
        and p.polcmd = '*'
        and p.polpermissive
        and p.polroles = array[v_role]
        and pg_get_expr(p.polqual, p.polrelid) = 'true'
        and pg_get_expr(p.polwithcheck, p.polrelid) = 'true';
      if v_count <> 1 then
        v_errors := array_append(v_errors, format('表 public.%I 缺少严格的 service_role-only ALL policy', v_name));
      end if;
      if (select count(*) from pg_catalog.pg_policy p
          where p.polrelid = to_regclass(format('public.%I', v_name))) <> 1 then
        v_errors := array_append(v_errors, format('表 public.%I 存在额外或缺失 policy', v_name));
      end if;
    end loop;
  end if;

  -- 表权限：anon/authenticated 无任何权限；service_role 只有 CRUD。
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and has_table_privilege('anon', 'public.bess_dispatch_daily_state', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  then v_errors := array_append(v_errors, 'anon 仍可访问 daily_state'); end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and has_table_privilege('anon', 'public.bess_dispatch_pending_forms', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  then v_errors := array_append(v_errors, 'anon 仍可访问 pending_forms'); end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and has_table_privilege('anon', 'public.bess_dispatch_assignments', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  then v_errors := array_append(v_errors, 'anon 仍可访问 assignments'); end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
     and has_table_privilege('authenticated', 'public.bess_dispatch_daily_state', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  then v_errors := array_append(v_errors, 'authenticated 仍可访问 daily_state'); end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
     and has_table_privilege('authenticated', 'public.bess_dispatch_pending_forms', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  then v_errors := array_append(v_errors, 'authenticated 仍可访问 pending_forms'); end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
     and has_table_privilege('authenticated', 'public.bess_dispatch_assignments', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  then v_errors := array_append(v_errors, 'authenticated 仍可访问 assignments'); end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    foreach v_name in array array[
      'bess_dispatch_daily_state',
      'bess_dispatch_pending_forms',
      'bess_dispatch_assignments'
    ] loop
      if not (
        has_table_privilege('service_role', format('public.%I', v_name), 'SELECT')
        and has_table_privilege('service_role', format('public.%I', v_name), 'INSERT')
        and has_table_privilege('service_role', format('public.%I', v_name), 'UPDATE')
        and has_table_privilege('service_role', format('public.%I', v_name), 'DELETE')
      ) then
        v_errors := array_append(v_errors, format('service_role 缺少 public.%I 的 CRUD 权限', v_name));
      end if;
      if has_table_privilege('service_role', format('public.%I', v_name), 'TRUNCATE,REFERENCES,TRIGGER') then
        v_errors := array_append(v_errors, format('service_role 对 public.%I 拥有不必要的高权限', v_name));
      end if;
    end loop;
  end if;

  -- identity 序列权限。
  if to_regclass('public.bess_dispatch_assignments_id_seq') is null then
    v_errors := array_append(v_errors, '缺少 identity 序列 bess_dispatch_assignments_id_seq');
  else
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
       and has_sequence_privilege('anon', 'public.bess_dispatch_assignments_id_seq', 'USAGE,SELECT,UPDATE')
    then v_errors := array_append(v_errors, 'anon 仍有 assignments identity 序列权限'); end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
       and has_sequence_privilege('authenticated', 'public.bess_dispatch_assignments_id_seq', 'USAGE,SELECT,UPDATE')
    then v_errors := array_append(v_errors, 'authenticated 仍有 assignments identity 序列权限'); end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
      if not has_sequence_privilege('service_role', 'public.bess_dispatch_assignments_id_seq', 'USAGE') then
        v_errors := array_append(v_errors, 'service_role 缺少 assignments identity 序列 USAGE');
      end if;
      if has_sequence_privilege('service_role', 'public.bess_dispatch_assignments_id_seq', 'SELECT,UPDATE') then
        v_errors := array_append(v_errors, 'service_role 拥有不必要的 assignments identity 序列 SELECT/UPDATE');
      end if;
    end if;
  end if;

  -- RPC 签名、返回结构、SECURITY DEFINER、固定 search_path 及执行权限。
  v_function := to_regprocedure(
    'public.bess_assign_next(date,text,text,jsonb,timestamp with time zone,jsonb)'
  );
  if v_function is null then
    v_errors := array_append(v_errors, '缺少兼容 RPC bess_assign_next(date,text,text,jsonb,timestamptz,jsonb)');
  else
    if not exists (
      select 1 from pg_catalog.pg_proc p
      where p.oid = v_function
        and p.prosecdef
        and p.provolatile = 'v'
        and p.proretset
        and p.prorettype = 'record'::regtype
        and p.pronargdefaults = 3
        and regexp_replace(
          pg_get_expr(p.proargdefaults, 0),
          '[[:space:]]+',
          ' ',
          'g'
        ) = 'NULL::jsonb, NULL::timestamp with time zone, ''{}''::jsonb'
        and exists (
          select 1
          from unnest(p.proconfig) as config(value)
          where split_part(config.value, '=', 1) = 'search_path'
            and btrim(translate(split_part(config.value, '=', 2), chr(34), '')) = ''
        )
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
      v_errors := array_append(v_errors, 'RPC 属性、默认参数或五列返回结构不符合预期');
    end if;

    if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
       and has_function_privilege('anon', v_function, 'EXECUTE')
    then v_errors := array_append(v_errors, 'anon 仍可执行 bess_assign_next'); end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
       and has_function_privilege('authenticated', v_function, 'EXECUTE')
    then v_errors := array_append(v_errors, 'authenticated 仍可执行 bess_assign_next'); end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role')
       and not has_function_privilege('service_role', v_function, 'EXECUTE')
    then v_errors := array_append(v_errors, 'service_role 缺少 bess_assign_next EXECUTE'); end if;

    v_definition := pg_get_functiondef(v_function);
    if v_definition not like '%p_context ->> ''anchor_assignee''%'
       or v_definition not like '%v_anchor_index + 1%'
       or v_definition not like '%v_anchor_index - 1 + v_count%'
    then
      v_errors := array_append(v_errors, 'RPC 缺少人工表格锚点的正序/倒序轮转逻辑');
    end if;
  end if;

  -- 人员状态写 RPC 必须保持 SECURITY DEFINER + 空 search_path，且 EXECUTE 仅授予 service_role。
  v_function := to_regprocedure(
    'public.bess_update_roster_status(date,jsonb,bigint)'
  );
  if v_function is null then
    v_errors := array_append(v_errors, '缺少 RPC bess_update_roster_status(date,jsonb,bigint)');
  else
    if not exists (
      select 1
      from pg_catalog.pg_proc p
      where p.oid = v_function
        and p.prosecdef
        and exists (
          select 1
          from unnest(p.proconfig) as config(value)
          where split_part(config.value, '=', 1) = 'search_path'
            and btrim(translate(split_part(config.value, '=', 2), chr(34), '')) = ''
        )
    ) then
      v_errors := array_append(
        v_errors,
        'bess_update_roster_status 必须为 SECURITY DEFINER 且 search_path 为空'
      );
    end if;

    if exists (
      select 1
      from pg_catalog.pg_proc p,
           lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where p.oid = v_function
        and acl.grantee = 0
        and acl.privilege_type = 'EXECUTE'
    ) then
      v_errors := array_append(v_errors, 'PUBLIC 仍可执行 bess_update_roster_status');
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
       and has_function_privilege('anon', v_function, 'EXECUTE')
    then v_errors := array_append(v_errors, 'anon 仍可执行 bess_update_roster_status'); end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
       and has_function_privilege('authenticated', v_function, 'EXECUTE')
    then v_errors := array_append(v_errors, 'authenticated 仍可执行 bess_update_roster_status'); end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role')
       and not has_function_privilege('service_role', v_function, 'EXECUTE')
    then v_errors := array_append(v_errors, 'service_role 缺少 bess_update_roster_status EXECUTE'); end if;
  end if;

  if cardinality(v_errors) > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'BESS dispatch 验证失败：' || array_to_string(v_errors, E'\n - ', E'\n - ');
  end if;

  raise notice 'BESS dispatch 验证通过：表/列/索引/约束/RLS/policy/权限/RPC 均符合预期。';
end
$verify$;

select 'PASS' as status,
       'BESS dispatch schema and security verification passed' as detail;

rollback;
