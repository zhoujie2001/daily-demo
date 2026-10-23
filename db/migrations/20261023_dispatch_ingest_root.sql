-- Stable original-batch reservation. Prevents a batch_id from changing between
-- single-card and multi-card plans across retries/deploys.
begin;

create or replace function public.bess_reserve_dispatch_ingest_root(
  p_form_message_id text,
  p_request_id text,
  p_chat_id text,
  p_batch_id text,
  p_fingerprint text,
  p_request_ids jsonb,
  p_chunk_plan jsonb,
  p_expires_at timestamptz,
  p_now timestamptz default now()
)
returns table(outcome text, fingerprint text, request_ids jsonb, chunk_plan jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.bess_dispatch_pending_forms%rowtype;
  v_context jsonb;
  v_inserted integer := 0;
begin
  if nullif(btrim(p_form_message_id), '') is null
     or nullif(btrim(p_request_id), '') is null
     or nullif(btrim(p_chat_id), '') is null
     or nullif(btrim(p_batch_id), '') is null
     or nullif(btrim(p_fingerprint), '') is null
     or jsonb_typeof(p_request_ids) <> 'array'
     or jsonb_array_length(p_request_ids) < 1
     or jsonb_typeof(p_chunk_plan) <> 'array'
     or jsonb_array_length(p_chunk_plan) < 1
     or p_expires_at <= p_now then
    raise exception using errcode = '22023', message = 'invalid dispatch ingest root reservation';
  end if;

  v_context := jsonb_build_object(
    'kind', 'dispatch_ingest_root',
    'batchId', p_batch_id,
    'fingerprint', p_fingerprint,
    'requestIds', p_request_ids,
    'chunkPlan', p_chunk_plan,
    'reservedAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  insert into public.bess_dispatch_pending_forms(
    form_message_id, request_id, original_message_id, chat_id, request_context, expires_at
  ) values (
    p_form_message_id, p_request_id, p_form_message_id, p_chat_id, v_context, p_expires_at
  ) on conflict (form_message_id) do nothing;
  get diagnostics v_inserted = row_count;

  select pending.* into v_row
    from public.bess_dispatch_pending_forms pending
   where pending.form_message_id = p_form_message_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'dispatch ingest root missing after reservation';
  end if;

  if v_row.chat_id is distinct from p_chat_id
     or v_row.request_context ->> 'kind' is distinct from 'dispatch_ingest_root'
     or v_row.request_context ->> 'batchId' is distinct from p_batch_id
     or v_row.request_context ->> 'fingerprint' is distinct from p_fingerprint
     or v_row.request_context -> 'requestIds' is distinct from p_request_ids
     or v_row.request_context -> 'chunkPlan' is distinct from p_chunk_plan then
    return query select
      'PAYLOAD_CONFLICT'::text,
      coalesce(v_row.request_context ->> 'fingerprint', ''),
      coalesce(v_row.request_context -> 'requestIds', '[]'::jsonb),
      coalesce(v_row.request_context -> 'chunkPlan', '[]'::jsonb);
    return;
  end if;

  update public.bess_dispatch_pending_forms pending
     set expires_at = greatest(pending.expires_at, p_expires_at)
   where pending.form_message_id = p_form_message_id;

  return query select
    case when v_inserted > 0 then 'ACCEPTED' else 'REUSED' end,
    p_fingerprint,
    p_request_ids,
    p_chunk_plan;
end;
$$;

revoke all on function public.bess_reserve_dispatch_ingest_root(text,text,text,text,text,jsonb,jsonb,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.bess_reserve_dispatch_ingest_root(text,text,text,text,text,jsonb,jsonb,timestamptz,timestamptz)
  to service_role;

commit;
