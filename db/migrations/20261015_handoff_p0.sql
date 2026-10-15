-- Migration: P0 Handoff Tracking and Idempotency Hardening
BEGIN;

-- Register the intention to dispatch before calling the queue.
-- Provides early conflict detection (409) and tracks ambiguous states.
CREATE OR REPLACE FUNCTION public.bess_register_dispatch_handoff(
  p_form_message_id text,
  p_request_id text,
  p_chat_id text,
  p_batch_id text,
  p_fingerprint text,
  p_request_ids jsonb,
  p_operation_id text,
  p_source text,
  p_expires_at timestamptz,
  p_now timestamptz
)
RETURNS TABLE (
  outcome text,
  current_status text,
  operation_id text,
  registered_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.bess_dispatch_pending_forms%ROWTYPE;
  v_context jsonb;
BEGIN
  -- Basic validation
  IF p_form_message_id IS NULL OR p_fingerprint IS NULL THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'Missing required handoff fields';
  END IF;

  -- Attempt initial registration
  v_context := jsonb_build_object(
    'kind', 'dispatch_ingest',
    'status', 'HANDOFF_PENDING',
    'batchId', p_batch_id,
    'fingerprint', p_fingerprint,
    'requestIds', p_request_ids,
    'operationId', p_operation_id,
    'source', coalesce(p_source, ''),
    'registeredAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  INSERT INTO public.bess_dispatch_pending_forms (
    form_message_id, request_id, original_message_id, chat_id, request_context, expires_at
  ) VALUES (
    p_form_message_id, p_request_id, p_form_message_id, p_chat_id, v_context, p_expires_at
  )
  ON CONFLICT (form_message_id) DO NOTHING;

  -- Lock and read existing state
  SELECT * INTO v_row
  FROM public.bess_dispatch_pending_forms
  WHERE form_message_id = p_form_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING errcode = 'P0002', message = 'Handoff row missing after insert attempt';
  END IF;

  -- 1. Payload Conflict Check (P0 Requirement 2)
  IF (v_row.request_context ->> 'fingerprint') IS DISTINCT FROM p_fingerprint THEN
    RETURN QUERY SELECT 
      'PAYLOAD_CONFLICT'::text, 
      coalesce(v_row.request_context ->> 'status', 'UNKNOWN'),
      coalesce(v_row.request_context ->> 'operationId', ''),
      coalesce((v_row.request_context ->> 'registeredAt')::timestamptz, v_row.created_at);
    RETURN;
  END IF;

  -- 2. New Registration Success
  IF v_row.request_context ->> 'status' = 'HANDOFF_PENDING' 
     AND (v_row.request_context ->> 'registeredAt')::timestamptz = p_now THEN
    RETURN QUERY SELECT 
      'ACCEPTED'::text, 
      'HANDOFF_PENDING'::text, 
      p_operation_id,
      p_now;
    RETURN;
  END IF;

  -- 3. Existing State Reuse (QUEUED, SENT, etc.)
  RETURN QUERY SELECT 
    'REUSED'::text, 
    coalesce(v_row.request_context ->> 'status', 'UNKNOWN'),
    coalesce(v_row.request_context ->> 'operationId', p_operation_id),
    coalesce((v_row.request_context ->> 'registeredAt')::timestamptz, v_row.created_at);
END;
$$;

-- Mark an operation as ACCEPTED_UNKNOWN when queue publish times out (P0 Requirement 3)
CREATE OR REPLACE FUNCTION public.bess_mark_dispatch_handoff_unknown(
  p_form_message_id text,
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
    AND (request_context ->> 'status' = 'HANDOFF_PENDING' OR request_context ->> 'status' = 'ACCEPTED_UNKNOWN')
  RETURNING true;
END;
$$;

-- Confirm queue acceptance (P0 Requirement 5)
CREATE OR REPLACE FUNCTION public.bess_confirm_dispatch_handoff(
  p_form_message_id text,
  p_operation_id text,
  p_now timestamptz
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
        'status', 'QUEUED',
        'operationId', p_operation_id,
        'confirmedAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
  WHERE form_message_id = p_form_message_id
    AND (request_context ->> 'status' IN ('HANDOFF_PENDING', 'ACCEPTED_UNKNOWN', 'QUEUED'))
  RETURNING true;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION public.bess_register_dispatch_handoff(text, text, text, text, text, jsonb, text, text, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.bess_mark_dispatch_handoff_unknown(text, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.bess_confirm_dispatch_handoff(text, text, timestamptz) TO service_role;

COMMIT;
