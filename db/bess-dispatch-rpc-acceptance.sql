-- 可在已完成全部迁移的真实 PostgreSQL/Supabase 数据库直接执行。
-- 成功时无错误；任一写 RPC overload、参数数、权限或 search_path 漂移即失败。
begin transaction read only;

do $rpc_acceptance$
declare
  v_name text;
  v_args integer;
  v_oid oid;
begin
  for v_name, v_args in
    select * from (values
      ('bess_assign_next'::text, 9),
      ('bess_calibrate_cursor'::text, 7),
      ('bess_update_roster_status'::text, 4)
    ) expected(name, args)
  loop
    if (select count(*) from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = v_name) <> 1 then
      raise exception '% must have exactly one signature', v_name;
    end if;
    select p.oid into v_oid from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_name;
    if (select p.pronargs from pg_catalog.pg_proc p where p.oid = v_oid) <> v_args then
      raise exception '% must have % input arguments', v_name, v_args;
    end if;
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_oid and p.prosecdef
      and exists (select 1 from unnest(p.proconfig) c(value)
        where split_part(c.value, '=', 1) = 'search_path'
          and btrim(translate(split_part(c.value, '=', 2), chr(34), '')) = '')) then
      raise exception '% must be SECURITY DEFINER with empty search_path', v_name;
    end if;
    if exists (select 1 from pg_catalog.pg_proc p,
        lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       where p.oid = v_oid and acl.grantee = 0 and acl.privilege_type = 'EXECUTE')
       or (exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
           and has_function_privilege('anon', v_oid, 'EXECUTE'))
       or (exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
           and has_function_privilege('authenticated', v_oid, 'EXECUTE'))
       or not (exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role')
           and has_function_privilege('service_role', v_oid, 'EXECUTE')) then
      raise exception '% execute privileges are not service_role-only', v_name;
    end if;
  end loop;
end;
$rpc_acceptance$;

rollback;
