-- Opt-in AD game source cards. Coordinate existing pending root/ingest writes
-- through a batch-lock trigger; do not change qianchuan, roster or cursor RPCs.
-- Requires db/migrations/20261023_dispatch_ingest_root.sql first.
begin;
create table public.bess_source_card_manifests (
  source_batch_id text primary key,
  manifest jsonb not null,
  created_at timestamptz not null default now()
);
create table public.bess_source_card_chunks (
  batch_id text primary key,
  source_batch_id text not null references public.bess_source_card_manifests(source_batch_id),
  chunk_index integer not null,
  binding jsonb not null,
  request_ids jsonb not null,
  delivery_fingerprint text,
  unique(source_batch_id,chunk_index)
);
alter table public.bess_source_card_manifests enable row level security;
alter table public.bess_source_card_manifests force row level security;
alter table public.bess_source_card_chunks enable row level security;
alter table public.bess_source_card_chunks force row level security;
revoke all on public.bess_source_card_manifests,public.bess_source_card_chunks from public,anon,authenticated,service_role;
-- Facts are deliberately non-expiring and writable only through registration.
create table public.bess_source_card_legacy_messages (
  chat_id text not null, request_id text not null, message_id text not null,
  primary key(chat_id,request_id,message_id)
);
alter table public.bess_source_card_legacy_messages enable row level security;
alter table public.bess_source_card_legacy_messages force row level security;
revoke all on public.bess_source_card_legacy_messages from public,anon,authenticated,service_role;

-- Every old root/ingest write takes the same global batch lock as registration.
-- The trigger covers RPCs AND direct REST inserts/updates, including pre-guard callers.
create function public.bess_source_card_pending_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_batch text; v_chunk public.bess_source_card_chunks%rowtype; v_plan jsonb;
begin
  if new.request_context->>'kind' not in ('dispatch_ingest','dispatch_ingest_root','batch_dispatch','batch') then return new; end if;
  for v_batch in
    select id from (
      select new.request_context->>'batchId' id
      union select value->>'batch_id' from jsonb_array_elements(
        coalesce(new.request_context->'chunkPlan','[]'::jsonb))
    ) x where id is not null order by id
  loop
    perform pg_advisory_xact_lock(hashtextextended('source-card-batch:'||v_batch,0));
    select * into v_chunk from public.bess_source_card_chunks where batch_id=v_batch;
    if found then
      if new.chat_id is distinct from v_chunk.binding->>'chat_id' then
        raise exception 'SOURCE_CARD_BINDING_CONFLICT';
      end if;
      if new.request_context->>'kind' in ('batch_dispatch','batch') then
        if jsonb_typeof(new.request_context->'items') is distinct from 'array'
          or (select jsonb_agg(item->'requestId' order by n) from
            jsonb_array_elements(new.request_context->'items') with ordinality x(item,n))
            is distinct from v_chunk.request_ids
          or exists(select 1 from jsonb_array_elements(new.request_context->'items') item
            where item->'sourceCardBinding' is distinct from v_chunk.binding) then
          raise exception 'SOURCE_CARD_BINDING_CONFLICT';
        end if;
      elsif new.request_context->>'kind'='dispatch_ingest_root' then
        select value into v_plan from jsonb_array_elements(new.request_context->'chunkPlan')
          where value->>'batch_id'=v_batch;
        if v_chunk.delivery_fingerprint is null
          or v_plan->>'fingerprint' is distinct from v_chunk.delivery_fingerprint
          or v_plan->'request_ids' is distinct from v_chunk.request_ids
          or new.request_context->>'fingerprint' is distinct from v_chunk.delivery_fingerprint
          or new.request_context->'requestIds' is distinct from v_chunk.request_ids then
          raise exception 'SOURCE_CARD_BINDING_CONFLICT';
        end if;
      else
        if v_chunk.delivery_fingerprint is null
          or new.request_context->>'fingerprint' is distinct from v_chunk.delivery_fingerprint
          or new.request_context->'requestIds' is distinct from v_chunk.request_ids then
          raise exception 'SOURCE_CARD_BINDING_CONFLICT';
        end if;
        -- State updates may omit the replay body; first handoff may not.
        if tg_op='INSERT' and new.request_context->'queueMessage'->'source_card_manifest'
          is distinct from (select manifest from public.bess_source_card_manifests
            where source_batch_id=v_chunk.source_batch_id)
          and not exists(select 1 from public.bess_dispatch_pending_forms p
            where p.form_message_id=new.form_message_id and p.chat_id=new.chat_id
              and p.request_context->>'fingerprint'=v_chunk.delivery_fingerprint
              and p.request_context->>'batchId'=v_batch) then
          raise exception 'SOURCE_CARD_BINDING_CONFLICT';
        end if;
      end if;
    end if;
  end loop;
  if tg_op='UPDATE' then
    -- An old, not-yet-sent outbox captured at source freeze remains a proven
    -- legacy origin. Record its eventual Lark message before pending cleanup.
    insert into public.bess_source_card_legacy_messages(chat_id,request_id,message_id)
      select old.chat_id, origin.request_id, msg
      from public.bess_source_card_legacy_messages origin
      cross join lateral unnest(array[new.original_message_id,new.request_context->>'messageId']) m(msg)
      where origin.chat_id=old.chat_id and origin.message_id=old.form_message_id
        and msg like 'om_%' and new.chat_id=old.chat_id
        and new.request_context->>'fingerprint' is not distinct from old.request_context->>'fingerprint'
      on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function public.bess_source_card_pending_guard() from public,anon,authenticated,service_role;
create trigger bess_source_card_pending_guard before insert or update on public.bess_dispatch_pending_forms
  for each row execute function public.bess_source_card_pending_guard();

create function public.bess_source_card_canonical(p_value jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare v_type text:=jsonb_typeof(p_value); v_result text;
begin
  if v_type='object' then
    select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.bess_source_card_canonical(value),',' order by key collate "C"),'')||'}'
      into v_result from jsonb_each(p_value);
  elsif v_type='array' then
    select '['||coalesce(string_agg(public.bess_source_card_canonical(value),',' order by n),'')||']'
      into v_result from jsonb_array_elements(p_value) with ordinality x(value,n);
  else v_result:=p_value::text; end if;
  return v_result;
end $$;

create function public.bess_register_source_card_manifest(p_manifest jsonb,p_root jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_source text; v_root jsonb; v_chunk jsonb; v_binding jsonb; v_old public.bess_source_card_chunks%rowtype;
  v_total integer; v_count integer; v_i integer:=0; v_expected integer; v_ids jsonb:='[]';
  v_digest text; v_outcome text;
begin
  if jsonb_typeof(p_manifest) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_manifest))<>9
    or not (p_manifest ?& array['version','source_batch_id','chat_id','dispatch_profile','target_category','total_item_count','chunk_count','chunks','manifest_hash'])
    or p_manifest->'version' is distinct from '1'::jsonb
    or jsonb_typeof(p_manifest->'source_batch_id') is distinct from 'string'
    or coalesce(p_manifest->>'source_batch_id','')!~'^[A-Za-z0-9_-]{1,128}$'
    or jsonb_typeof(p_manifest->'chat_id') is distinct from 'string'
    or coalesce(p_manifest->>'chat_id','')!~'^oc_[A-Za-z0-9_]{1,128}$'
    or p_manifest->>'dispatch_profile' is distinct from 'ad'
    or p_manifest->>'target_category' is distinct from 'game_agent'
    or jsonb_typeof(p_manifest->'total_item_count') is distinct from 'number'
    or coalesce(p_manifest->>'total_item_count','')!~'^[0-9]+$'
    or jsonb_typeof(p_manifest->'chunk_count') is distinct from 'number'
    or coalesce(p_manifest->>'chunk_count','')!~'^[0-9]+$'
    or jsonb_typeof(p_manifest->'chunks') is distinct from 'array'
    or coalesce(p_manifest->>'manifest_hash','')!~'^[a-f0-9]{64}$' then
    raise exception 'SOURCE_CARD_INVALID_MANIFEST';
  end if;
  v_total:=(p_manifest->>'total_item_count')::integer; v_count:=(p_manifest->>'chunk_count')::integer;
  if v_total<1 or v_total>1000 or v_count<>(v_total+19)/20 or jsonb_array_length(p_manifest->'chunks')<>v_count
    or p_manifest->>'manifest_hash'<>encode(sha256(convert_to(public.bess_source_card_canonical(p_manifest-'manifest_hash'),'UTF8')),'hex') then
    raise exception 'SOURCE_CARD_INVALID_MANIFEST';
  end if;
  for v_chunk in select value from jsonb_array_elements(p_manifest->'chunks') loop
    v_i:=v_i+1; v_expected:=least(20,v_total-(v_i-1)*20);
    if jsonb_typeof(v_chunk) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(v_chunk))<>4
      or not(v_chunk ?& array['chunk_index','batch_id','item_count','request_ids'])
      or v_chunk->'chunk_index' is distinct from to_jsonb(v_i)
      or v_chunk->'item_count' is distinct from to_jsonb(v_expected)
      or jsonb_typeof(v_chunk->'batch_id') is distinct from 'string'
      or coalesce(v_chunk->>'batch_id','')!~'^[A-Za-z0-9_-]{1,128}$'
      or jsonb_typeof(v_chunk->'request_ids') is distinct from 'array' then
      raise exception 'SOURCE_CARD_INVALID_MANIFEST';
    end if;
    if jsonb_array_length(v_chunk->'request_ids')<>v_expected
      or exists(select 1 from jsonb_array_elements(v_chunk->'request_ids') x(id)
        where jsonb_typeof(id)<>'string' or (id#>>'{}')!~'^[A-Za-z0-9_-]{1,64}$') then
      raise exception 'SOURCE_CARD_INVALID_MANIFEST';
    end if;
    v_ids:=v_ids||(v_chunk->'request_ids');
  end loop;
  if (select count(distinct value) from jsonb_array_elements(v_ids))<>v_total
    or (select count(distinct value->>'batch_id') from jsonb_array_elements(p_manifest->'chunks'))<>v_count then
    raise exception 'SOURCE_CARD_INVALID_MANIFEST';
  end if;
  v_source:=p_manifest->>'source_batch_id';
  -- Lock the complete batch set BEFORE testing any persistent occupation.
  -- A waiting registration re-reads committed old writes after acquiring the lock.
  for v_chunk in select value from jsonb_array_elements(p_manifest->'chunks') order by value->>'batch_id' loop
    perform pg_advisory_xact_lock(hashtextextended('source-card-batch:'||(v_chunk->>'batch_id'),0));
  end loop;
  for v_chunk in select value from jsonb_array_elements(p_manifest->'chunks') loop
    if not exists(select 1 from public.bess_source_card_chunks where batch_id=v_chunk->>'batch_id')
      and exists(select 1 from public.bess_dispatch_pending_forms p
        where p.request_context->>'kind' in ('dispatch_ingest','dispatch_ingest_root','batch_dispatch','batch')
        and (p.request_context->>'batchId'=v_chunk->>'batch_id'
          or exists(select 1 from jsonb_array_elements(coalesce(p.request_context->'chunkPlan','[]')) plan
            where plan->>'batch_id'=v_chunk->>'batch_id'))) then
      raise exception 'SOURCE_CARD_BINDING_CONFLICT';
    end if;
  end loop;
  -- Freeze proven pre-source AD game message provenance; do not whitelist a
  -- bare request ID or a caller-provided batch. Keep facts after pending expiry.
  insert into public.bess_source_card_legacy_messages(chat_id,request_id,message_id)
    select distinct p.chat_id, id#>>'{}', msg
    from public.bess_dispatch_pending_forms p cross join jsonb_array_elements(v_ids) x(id)
    cross join lateral unnest(array[p.form_message_id,p.original_message_id,p.request_context->>'messageId']) m(msg)
    where p.chat_id=p_manifest->>'chat_id' and (msg like 'om_%' or msg=p.form_message_id)
      and not exists(select 1 from public.bess_source_card_manifests where source_batch_id=v_source)
      and not (p.request_context ? 'sourceCardBinding')
      and p.request_context::text not like '%source_card_binding%'
      and p.request_context::text not like '%sourceCardBinding%'
      and ((p.request_context->>'requestId'=id#>>'{}'
          and p.request_context->>'dispatchProfile'='ad' and p.request_context->>'targetCategory'='game_agent')
        or jsonb_path_exists(p.request_context,
          '$.** ? (@.request_id == $id && @.dispatch_profile == "ad" && @.target_category == "game_agent")',
          jsonb_build_object('id',id))
        or jsonb_path_exists(p.request_context,
          '$.** ? (@.requestId == $id && @.dispatchProfile == "ad" && @.targetCategory == "game_agent")',
          jsonb_build_object('id',id)))
    on conflict do nothing;
  insert into public.bess_source_card_manifests values(v_source,p_manifest,now()) on conflict do nothing;
  select manifest into strict v_root from public.bess_source_card_manifests where source_batch_id=v_source for update;
  if v_root<>p_manifest then raise exception 'SOURCE_CARD_BINDING_CONFLICT'; end if;
  -- Reserve ALL chunks on first delivery, including not-yet-delivered ordinals.
  -- Sorted insertion prevents lock-order deadlocks between overlapping sources.
  for v_chunk in select value from jsonb_array_elements(p_manifest->'chunks') order by value->>'batch_id' loop
    v_binding:=(p_manifest-'chunks')||jsonb_build_object('chunk_index',v_chunk->'chunk_index','batch_id',v_chunk->'batch_id');
    insert into public.bess_source_card_chunks(batch_id,source_batch_id,chunk_index,binding,request_ids)
      values(v_chunk->>'batch_id',v_source,(v_chunk->>'chunk_index')::integer,v_binding,v_chunk->'request_ids')
      on conflict do nothing;
    select * into strict v_old from public.bess_source_card_chunks where batch_id=v_chunk->>'batch_id';
    if v_old.binding<>v_binding or v_old.request_ids<>v_chunk->'request_ids' then raise exception 'SOURCE_CARD_BINDING_CONFLICT'; end if;
  end loop;
  if p_root is not null then
    select * into v_old from public.bess_source_card_chunks where batch_id=p_root->>'batchId';
    if not found or v_old.source_batch_id<>v_source
      or p_root->>'chatId' is distinct from p_manifest->>'chat_id'
      or coalesce(p_root->>'fingerprint','')!~'^[a-f0-9]{64}$'
      or p_root->'requestIds' is distinct from v_old.request_ids
      or p_root->'chunkPlan' is distinct from jsonb_build_array(jsonb_build_object(
        'batch_id',p_root->>'batchId','fingerprint',p_root->>'fingerprint','request_ids',v_old.request_ids))
      or (v_old.delivery_fingerprint is not null and v_old.delivery_fingerprint<>p_root->>'fingerprint') then
      raise exception 'SOURCE_CARD_BINDING_CONFLICT';
    end if;
    update public.bess_source_card_chunks set delivery_fingerprint=p_root->>'fingerprint'
      where batch_id=p_root->>'batchId';
    v_digest:=substr(encode(sha256(convert_to((p_root->>'chatId')||':'||(p_root->>'batchId'),'UTF8')),'hex'),1,48);
    select outcome into v_outcome from public.bess_reserve_dispatch_ingest_root(
      'br_'||v_digest,'ingest_root_'||v_digest,p_root->>'chatId',p_root->>'batchId',
      p_root->>'fingerprint',p_root->'requestIds',p_root->'chunkPlan',
      (p_root->>'expiresAt')::timestamptz,(p_root->>'now')::timestamptz);
    if v_outcome not in ('ACCEPTED','REUSED') then raise exception 'SOURCE_CARD_BINDING_CONFLICT'; end if;
  end if;
  return jsonb_build_object('outcome','ACCEPTED');
end $$;

create function public.bess_assert_source_card_binding(p_binding jsonb,p_request_ids jsonb,p_subset boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_chunk public.bess_source_card_chunks%rowtype;
begin
  select * into v_chunk from public.bess_source_card_chunks where batch_id=p_binding->>'batch_id';
  if not found or v_chunk.binding is distinct from p_binding
    or jsonb_typeof(p_request_ids) is distinct from 'array' or jsonb_array_length(p_request_ids)<1
    or (not p_subset and v_chunk.request_ids is distinct from p_request_ids)
    or (p_subset and (jsonb_array_length(p_request_ids)<>1 or not(v_chunk.request_ids @> p_request_ids)))
    or p_subset is null then raise exception 'SOURCE_CARD_BINDING_CONFLICT'; end if;
  return jsonb_build_object('outcome','ACCEPTED');
end $$;
create function public.bess_assert_legacy_source_card_batch(p_batch_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.bess_source_card_chunks where batch_id=p_batch_id) then
    raise exception 'SOURCE_CARD_BINDING_CONFLICT';
  end if;
  return jsonb_build_object('outcome','ACCEPTED');
end $$;
create function public.bess_assert_legacy_source_card_members(p_chat_id text,p_items jsonb,p_message_id text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_item jsonb;
begin
  for v_item in select value from jsonb_array_elements(p_items) loop
    if exists(select 1 from public.bess_source_card_chunks c
        where c.binding->>'chat_id'=p_chat_id
          and c.binding->>'dispatch_profile'=v_item->>'dispatch_profile'
          and c.binding->>'target_category'=v_item->>'target_category'
          and c.request_ids @> jsonb_build_array(v_item->>'request_id'))
      and not exists(select 1 from public.bess_source_card_legacy_messages
        where chat_id=p_chat_id and request_id=v_item->>'request_id' and message_id=p_message_id) then
      raise exception 'SOURCE_CARD_BINDING_CONFLICT';
    end if;
  end loop;
  return jsonb_build_object('outcome','ACCEPTED');
end $$;
revoke all on function public.bess_assert_legacy_source_card_members(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.bess_assert_legacy_source_card_members(text,jsonb,text) to service_role;
revoke all on function public.bess_assert_legacy_source_card_batch(text) from public,anon,authenticated;
grant execute on function public.bess_assert_legacy_source_card_batch(text) to service_role;
revoke all on function public.bess_source_card_canonical(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.bess_register_source_card_manifest(jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.bess_assert_source_card_binding(jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.bess_register_source_card_manifest(jsonb,jsonb),public.bess_assert_source_card_binding(jsonb,jsonb,boolean) to service_role;
commit;
