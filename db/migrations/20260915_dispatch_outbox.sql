-- Durable dispatch outbox on the existing pending table.
-- Safe to run repeatedly. Existing dispatch_ingest rows remain readable and are
-- upgraded to QUEUED only when the same batch is enqueued again.
begin;

create index if not exists bess_dispatch_pending_forms_outbox_status_idx
  on public.bess_dispatch_pending_forms ((request_context ->> 'status'))
  where request_context ->> 'kind' = 'dispatch_ingest';

create index if not exists bess_dispatch_pending_forms_outbox_expiry_idx
  on public.bess_dispatch_pending_forms (expires_at)
  where request_context ->> 'kind' = 'dispatch_ingest';

create or replace function public.bess_enqueue_dispatch_outbox(
  p_form_message_id text,
  p_request_id text,
  p_chat_id text,
  p_batch_id text,
  p_fingerprint text,
  p_request_ids jsonb,
  p_operation_id text,
  p_card jsonb,
  p_source text,
  p_now timestamptz,
  p_expires_at timestamptz
)
returns table(outcome text, status text, operation_id text, message_id text)
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.bess_dispatch_pending_forms%rowtype;
  v_context jsonb;
begin
  if nullif(btrim(p_form_message_id), '') is null
     or nullif(btrim(p_chat_id), '') is null
     or nullif(btrim(p_batch_id), '') is null
     or nullif(btrim(p_fingerprint), '') is null
     or nullif(btrim(p_operation_id), '') is null
     or jsonb_typeof(p_request_ids) <> 'array'
     or jsonb_typeof(p_card) <> 'object'
     or p_expires_at <= p_now then
    raise exception using errcode = '22023', message = 'invalid dispatch outbox payload';
  end if;

  v_context := jsonb_build_object(
    'kind', 'dispatch_ingest', 'batchId', p_batch_id,
    'fingerprint', p_fingerprint, 'requestIds', p_request_ids,
    'operationId', p_operation_id, 'card', p_card,
    'source', coalesce(p_source, ''), 'status', 'QUEUED',
    'attempt', 0, 'nextRetryAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'leaseExpiresAt', null, 'workerToken', null, 'messageId', '', 'errorCode', ''
  );

  insert into public.bess_dispatch_pending_forms(
    form_message_id, request_id, original_message_id, chat_id, request_context, expires_at
  ) values (
    p_form_message_id, p_request_id, p_form_message_id, p_chat_id, v_context, p_expires_at
  ) on conflict (form_message_id) do nothing;

  select pending.* into v_row
    from public.bess_dispatch_pending_forms pending
   where pending.form_message_id = p_form_message_id
   for update;
  if not found then raise exception using errcode = 'P0002', message = 'outbox row missing after enqueue'; end if;
  if (v_row.request_context ->> 'kind') is distinct from 'dispatch_ingest'
     or (v_row.request_context ->> 'fingerprint') is distinct from p_fingerprint then
    return query select 'CONFLICT'::text, coalesce(v_row.request_context ->> 'status', 'UNKNOWN'),
      coalesce(v_row.request_context ->> 'operationId', ''), ''::text;
    return;
  end if;
  if v_row.request_context ->> 'status' = 'SENT' then
    return query select 'COMPLETE'::text, 'SENT'::text,
      coalesce(v_row.request_context ->> 'operationId', p_operation_id),
      coalesce(v_row.request_context ->> 'messageId', '');
    return;
  end if;
  if v_row.request_context ->> 'status' = 'DEAD' then
    return query select 'ACCEPTED'::text, 'DEAD'::text,
      coalesce(v_row.request_context ->> 'operationId', p_operation_id), ''::text;
    return;
  end if;

  -- Upgrade legacy SENDING/FAILED rows in place. Stable operationId is immutable.
  if nullif(v_row.request_context ->> 'operationId', '') is null then
    update public.bess_dispatch_pending_forms pending
       set request_context = v_context,
           completed_at = null,
           expires_at = greatest(pending.expires_at, p_expires_at)
     where pending.form_message_id = p_form_message_id;
    return query select 'ACCEPTED'::text, 'QUEUED'::text, p_operation_id, ''::text;
    return;
  end if;

  return query select 'ACCEPTED'::text,
    coalesce(v_row.request_context ->> 'status', 'QUEUED'),
    v_row.request_context ->> 'operationId',
    coalesce(v_row.request_context ->> 'messageId', '');
end;
$$;

create or replace function public.bess_claim_dispatch_outbox(
  p_worker_token text,
  p_limit integer default 5,
  p_lease_seconds integer default 45,
  p_max_attempts integer default 8,
  p_now timestamptz default now()
)
returns table(
  form_message_id text, chat_id text, batch_id text, operation_id text,
  request_ids jsonb, card jsonb, attempt integer
)
language plpgsql security definer set search_path = '' as $$
begin
  if nullif(btrim(p_worker_token), '') is null or p_limit < 1 or p_limit > 50
     or p_lease_seconds < 5 or p_lease_seconds > 300 or p_max_attempts < 1 then
    raise exception using errcode = '22023', message = 'invalid outbox worker claim';
  end if;
  return query
  with candidates as (
    select pending.form_message_id
      from public.bess_dispatch_pending_forms pending
     where pending.request_context ->> 'kind' = 'dispatch_ingest'
       and pending.expires_at > p_now
       and coalesce((pending.request_context ->> 'attempt')::integer, 0) < p_max_attempts
       and (
         ((pending.request_context ->> 'status') in ('QUEUED', 'RETRY')
           and coalesce(nullif(pending.request_context ->> 'nextRetryAt', '')::timestamptz, '-infinity') <= p_now)
         or ((pending.request_context ->> 'status') = 'PROCESSING'
           and coalesce(nullif(pending.request_context ->> 'leaseExpiresAt', '')::timestamptz, '-infinity') <= p_now)
       )
     order by coalesce(nullif(pending.request_context ->> 'nextRetryAt', '')::timestamptz, '-infinity'), pending.created_at
     for update skip locked
     limit p_limit
  ), claimed as (
    update public.bess_dispatch_pending_forms pending
       set request_context = pending.request_context || jsonb_build_object(
         'status', 'PROCESSING',
         'workerToken', p_worker_token,
         'leaseExpiresAt', to_char((p_now + make_interval(secs => p_lease_seconds)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'attempt', coalesce((pending.request_context ->> 'attempt')::integer, 0) + 1,
         'startedAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       )
      from candidates
     where pending.form_message_id = candidates.form_message_id
    returning pending.*
  )
  select claimed.form_message_id, claimed.chat_id,
    claimed.request_context ->> 'batchId', claimed.request_context ->> 'operationId',
    claimed.request_context -> 'requestIds', claimed.request_context -> 'card',
    (claimed.request_context ->> 'attempt')::integer
  from claimed;
end;
$$;

create or replace function public.bess_complete_dispatch_outbox(
  p_form_message_id text, p_worker_token text, p_operation_id text,
  p_message_id text, p_completed_at timestamptz default now()
)
returns table(completed boolean)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with changed as (
    update public.bess_dispatch_pending_forms pending
       set request_context = (pending.request_context - 'card') || jsonb_build_object(
         'status', 'SENT', 'messageId', p_message_id, 'operationId', p_operation_id,
         'leaseExpiresAt', to_char(p_completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'workerToken', null, 'completedAt', to_char(p_completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       ), original_message_id = p_message_id, completed_at = p_completed_at
     where pending.form_message_id = p_form_message_id
       and pending.request_context ->> 'kind' = 'dispatch_ingest'
       and pending.request_context ->> 'status' = 'PROCESSING'
       and pending.request_context ->> 'workerToken' = p_worker_token
       and pending.request_context ->> 'operationId' = p_operation_id
    returning 1
  ) select exists(select 1 from changed);
end;
$$;

create or replace function public.bess_retry_dispatch_outbox(
  p_form_message_id text, p_worker_token text, p_operation_id text,
  p_error_code text, p_next_retry_at timestamptz, p_dead boolean default false
)
returns table(updated boolean)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with changed as (
    update public.bess_dispatch_pending_forms pending
       set request_context = pending.request_context || jsonb_build_object(
         'status', case when p_dead then 'DEAD' else 'RETRY' end,
         'errorCode', left(coalesce(p_error_code, 'OUTBOX_DELIVERY_FAILED'), 100),
         'nextRetryAt', to_char(p_next_retry_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'leaseExpiresAt', null, 'workerToken', null
       )
     where pending.form_message_id = p_form_message_id
       and pending.request_context ->> 'status' = 'PROCESSING'
       and pending.request_context ->> 'workerToken' = p_worker_token
       and pending.request_context ->> 'operationId' = p_operation_id
    returning 1
  ) select exists(select 1 from changed);
end;
$$;

create or replace function public.bess_nudge_dispatch_outbox(
  p_form_message_id text, p_now timestamptz default now()
)
returns table(nudged boolean)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with changed as (
    update public.bess_dispatch_pending_forms pending
       set request_context = pending.request_context || jsonb_build_object(
         'status', 'RETRY', 'nextRetryAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'leaseExpiresAt', null, 'workerToken', null, 'errorCode', 'LEASE_EXPIRED'
       )
     where pending.form_message_id = p_form_message_id
       and pending.request_context ->> 'kind' = 'dispatch_ingest'
       and pending.request_context ->> 'status' = 'PROCESSING'
       and coalesce(nullif(pending.request_context ->> 'leaseExpiresAt', '')::timestamptz, '-infinity') <= p_now
    returning 1
  ) select exists(select 1 from changed);
end;
$$;

revoke all on function public.bess_enqueue_dispatch_outbox(text,text,text,text,text,jsonb,text,jsonb,text,timestamptz,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.bess_enqueue_dispatch_outbox(text,text,text,text,text,jsonb,text,jsonb,text,timestamptz,timestamptz) to service_role;
revoke all on function public.bess_claim_dispatch_outbox(text,integer,integer,integer,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.bess_claim_dispatch_outbox(text,integer,integer,integer,timestamptz) to service_role;
revoke all on function public.bess_complete_dispatch_outbox(text,text,text,text,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.bess_complete_dispatch_outbox(text,text,text,text,timestamptz) to service_role;
revoke all on function public.bess_retry_dispatch_outbox(text,text,text,text,timestamptz,boolean) from public, anon, authenticated, service_role;
grant execute on function public.bess_retry_dispatch_outbox(text,text,text,text,timestamptz,boolean) to service_role;
revoke all on function public.bess_nudge_dispatch_outbox(text,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.bess_nudge_dispatch_outbox(text,timestamptz) to service_role;

commit;
