-- Add an isolated non-AD dispatch lane for the dedicated test chat.
-- Apply before deploying application code. Existing rows and the default/AD lanes are untouched.
begin;

alter table public.bess_dispatch_daily_state
  drop constraint if exists bess_dispatch_daily_state_scope_check;
alter table public.bess_dispatch_daily_state
  add constraint bess_dispatch_daily_state_scope_check
  check (scope in ('default', 'test_default', 'ad', 'ad_review', 'ad_game'));

alter table public.bess_dispatch_assignments
  drop constraint if exists bess_dispatch_assignments_scope_check;
alter table public.bess_dispatch_assignments
  add constraint bess_dispatch_assignments_scope_check
  check (scope in ('default', 'test_default', 'ad', 'ad_review', 'ad_game'));

-- Keep the latest deployed RPC bodies (including concurrency/idempotency fixes)
-- and widen only their exact scope allowlist. AD-only person_status behavior is
-- deliberately unchanged: test_default uses its own daily_state.off_duty JSON,
-- so it cannot read or mutate the shared AD person_status projection.
do $migration$
declare
  v_oid oid;
  v_signature text;
  v_definition text;
  v_old constant text := '''default'', ''ad'', ''ad_review'', ''ad_game''';
  v_new constant text := '''default'', ''test_default'', ''ad'', ''ad_review'', ''ad_game''';
begin
  foreach v_signature in array array[
    'public.bess_assign_next(date,text,text,text,jsonb,timestamp with time zone,jsonb,bigint,bigint)',
    'public.bess_assign_specific(date,text,text,text,jsonb)',
    'public.bess_calibrate_cursor(date,text,text,text,jsonb,bigint,bigint)',
    'public.bess_update_roster_status(date,text,jsonb,bigint)',
    'public.bess_assign_batch(date,text,text[],text,jsonb,timestamp with time zone,jsonb,bigint,bigint)'
  ] loop
    v_oid := pg_catalog.to_regprocedure(v_signature);
    if v_oid is null then
      raise exception using errcode = 'P0001', message = format('required dispatch RPC missing: %s', v_signature);
    end if;
    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    if pg_catalog.strpos(v_definition, v_old) > 0 then
      execute pg_catalog.replace(v_definition, v_old, v_new);
    elsif pg_catalog.strpos(v_definition, v_new) = 0 then
      raise exception using errcode = 'P0001', message = format('scope guard not found in dispatch RPC: %s', v_signature);
    end if;
  end loop;
end;
$migration$;

commit;
