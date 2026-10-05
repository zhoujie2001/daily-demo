-- Compose main's game-agent roster isolation with the newer AD directional
-- scopes. New and restored game_agent callbacks resolve to ad_game, while AD
-- review remains in ad_review; do not reintroduce the superseded game_agent
-- database scope after the directional-scope migration has run.
begin;

alter table public.bess_dispatch_daily_state
  drop constraint if exists bess_dispatch_daily_state_scope_check;
alter table public.bess_dispatch_daily_state
  add constraint bess_dispatch_daily_state_scope_check
  check (scope in ('default', 'ad', 'ad_review', 'ad_game'));

alter table public.bess_dispatch_assignments
  drop constraint if exists bess_dispatch_assignments_scope_check;
alter table public.bess_dispatch_assignments
  add constraint bess_dispatch_assignments_scope_check
  check (scope in ('default', 'ad', 'ad_review', 'ad_game'));

-- Preserve the latest deployed RPC bodies and only widen old two/three-scope
-- guards. If the AD directional-scope migration already installed the current
-- four-scope RPCs, no replacement is necessary.
do $widen_game_agent_scope$
declare
  fn record;
  original_definition text;
  patched_definition text;
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
      'p_scope not in (''default'', ''ad'', ''game_agent'')',
      'p_scope not in (''default'', ''ad'', ''ad_review'', ''ad_game'')'
    );
    patched_definition := replace(
      patched_definition,
      'p_scope not in (''default'', ''ad'')',
      'p_scope not in (''default'', ''ad'', ''ad_review'', ''ad_game'')'
    );
    if patched_definition <> original_definition then
      execute patched_definition;
    end if;
  end loop;
end
$widen_game_agent_scope$;

commit;
