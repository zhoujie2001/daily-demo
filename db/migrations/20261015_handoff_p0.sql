-- Migration: P0 Handoff Tracking and Idempotency Hardening
BEGIN;

CREATE OR REPLACE FUNCTION public.bess_safe_timestamptz(p_value text)
RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE
SET search_path = '' AS $$
BEGIN
  IF nullif(btrim(p_value), '') IS NULL THEN RETURN NULL; END IF;
  RETURN p_value::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- Register the intention to dispatch before calling the queue.
-- Provides early conflict detection (409) and tracks ambiguous states.
DROP FUNCTION IF EXISTS public.bess_register_dispatch_handoff(text, text, text, text, text, jsonb, text, text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.bess_register_dispatch_handoff(text, text, text, text, text, jsonb, text, jsonb, jsonb, text, timestamptz, timestamptz);
CREATE OR REPLACE FUNCTION public.bess_register_dispatch_handoff(
  p_form_message_id text,
  p_request_id text,
  p_chat_id text,
  p_batch_id text,
  p_fingerprint text,
  p_request_ids jsonb,
  p_operation_id text,
  p_card jsonb,
  p_queue_message jsonb,
  p_source text,
  p_expires_at timestamptz,
  p_now timestamptz
)
RETURNS TABLE (
  outcome text,
  current_status text,
  operation_id text,
  registered_at timestamptz,
  queue_message jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.bess_dispatch_pending_forms%ROWTYPE;
  v_context jsonb;
  v_inserted integer := 0;
BEGIN
  -- The full logical queue message is persisted in the same transaction as the
  -- handoff intent, so recovery never depends on the crashed caller's memory.
  IF p_form_message_id IS NULL OR p_fingerprint IS NULL
     OR jsonb_typeof(p_request_ids) <> 'array'
     OR jsonb_typeof(p_card) <> 'object'
     OR jsonb_typeof(p_queue_message) <> 'object'
     OR p_queue_message ->> 'chat_id' IS DISTINCT FROM p_chat_id
     OR p_queue_message ->> 'batch_id' IS DISTINCT FROM p_batch_id
     OR p_queue_message ->> 'fingerprint' IS DISTINCT FROM p_fingerprint
     OR p_queue_message ->> 'operation_id' IS DISTINCT FROM p_operation_id
     OR p_queue_message -> 'request_ids' IS DISTINCT FROM p_request_ids
     OR p_queue_message -> 'card' IS DISTINCT FROM p_card THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Missing or inconsistent handoff replay payload';
  END IF;

  -- Attempt initial registration
  v_context := jsonb_build_object(
    'kind', 'dispatch_ingest',
    'status', 'HANDOFF_PENDING',
    'batchId', p_batch_id,
    'fingerprint', p_fingerprint,
    'requestIds', p_request_ids,
    'operationId', p_operation_id,
    'card', p_card,
    'queueMessage', p_queue_message,
    'source', coalesce(p_source, ''),
    'registeredAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  INSERT INTO public.bess_dispatch_pending_forms (
    form_message_id, request_id, original_message_id, chat_id, request_context, expires_at
  ) VALUES (
    p_form_message_id, p_request_id, p_form_message_id, p_chat_id, v_context, p_expires_at
  )
  ON CONFLICT (form_message_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Lock and read existing state
  SELECT * INTO v_row
  FROM public.bess_dispatch_pending_forms
  WHERE form_message_id = p_form_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'Handoff row missing after insert attempt';
  END IF;

  -- 1. Payload Conflict Check (P0 Requirement 2)
  IF (v_row.request_context ->> 'kind') IS DISTINCT FROM 'dispatch_ingest'
     OR (v_row.request_context ->> 'fingerprint') IS DISTINCT FROM p_fingerprint
     OR (v_row.request_context ->> 'batchId') IS DISTINCT FROM p_batch_id
     OR (v_row.request_context ->> 'operationId') IS DISTINCT FROM p_operation_id THEN
    RETURN QUERY SELECT 
      'PAYLOAD_CONFLICT'::text, 
      coalesce(v_row.request_context ->> 'status', 'UNKNOWN'),
      coalesce(v_row.request_context ->> 'operationId', ''),
      coalesce(public.bess_safe_timestamptz(v_row.request_context ->> 'registeredAt'), v_row.created_at),
      v_row.request_context -> 'queueMessage';
    RETURN;
  END IF;

  -- 2. New Registration Success
  IF v_inserted > 0 THEN
    RETURN QUERY SELECT 
      'ACCEPTED'::text, 
      'HANDOFF_PENDING'::text, 
      p_operation_id,
      p_now,
      p_queue_message;
    RETURN;
  END IF;

  -- 3. Existing State Reuse (QUEUED, SENT, etc.)
  RETURN QUERY SELECT 
    'REUSED'::text, 
    coalesce(v_row.request_context ->> 'status', 'UNKNOWN'),
    coalesce(v_row.request_context ->> 'operationId', p_operation_id),
    coalesce(public.bess_safe_timestamptz(v_row.request_context ->> 'registeredAt'), v_row.created_at),
    v_row.request_context -> 'queueMessage';
END;
$$;

-- Atomically lease queue publication. Registration itself deliberately does not
-- claim: a crash between registration and publish must remain recoverable.
CREATE OR REPLACE FUNCTION public.bess_claim_dispatch_handoff_publish(
  p_form_message_id text,
  p_operation_id text,
  p_fingerprint text,
  p_worker_token text,
  p_card jsonb,
  p_now timestamptz,
  p_lease_seconds int DEFAULT 120
)
RETURNS TABLE (claimed boolean, current_status text, lease_expires_at timestamptz, queue_message jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.bess_dispatch_pending_forms%ROWTYPE;
  v_lease_expires_at timestamptz;
BEGIN
  SELECT * INTO v_row
  FROM public.bess_dispatch_pending_forms
  WHERE form_message_id = p_form_message_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_row.request_context ->> 'kind' IS DISTINCT FROM 'dispatch_ingest'
     OR v_row.request_context ->> 'operationId' IS DISTINCT FROM p_operation_id
     OR v_row.request_context ->> 'fingerprint' IS DISTINCT FROM p_fingerprint THEN
    RETURN QUERY SELECT false, 'CONFLICT'::text, NULL::timestamptz, NULL::jsonb;
    RETURN;
  END IF;

  IF NOT (
       v_row.request_context ->> 'status' = 'HANDOFF_PENDING'
       OR (
         v_row.request_context ->> 'status' = 'ACCEPTED_UNKNOWN'
         AND v_row.request_context ->> 'authoritativeNonAcceptance' = 'true'
       )
     )
     OR jsonb_typeof(v_row.request_context -> 'queueMessage') IS DISTINCT FROM 'object'
     OR v_row.request_context -> 'card' IS DISTINCT FROM p_card
     OR coalesce(public.bess_safe_timestamptz(v_row.request_context ->> 'publishLeaseExpiresAt'), '-infinity') > p_now THEN
    RETURN QUERY SELECT false, coalesce(v_row.request_context ->> 'status', 'UNKNOWN'),
      public.bess_safe_timestamptz(v_row.request_context ->> 'publishLeaseExpiresAt'),
      v_row.request_context -> 'queueMessage';
    RETURN;
  END IF;

  v_lease_expires_at := p_now + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 600)));
  UPDATE public.bess_dispatch_pending_forms f
  SET request_context = f.request_context || jsonb_build_object(
    'publishClaimedAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'publishLeaseExpiresAt', to_char(v_lease_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'publishWorkerToken', p_worker_token
  )
  WHERE f.form_message_id = p_form_message_id;

  RETURN QUERY SELECT true, v_row.request_context ->> 'status', v_lease_expires_at,
    v_row.request_context -> 'queueMessage';
END;
$$;

-- Mark an operation as ACCEPTED_UNKNOWN when queue publish times out (P0 Requirement 3)
DROP FUNCTION IF EXISTS public.bess_mark_dispatch_handoff_unknown(text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.bess_mark_dispatch_handoff_unknown(text, text, timestamptz, timestamptz);
CREATE OR REPLACE FUNCTION public.bess_mark_dispatch_handoff_unknown(
  p_form_message_id text,
  p_worker_token text,
  p_now timestamptz,
  p_next_reconcile_at timestamptz
)
RETURNS TABLE (updated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.bess_dispatch_pending_forms
  SET request_context = request_context || jsonb_build_object(
        'status', 'ACCEPTED_UNKNOWN',
        'lastReconcileAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'nextReconcileAt', to_char(p_next_reconcile_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
  WHERE form_message_id = p_form_message_id
    AND (
      (p_worker_token IS NOT NULL
        AND request_context ->> 'publishWorkerToken' = p_worker_token
        AND request_context ->> 'status' IN ('HANDOFF_PENDING', 'ACCEPTED_UNKNOWN'))
      OR (p_worker_token IS NULL
        AND request_context ->> 'status' = 'ACCEPTED_UNKNOWN'
        AND coalesce(request_context ->> 'authoritativeNonAcceptance', 'false') <> 'true')
    )
  RETURNING true;
END;
$$;

-- Confirm queue acceptance (P0 Requirement 5)
DROP FUNCTION IF EXISTS public.bess_confirm_dispatch_handoff(text, text, timestamptz);
DROP FUNCTION IF EXISTS public.bess_confirm_dispatch_handoff(text, text, text, timestamptz);
CREATE OR REPLACE FUNCTION public.bess_confirm_dispatch_handoff(
  p_form_message_id text,
  p_operation_id text,
  p_worker_token text,
  p_now timestamptz
)
RETURNS TABLE (updated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH changed AS (
    UPDATE public.bess_dispatch_pending_forms f
    SET request_context = f.request_context || jsonb_build_object(
          'status', 'QUEUED',
          'operationId', p_operation_id,
          'confirmedAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
    WHERE f.form_message_id = p_form_message_id
      AND f.request_context ->> 'kind' = 'dispatch_ingest'
      AND f.request_context ->> 'operationId' = p_operation_id
      AND f.request_context ->> 'publishWorkerToken' = p_worker_token
      AND f.request_context ->> 'status' IN ('HANDOFF_PENDING', 'ACCEPTED_UNKNOWN')
    RETURNING 1
  ), already_progressed AS (
    SELECT 1
    FROM public.bess_dispatch_pending_forms f
    WHERE f.form_message_id = p_form_message_id
      AND f.request_context ->> 'kind' = 'dispatch_ingest'
      AND f.request_context ->> 'operationId' = p_operation_id
      AND f.request_context ->> 'status' IN ('QUEUED', 'PROCESSING', 'SENT')
  )
  SELECT exists(SELECT 1 FROM changed UNION ALL SELECT 1 FROM already_progressed);
END;
$$;

-- Upgrade the already-installed outbox RPCs here rather than changing the
-- historical 20260915 migration. This atomically materializes a handoff intent
-- into a complete QUEUED outbox row while preserving operation identity.
CREATE OR REPLACE FUNCTION public.bess_enqueue_dispatch_outbox(
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
RETURNS TABLE(outcome text, status text, operation_id text, message_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row public.bess_dispatch_pending_forms%ROWTYPE;
  v_context jsonb;
BEGIN
  IF nullif(btrim(p_form_message_id), '') IS NULL
     OR nullif(btrim(p_chat_id), '') IS NULL
     OR nullif(btrim(p_batch_id), '') IS NULL
     OR nullif(btrim(p_fingerprint), '') IS NULL
     OR nullif(btrim(p_operation_id), '') IS NULL
     OR jsonb_typeof(p_request_ids) <> 'array'
     OR jsonb_typeof(p_card) <> 'object'
     OR p_expires_at <= p_now THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid dispatch outbox payload';
  END IF;

  v_context := jsonb_build_object(
    'kind', 'dispatch_ingest', 'batchId', p_batch_id,
    'fingerprint', p_fingerprint, 'requestIds', p_request_ids,
    'operationId', p_operation_id, 'card', p_card,
    'source', coalesce(p_source, ''), 'status', 'QUEUED',
    'attempt', 0, 'nextRetryAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'leaseExpiresAt', null, 'workerToken', null, 'messageId', '', 'errorCode', ''
  );

  INSERT INTO public.bess_dispatch_pending_forms(
    form_message_id, request_id, original_message_id, chat_id, request_context, expires_at
  ) VALUES (
    p_form_message_id, p_request_id, p_form_message_id, p_chat_id, v_context, p_expires_at
  ) ON CONFLICT (form_message_id) DO NOTHING;

  SELECT pending.* INTO v_row
    FROM public.bess_dispatch_pending_forms pending
   WHERE pending.form_message_id = p_form_message_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'outbox row missing after enqueue';
  END IF;

  IF (v_row.request_context ->> 'kind') IS DISTINCT FROM 'dispatch_ingest'
     OR (v_row.request_context ->> 'fingerprint') IS DISTINCT FROM p_fingerprint
     OR (v_row.request_context ->> 'batchId') IS DISTINCT FROM p_batch_id
     OR (v_row.request_context ->> 'operationId') IS DISTINCT FROM p_operation_id THEN
    RETURN QUERY SELECT 'CONFLICT'::text, coalesce(v_row.request_context ->> 'status', 'UNKNOWN'),
      coalesce(v_row.request_context ->> 'operationId', ''), ''::text;
    RETURN;
  END IF;

  IF v_row.request_context ->> 'status' = 'SENT' THEN
    RETURN QUERY SELECT 'COMPLETE'::text, 'SENT'::text,
      v_row.request_context ->> 'operationId', coalesce(v_row.request_context ->> 'messageId', '');
    RETURN;
  END IF;
  IF v_row.request_context ->> 'status' = 'DEAD' THEN
    RETURN QUERY SELECT 'ACCEPTED'::text, 'DEAD'::text,
      v_row.request_context ->> 'operationId', ''::text;
    RETURN;
  END IF;

  IF v_row.request_context ->> 'status' IN ('HANDOFF_PENDING', 'ACCEPTED_UNKNOWN')
     OR jsonb_typeof(v_row.request_context -> 'card') IS DISTINCT FROM 'object' THEN
    UPDATE public.bess_dispatch_pending_forms pending
       SET request_context = v_context,
           completed_at = null,
           expires_at = greatest(pending.expires_at, p_expires_at)
     WHERE pending.form_message_id = p_form_message_id;
    RETURN QUERY SELECT 'ACCEPTED'::text, 'QUEUED'::text, p_operation_id, ''::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ACCEPTED'::text,
    coalesce(v_row.request_context ->> 'status', 'QUEUED'),
    v_row.request_context ->> 'operationId',
    coalesce(v_row.request_context ->> 'messageId', '');
END;
$$;

-- Replace claim so malformed historical JSON timestamps cannot abort the batch.
CREATE OR REPLACE FUNCTION public.bess_claim_dispatch_outbox(
  p_worker_token text,
  p_limit integer DEFAULT 5,
  p_lease_seconds integer DEFAULT 45,
  p_max_attempts integer DEFAULT 8,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE(
  form_message_id text, chat_id text, batch_id text, operation_id text,
  request_ids jsonb, card jsonb, attempt integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF nullif(btrim(p_worker_token), '') IS NULL OR p_limit < 1 OR p_limit > 50
     OR p_lease_seconds < 5 OR p_lease_seconds > 300 OR p_max_attempts < 1 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid outbox worker claim';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT pending.form_message_id
      FROM public.bess_dispatch_pending_forms pending
     WHERE pending.request_context ->> 'kind' = 'dispatch_ingest'
       AND pending.expires_at > p_now
       AND coalesce((pending.request_context ->> 'attempt')::integer, 0) < p_max_attempts
       AND (
         ((pending.request_context ->> 'status') IN ('QUEUED', 'RETRY')
           AND coalesce(public.bess_safe_timestamptz(pending.request_context ->> 'nextRetryAt'), '-infinity') <= p_now)
         OR ((pending.request_context ->> 'status') = 'PROCESSING'
           AND coalesce(public.bess_safe_timestamptz(pending.request_context ->> 'leaseExpiresAt'), '-infinity') <= p_now)
       )
     ORDER BY coalesce(public.bess_safe_timestamptz(pending.request_context ->> 'nextRetryAt'), '-infinity'), pending.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  ), claimed AS (
    UPDATE public.bess_dispatch_pending_forms pending
       SET request_context = pending.request_context || jsonb_build_object(
         'status', 'PROCESSING',
         'workerToken', p_worker_token,
         'leaseExpiresAt', to_char((p_now + make_interval(secs => p_lease_seconds)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'attempt', coalesce((pending.request_context ->> 'attempt')::integer, 0) + 1,
         'startedAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       )
      FROM candidates
     WHERE pending.form_message_id = candidates.form_message_id
    RETURNING pending.*
  )
  SELECT claimed.form_message_id, claimed.chat_id,
    claimed.request_context ->> 'batchId', claimed.request_context ->> 'operationId',
    claimed.request_context -> 'requestIds', claimed.request_context -> 'card',
    (claimed.request_context ->> 'attempt')::integer
  FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.bess_nudge_dispatch_outbox(
  p_form_message_id text, p_now timestamptz DEFAULT now()
)
RETURNS TABLE(nudged boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN QUERY
  WITH changed AS (
    UPDATE public.bess_dispatch_pending_forms pending
       SET request_context = pending.request_context || jsonb_build_object(
         'status', 'RETRY', 'nextRetryAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'leaseExpiresAt', null, 'workerToken', null, 'errorCode', 'LEASE_EXPIRED'
       )
     WHERE pending.form_message_id = p_form_message_id
       AND pending.request_context ->> 'kind' = 'dispatch_ingest'
       AND pending.request_context ->> 'status' = 'PROCESSING'
       AND coalesce(public.bess_safe_timestamptz(pending.request_context ->> 'leaseExpiresAt'), '-infinity') <= p_now
    RETURNING 1
  ) SELECT exists(SELECT 1 FROM changed);
END;
$$;

-- Grant permissions
REVOKE ALL ON FUNCTION public.bess_safe_timestamptz(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bess_register_dispatch_handoff(text, text, text, text, text, jsonb, text, jsonb, jsonb, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_register_dispatch_handoff(text, text, text, text, text, jsonb, text, jsonb, jsonb, text, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.bess_claim_dispatch_handoff_publish(text, text, text, text, jsonb, timestamptz, int) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_claim_dispatch_handoff_publish(text, text, text, text, jsonb, timestamptz, int) TO service_role;
REVOKE ALL ON FUNCTION public.bess_mark_dispatch_handoff_unknown(text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_mark_dispatch_handoff_unknown(text, text, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.bess_confirm_dispatch_handoff(text, text, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_confirm_dispatch_handoff(text, text, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.bess_enqueue_dispatch_outbox(text, text, text, text, text, jsonb, text, jsonb, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_enqueue_dispatch_outbox(text, text, text, text, text, jsonb, text, jsonb, text, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.bess_claim_dispatch_outbox(text, integer, integer, integer, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_claim_dispatch_outbox(text, integer, integer, integer, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.bess_nudge_dispatch_outbox(text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_nudge_dispatch_outbox(text, timestamptz) TO service_role;

COMMIT;
