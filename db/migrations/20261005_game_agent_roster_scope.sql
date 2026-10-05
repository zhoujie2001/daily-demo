-- Give game mismatch dispatch its own daily roster/cursors while preserving
-- the existing default and AD scopes.
begin;

alter table public.bess_dispatch_daily_state
  drop constraint if exists bess_dispatch_daily_state_scope_check;
alter table public.bess_dispatch_daily_state
  add constraint bess_dispatch_daily_state_scope_check
  check (scope in ('default', 'ad', 'game_agent'));

alter table public.bess_dispatch_assignments
  drop constraint if exists bess_dispatch_assignments_scope_check;
alter table public.bess_dispatch_assignments
  add constraint bess_dispatch_assignments_scope_check
  check (scope in ('default', 'ad', 'game_agent'));

-- Preserve the latest deployed RPC bodies and only widen their scope guards.
-- This avoids replacing later cursor-calibration fixes with older definitions.
do $widen_game_agent_scope$
declare
  fn record;
  original_definition text;
  patched_definition text;
  patched_count integer := 0;
begin
  for fn in
    select p.oid, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('bess_assign_next', 'bess_assign_specific', 'bess_calibrate_cursor')
  loop
    original_definition := pg_get_functiondef(fn.oid);
    patched_definition := replace(
      original_definition,
      'p_scope not in (''default'', ''ad'')',
      'p_scope not in (''default'', ''ad'', ''game_agent'')'
    );
    if patched_definition <> original_definition then
      execute patched_definition;
      patched_count := patched_count + 1;
    end if;
  end loop;

  if patched_count < 3 then
    raise exception 'expected to patch 3 scoped dispatch RPCs, patched %', patched_count;
  end if;
end
$widen_game_agent_scope$;

commit;
