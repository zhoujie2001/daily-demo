-- Support qianchuan two-pool special-code rotation for 1000666/1000676.
-- Additive columns keep the ordinary forward cursor unchanged and introduce a
-- separate special-code forward cursor used by qianchuan assignment groups whose
-- assignmentGroup starts with `special_code:`.
begin;

alter table public.bess_dispatch_daily_state
  add column if not exists special_code_forward_cursor bigint not null default 0,
  add column if not exists special_code_forward_version bigint not null default 0;

create or replace function public.bess_assign_qianchuan_groups(
  p_day_key date,p_scope text,p_form_message_id text,p_claim_token text,p_items jsonb,p_observations jsonb,
  p_anchor_assignee text,p_expected_version bigint,p_expected_cursor_version bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_context jsonb; v_root public.bess_qianchuan_sources%rowtype;
  v_state public.bess_dispatch_daily_state%rowtype; v_old public.bess_dispatch_assignments%rowtype;
  v_member jsonb; v_item jsonb; v_observation jsonb; v_plan jsonb; v_manuals jsonb:='{}';
  v_group text; v_name text; v_source text; v_hash text; v_pool text; v_count integer;
  v_default_cursor bigint; v_special_cursor bigint; v_cursor bigint;
  v_initial_default_cursor bigint; v_initial_special_cursor bigint;
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
  v_count:=jsonb_array_length(v_state.roster);
  v_default_cursor:=v_state.forward_cursor;
  v_special_cursor:=v_state.special_code_forward_cursor;
  v_initial_default_cursor:=v_default_cursor;
  v_initial_special_cursor:=v_special_cursor;
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
      v_default_cursor:=v_default_cursor+(((v_index+1)%v_count-v_default_cursor%v_count+v_count)%v_count);
    end if;
    for v_member in select value from jsonb_array_elements(v_root.manifest->'members') loop
      v_group:=v_member->>'assignmentGroup';
      if v_plan?v_group then continue; end if;
      v_pool:=case when v_group like 'special_code:%' then 'special_code' else 'default' end;
      v_cursor:=case when v_pool='special_code' then v_special_cursor else v_default_cursor end;
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
      v_plan:=v_plan||jsonb_build_object(v_group,jsonb_build_object('assignee',v_name,'consumesTurn',not(v_manuals?v_group),'pool',v_pool));
      if v_pool='special_code' then v_special_cursor:=v_cursor; else v_default_cursor:=v_cursor; end if;
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
      'forward_version',v_state.forward_version+case when v_default_cursor<>v_initial_default_cursor then 1 else 0 end,
      'special_code_forward_version',v_state.special_code_forward_version+case when v_special_cursor<>v_initial_special_cursor then 1 else 0 end));
  end loop;
  update public.bess_dispatch_daily_state s set forward_cursor=v_default_cursor,
    forward_version=s.forward_version+case when v_default_cursor<>v_initial_default_cursor then 1 else 0 end,
    special_code_forward_cursor=v_special_cursor,
    special_code_forward_version=s.special_code_forward_version+case when v_special_cursor<>v_initial_special_cursor then 1 else 0 end,
    assignment_seq=v_new_seq,updated_at=now() where s.day_key=p_day_key and s.scope=p_scope;
  update public.bess_qianchuan_sources s set group_plan=v_plan,pending_request_ids=v_pending,write_bindings=v_bindings,
    writer_form_message_id=case when jsonb_array_length(v_pending)>0 then p_form_message_id else null end,
    initial_observations=coalesce(s.initial_observations,p_observations) where s.scope=p_scope and s.source_batch_id=v_source;
  return v_result;
end $$;

commit;
