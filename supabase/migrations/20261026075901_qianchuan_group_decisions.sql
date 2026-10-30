-- Additive, opt-in qianchuan-review/v2 path. No legacy RPC is replaced.
begin;

create table public.bess_qianchuan_sources (
  scope text not null check (scope in ('default','test_default')),
  source_batch_id text not null check (length(source_batch_id) between 1 and 256),
  day_key date not null,
  manifest jsonb not null check (jsonb_typeof(manifest)='object'),
  group_plan jsonb check (group_plan is null or jsonb_typeof(group_plan)='object'),
  initial_observations jsonb,
  write_bindings jsonb not null default '{}'::jsonb check (jsonb_typeof(write_bindings)='object'),
  writer_form_message_id text,
  pending_request_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(pending_request_ids)='array'),
  confirmed_request_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(confirmed_request_ids)='array'),
  created_at timestamptz not null default now(),
  primary key(scope,source_batch_id)
);
alter table public.bess_qianchuan_sources enable row level security;
alter table public.bess_qianchuan_sources force row level security;
revoke all on public.bess_qianchuan_sources from public,anon,authenticated,service_role;
grant select on public.bess_qianchuan_sources to service_role;

create function public.bess_register_qianchuan_source(p_scope text,p_day_key date,p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_root public.bess_qianchuan_sources%rowtype; v_source text; v_count integer;
begin
  v_source:=p_manifest->>'sourceBatchId';
  if p_scope is null or p_scope not in ('default','test_default') or p_day_key is null
     or p_manifest->>'contract' is distinct from 'qianchuan-review/v2'
     or p_manifest->>'serverPolicy' is distinct from 'qianchuan-grouped/v1'
     or coalesce(v_source,'')='' or length(v_source)>256
     or coalesce(p_manifest->>'snapshotHash','')!~'^[a-f0-9]{64}$'
     or coalesce(p_manifest->>'upstreamSnapshotHash','')!~'^[a-f0-9]{64}$'
     or coalesce(p_manifest->>'policyVersion','')=''
     or jsonb_typeof(p_manifest->'sourceSnapshot') is distinct from 'array'
     or jsonb_typeof(p_manifest->'members') is distinct from 'array' then
    raise exception 'QIANCHUAN_INVALID_MANIFEST';
  end if;
  v_count:=jsonb_array_length(p_manifest->'members');
  if v_count<1 or v_count>1000 or jsonb_array_length(p_manifest->'sourceSnapshot')<>v_count
     or (select count(distinct m->>'requestId') from jsonb_array_elements(p_manifest->'members') m)<>v_count
     or exists(select 1 from jsonb_array_elements(p_manifest->'members') with ordinality x(m,n)
       where coalesce(m->>'requestId','')='' or coalesce(m->>'assignmentGroup','')=''
       or (m->>'sourcePosition')::integer is distinct from n-1) then
    raise exception 'QIANCHUAN_INVALID_MANIFEST';
  end if;
  insert into public.bess_qianchuan_sources(scope,source_batch_id,day_key,manifest)
    values(p_scope,v_source,p_day_key,p_manifest) on conflict(scope,source_batch_id) do nothing;
  select s.* into strict v_root from public.bess_qianchuan_sources s
    where s.scope=p_scope and s.source_batch_id=v_source for update;
  if v_root.day_key<>p_day_key or v_root.manifest<>p_manifest then raise exception 'QIANCHUAN_SOURCE_CONFLICT'; end if;
  return jsonb_build_object('outcome','ACCEPTED');
end $$;

create function public.bess_assert_qianchuan_claim(p_form_message_id text,p_claim_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_context jsonb;
begin
  select p.request_context into v_context from public.bess_dispatch_pending_forms p
    where p.form_message_id=p_form_message_id for update;
  if not found or coalesce(p_claim_token,'')='' or v_context->>'kind' is distinct from 'batch_dispatch'
     or v_context->>'status' is distinct from 'PROCESSING'
     or v_context->>'claimToken' is distinct from p_claim_token
     or coalesce((v_context->>'leaseExpiresAt')::timestamptz,'-infinity'::timestamptz)<=clock_timestamp() then
    raise exception 'BATCH_CLAIM_LOST';
  end if;
  return v_context;
end $$;

create function public.bess_assign_qianchuan_groups(
  p_day_key date,p_scope text,p_form_message_id text,p_claim_token text,p_items jsonb,p_observations jsonb,
  p_anchor_assignee text,p_expected_version bigint,p_expected_cursor_version bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_context jsonb; v_root public.bess_qianchuan_sources%rowtype;
  v_state public.bess_dispatch_daily_state%rowtype; v_old public.bess_dispatch_assignments%rowtype;
  v_member jsonb; v_item jsonb; v_observation jsonb; v_plan jsonb; v_manuals jsonb:='{}';
  v_group text; v_name text; v_source text; v_hash text; v_count integer; v_cursor bigint;
  v_index integer; v_steps integer; v_new_seq bigint; v_result jsonb:='[]'; v_pending jsonb:='[]';
  v_any_new boolean; v_replayed boolean; v_bindings jsonb;
begin
  v_context:=public.bess_assert_qianchuan_claim(p_form_message_id,p_claim_token);
  if p_scope is null or p_scope not in ('default','test_default') or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and 20 then raise exception 'QIANCHUAN_INVALID_CARD_CONTRACT'; end if;
  v_source:=p_items->0->>'sourceBatchId'; v_hash:=p_items->0->>'decisionManifestHash';
  select s.* into v_root from public.bess_qianchuan_sources s
    where s.scope=p_scope and s.source_batch_id=v_source for update;
  if not found or v_root.day_key<>p_day_key or v_root.manifest->>'snapshotHash' is distinct from v_hash then
    raise exception 'QIANCHUAN_SOURCE_CONFLICT'; end if;
  if (select count(distinct i->>'requestId') from jsonb_array_elements(p_items) i)<>jsonb_array_length(p_items) then
    raise exception 'QIANCHUAN_MEMBER_CONFLICT'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_member:=v_root.manifest->'members'->(v_item->>'sourcePosition')::integer;
    if v_member is null or v_member->>'requestId' is distinct from v_item->>'requestId'
       or v_member->>'auditObjectId' is distinct from v_item->>'auditObjectId'
       or v_member->'rejectReasonCodes' is distinct from v_item->'rejectReasonCodes'
       or v_member->>'decisionGroup' is distinct from v_item->>'decisionGroup'
       or v_member->>'sheetUrl' is distinct from v_item->>'sheetUrl'
       or v_member->>'sheetId' is distinct from v_item->>'sheetId'
       or v_member->>'assigneeFieldId' is distinct from v_item->>'assigneeFieldId'
       or v_item->>'sourceBatchId' is distinct from v_source or v_item->>'dispatchScope' is distinct from p_scope
       or v_item->>'targetCategory' is distinct from 'qianchuan' or v_item->>'dispatchDirection' is distinct from 'forward'
       or v_item->>'decisionManifestHash' is distinct from v_hash
       or v_item->>'decisionSnapshotHash' is distinct from v_root.manifest->>'upstreamSnapshotHash'
       or v_item->>'decisionPolicyVersion' is distinct from v_root.manifest->>'policyVersion'
       or not exists(select 1 from jsonb_array_elements(v_context->'items') c where c->>'requestId'=v_item->>'requestId'
         and c->>'decisionManifestHash'=v_hash and c->>'sourceBatchId'=v_source) then
      raise exception 'QIANCHUAN_MEMBER_CONFLICT';
    end if;
    -- Same request lock ordering as the unique daily assignment boundary.
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_day_key::text||':'||p_scope||':'||(i->>'requestId')))
    from jsonb_array_elements(p_items) i order by i->>'requestId';
  if (jsonb_array_length(v_root.pending_request_ids)>0 and v_root.writer_form_message_id is distinct from p_form_message_id)
     or exists(select 1 from jsonb_array_elements_text(v_root.pending_request_ids) pending
    where not exists(select 1 from jsonb_array_elements(p_items) i where i->>'requestId'=pending)) then
    raise exception 'QIANCHUAN_WRITE_RECONCILIATION_REQUIRED'; end if;
  if jsonb_typeof(p_observations) is distinct from 'array'
     or jsonb_array_length(p_observations)<>jsonb_array_length(v_root.manifest->'members') then
    raise exception 'QIANCHUAN_OBSERVATION_INVALID'; end if;
  select s.* into v_state from public.bess_dispatch_daily_state s
    where s.day_key=p_day_key and s.scope=p_scope and s.expires_at>now() for update;
  if not found then raise exception 'QIANCHUAN_ROSTER_REQUIRED'; end if;
  select exists(select 1 from jsonb_array_elements(p_items) i where not exists(
    select 1 from public.bess_dispatch_assignments a where a.day_key=p_day_key and a.scope=p_scope
      and a.request_id=i->>'requestId')) into v_any_new;
  if v_any_new and (p_expected_version is null or p_expected_cursor_version is null
     or v_state.version<>p_expected_version or v_state.forward_version<>p_expected_cursor_version) then
    raise exception 'CAS_QIANCHUAN_VERSION_MISMATCH'; end if;
  v_count:=jsonb_array_length(v_state.roster); v_cursor:=v_state.forward_cursor;
  if v_count<1 then raise exception 'QIANCHUAN_ROSTER_REQUIRED'; end if;
  for v_index in 0..jsonb_array_length(p_observations)-1 loop
    v_member:=v_root.manifest->'members'->v_index; v_observation:=p_observations->v_index;
    if v_observation->>'requestId' is distinct from v_member->>'requestId'
       or coalesce(v_observation->>'rowIndex','')!~'^[1-9][0-9]*$'
       or jsonb_typeof(v_observation->'assignee') is distinct from 'string' then
      raise exception 'QIANCHUAN_OBSERVATION_INVALID'; end if;
    v_name:=btrim(v_observation->>'assignee'); v_group:=v_member->>'assignmentGroup';
    if v_name<>'' then
      if not(v_state.roster?v_name) then raise exception 'ASSIGNEE_NOT_IN_ROSTER'; end if;
      if v_manuals?v_group and v_manuals->>v_group<>v_name then raise exception 'QIANCHUAN_MANUAL_GROUP_CONFLICT'; end if;
      v_manuals:=v_manuals||jsonb_build_object(v_group,v_name);
    end if;
  end loop;
  v_plan:=v_root.group_plan;
  if v_plan is null then
    v_plan:='{}';
    if coalesce(p_anchor_assignee,'')<>'' then
      select n-1 into v_index from jsonb_array_elements_text(v_state.roster) with ordinality r(person,n) where person=p_anchor_assignee;
      if not found then raise exception 'ASSIGNEE_NOT_IN_ROSTER'; end if;
      v_cursor:=v_cursor+(((v_index+1)%v_count-v_cursor%v_count+v_count)%v_count);
    end if;
    for v_member in select value from jsonb_array_elements(v_root.manifest->'members') loop
      v_group:=v_member->>'assignmentGroup';
      if v_plan?v_group then continue; end if;
      v_name:=v_manuals->>v_group;
      if v_name is not null then
        select n-1 into v_index from jsonb_array_elements_text(v_state.roster) with ordinality r(person,n) where person=v_name;
        v_cursor:=v_cursor+(((v_index+1)%v_count-v_cursor%v_count+v_count)%v_count);
      else
        v_steps:=0;
        while v_steps<v_count and v_state.off_duty?(v_state.roster->>(v_cursor%v_count)::integer) loop
          v_cursor:=v_cursor+1; v_steps:=v_steps+1;
        end loop;
        if v_steps=v_count then raise exception 'ALL_OFF_DUTY'; end if;
        v_name:=v_state.roster->>(v_cursor%v_count)::integer; v_cursor:=v_cursor+1;
      end if;
      v_plan:=v_plan||jsonb_build_object(v_group,jsonb_build_object('assignee',v_name,'consumesTurn',not(v_manuals?v_group)));
    end loop;
  end if;
  for v_member in select value from jsonb_array_elements(v_root.manifest->'members') loop
    v_group:=v_member->>'assignmentGroup'; v_name:=v_plan->v_group->>'assignee';
    if v_name is null or not(v_state.roster?v_name) or v_state.off_duty?v_name then
      raise exception 'QIANCHUAN_GROUP_ASSIGNEE_UNAVAILABLE'; end if;
    if v_manuals?v_group and v_manuals->>v_group<>v_name then raise exception 'QIANCHUAN_MANUAL_GROUP_CONFLICT'; end if;
  end loop;
  v_new_seq:=v_state.assignment_seq;
  v_bindings:=v_root.write_bindings;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_member:=v_root.manifest->'members'->(v_item->>'sourcePosition')::integer;
    if v_item->>'rowIndex' is distinct from p_observations->(v_item->>'sourcePosition')::integer->>'rowIndex' then
      raise exception 'QIANCHUAN_OBSERVATION_INVALID'; end if;
    v_name:=v_plan->(v_member->>'assignmentGroup')->>'assignee';
    select a.* into v_old from public.bess_dispatch_assignments a where a.day_key=p_day_key and a.scope=p_scope
      and a.request_id=v_item->>'requestId'; v_replayed:=found;
    if v_replayed then
      if v_old.assignee<>v_name or v_old.request_context->>'decisionManifestHash' is distinct from v_hash
         or v_old.request_context->>'sourceBatchId' is distinct from v_source then raise exception 'QIANCHUAN_MEMBER_CONFLICT'; end if;
    else
      v_new_seq:=v_new_seq+1;
      insert into public.bess_dispatch_assignments(day_key,scope,request_id,assignee,direction,assignment_seq,request_context)
        values(p_day_key,p_scope,v_item->>'requestId',v_name,'forward',v_new_seq,v_item) returning * into v_old;
    end if;
    v_bindings:=v_bindings||jsonb_build_object(v_item->>'requestId',jsonb_build_object(
      'rowIndex',v_item->'rowIndex','claimToken',p_claim_token,'writer',p_form_message_id));
    if not(v_root.confirmed_request_ids?(v_item->>'requestId')) then v_pending:=v_pending||jsonb_build_array(v_item->>'requestId'); end if;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('request_id',v_item->>'requestId','assignee',v_name,
      'assignment_seq',v_old.assignment_seq,'assignment_group',v_member->>'assignmentGroup','replayed',v_replayed,
      'roster',v_state.roster,'version',v_state.version,'reverse_version',v_state.reverse_version,
      'forward_version',v_state.forward_version+case when v_cursor<>v_state.forward_cursor then 1 else 0 end));
  end loop;
  update public.bess_dispatch_daily_state s set forward_cursor=v_cursor,
    forward_version=s.forward_version+case when v_cursor<>v_state.forward_cursor then 1 else 0 end,
    assignment_seq=v_new_seq,updated_at=now() where s.day_key=p_day_key and s.scope=p_scope;
  update public.bess_qianchuan_sources s set group_plan=v_plan,pending_request_ids=v_pending,write_bindings=v_bindings,
    writer_form_message_id=case when jsonb_array_length(v_pending)>0 then p_form_message_id else null end,
    initial_observations=coalesce(s.initial_observations,p_observations) where s.scope=p_scope and s.source_batch_id=v_source;
  return v_result;
end $$;

create function public.bess_confirm_qianchuan_writes(
  p_day_key date,p_scope text,p_form_message_id text,p_claim_token text,p_source_batch_id text,p_manifest_hash text,p_receipts jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_context jsonb; v_root public.bess_qianchuan_sources%rowtype; v_receipt jsonb;
  v_assignment public.bess_dispatch_assignments%rowtype; v_confirmed jsonb; v_pending jsonb;
begin
  v_context:=public.bess_assert_qianchuan_claim(p_form_message_id,p_claim_token);
  select s.* into v_root from public.bess_qianchuan_sources s where s.scope=p_scope and s.source_batch_id=p_source_batch_id for update;
  if not found or v_root.day_key<>p_day_key or v_root.manifest->>'snapshotHash' is distinct from p_manifest_hash
     or (jsonb_array_length(v_root.pending_request_ids)>0 and v_root.writer_form_message_id is distinct from p_form_message_id)
     or jsonb_typeof(p_receipts) is distinct from 'array' or jsonb_array_length(p_receipts) not between 1 and 20
     or (select count(distinct r->>'requestId') from jsonb_array_elements(p_receipts) r)<>jsonb_array_length(p_receipts) then
    raise exception 'QIANCHUAN_RECEIPT_CONFLICT'; end if;
  v_confirmed:=v_root.confirmed_request_ids;
  for v_receipt in select value from jsonb_array_elements(p_receipts) loop
    select a.* into v_assignment from public.bess_dispatch_assignments a where a.day_key=p_day_key and a.scope=p_scope
      and a.request_id=v_receipt->>'requestId';
    if not found or v_assignment.assignee is distinct from v_receipt->>'assignee'
       or v_assignment.request_context->>'decisionManifestHash' is distinct from p_manifest_hash
       or v_assignment.request_context->>'sourceBatchId' is distinct from p_source_batch_id
       or v_root.write_bindings->(v_receipt->>'requestId')->>'rowIndex' is distinct from v_receipt->>'rowIndex'
       or v_root.write_bindings->(v_receipt->>'requestId')->>'claimToken' is distinct from p_claim_token
       or v_root.write_bindings->(v_receipt->>'requestId')->>'writer' is distinct from p_form_message_id
       or not exists(select 1 from jsonb_array_elements(v_context->'items') i where i->>'requestId'=v_receipt->>'requestId'
         and i->>'decisionManifestHash'=p_manifest_hash) then raise exception 'QIANCHUAN_RECEIPT_CONFLICT'; end if;
    if not(v_confirmed?(v_receipt->>'requestId')) then v_confirmed:=v_confirmed||jsonb_build_array(v_receipt->>'requestId'); end if;
  end loop;
  select coalesce(jsonb_agg(value),'[]'::jsonb) into v_pending from jsonb_array_elements_text(v_root.pending_request_ids)
    where not(v_confirmed?value);
  update public.bess_qianchuan_sources s set confirmed_request_ids=v_confirmed,pending_request_ids=v_pending,
    writer_form_message_id=case when jsonb_array_length(v_pending)>0 then s.writer_form_message_id else null end
    where s.scope=p_scope and s.source_batch_id=p_source_batch_id;
  return jsonb_build_object('confirmed',true);
end $$;

revoke all on function public.bess_register_qianchuan_source(text,date,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.bess_assert_qianchuan_claim(text,text) from public,anon,authenticated,service_role;
revoke all on function public.bess_assign_qianchuan_groups(date,text,text,text,jsonb,jsonb,text,bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function public.bess_confirm_qianchuan_writes(date,text,text,text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.bess_register_qianchuan_source(text,date,jsonb) to service_role;
grant execute on function public.bess_assign_qianchuan_groups(date,text,text,text,jsonb,jsonb,text,bigint,bigint) to service_role;
grant execute on function public.bess_confirm_qianchuan_writes(date,text,text,text,text,text,jsonb) to service_role;
commit;
