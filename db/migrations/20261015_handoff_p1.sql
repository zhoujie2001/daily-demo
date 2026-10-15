-- Handoff reconciliation and Base writeback retry support. Safe to re-run.
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

CREATE OR REPLACE FUNCTION public.bess_list_handoffs_to_reconcile(
  p_now timestamptz,
  p_limit int DEFAULT 20
)
RETURNS TABLE (form_message_id text, chat_id text, request_context jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT f.form_message_id, f.chat_id, f.request_context
  FROM public.bess_dispatch_pending_forms f
  WHERE f.request_context ->> 'kind' = 'dispatch_ingest'
    AND f.request_context ->> 'status' IN ('HANDOFF_PENDING', 'ACCEPTED_UNKNOWN')
    AND coalesce(public.bess_safe_timestamptz(f.request_context ->> 'nextReconcileAt'), '-infinity') <= p_now
    AND f.expires_at > p_now
    AND f.completed_at IS NULL
  ORDER BY coalesce(public.bess_safe_timestamptz(f.request_context ->> 'nextReconcileAt'), '-infinity'), f.created_at
  LIMIT greatest(1, least(p_limit, 100));
END;
$$;

-- A synchronous queue rejection is authoritative non-acceptance. Timeouts must
-- use bess_mark_dispatch_handoff_unknown instead and can never set this proof.
DROP FUNCTION IF EXISTS public.bess_mark_dispatch_handoff_rejected(text, text, text, text, jsonb, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.bess_mark_dispatch_handoff_rejected(text, text, text, text, jsonb, text, timestamptz, timestamptz);
CREATE OR REPLACE FUNCTION public.bess_mark_dispatch_handoff_rejected(
  p_form_message_id text,
  p_operation_id text,
  p_fingerprint text,
  p_error_code text,
  p_card jsonb,
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
  WITH changed AS (
    UPDATE public.bess_dispatch_pending_forms f
    SET request_context = f.request_context || jsonb_build_object(
      'status', 'ACCEPTED_UNKNOWN',
      'authoritativeNonAcceptance', true,
      'queueRejectionError', left(coalesce(p_error_code, 'QUEUE_REJECTED'), 100),
      'card', p_card,
      'lastReconcileAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'nextReconcileAt', to_char(p_next_reconcile_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
    WHERE f.form_message_id = p_form_message_id
      AND f.request_context ->> 'kind' = 'dispatch_ingest'
      AND f.request_context ->> 'operationId' = p_operation_id
      AND f.request_context ->> 'fingerprint' = p_fingerprint
      AND f.request_context ->> 'publishWorkerToken' = p_worker_token
      AND f.request_context ->> 'status' IN ('HANDOFF_PENDING', 'ACCEPTED_UNKNOWN')
    RETURNING 1
  ) SELECT exists(SELECT 1 FROM changed);
END;
$$;

-- Replace the previous four-argument version rather than leaving an overload;
-- a defaulted fifth argument would otherwise make four-argument RPC calls ambiguous.
DROP FUNCTION IF EXISTS public.bess_record_writeback_failure(text, text, text, timestamptz);

CREATE OR REPLACE FUNCTION public.bess_record_writeback_failure(
  p_form_message_id text,
  p_record_id text,
  p_error_code text,
  p_now timestamptz,
  p_next_retry_at timestamptz DEFAULT NULL
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
    SET request_context = jsonb_set(
      f.request_context,
      '{pendingWritebacks}',
      coalesce(f.request_context -> 'pendingWritebacks', '{}'::jsonb) ||
      jsonb_build_object(p_record_id, jsonb_build_object(
        'errorCode', left(coalesce(p_error_code, 'WRITEBACK_FAILED'), 100),
        'state', 'RETRY',
        'workerToken', null,
        'leaseExpiresAt', null,
        'attempt', case
          when coalesce(f.request_context #>> array['pendingWritebacks', p_record_id, 'attempt'], '') ~ '^[0-9]+$'
            then (f.request_context #>> array['pendingWritebacks', p_record_id, 'attempt'])::integer + 1
          else 1
        end,
        'failedAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'nextRetryAt', to_char(coalesce(p_next_retry_at, p_now + interval '5 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )), true
    )
    WHERE f.form_message_id = p_form_message_id
      AND f.request_context ->> 'kind' = 'dispatch_ingest'
    RETURNING 1
  ) SELECT exists(SELECT 1 FROM changed);
END;
$$;

CREATE OR REPLACE FUNCTION public.bess_claim_pending_writebacks(
  p_worker_token text,
  p_now timestamptz,
  p_lease_seconds int DEFAULT 60,
  p_limit int DEFAULT 100
)
RETURNS TABLE (
  form_message_id text,
  chat_id text,
  record_id text,
  operation_id text,
  attempt int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.bess_dispatch_pending_forms%ROWTYPE;
  v_entry record;
  v_context jsonb;
  v_claimed int := 0;
  v_attempt int;
BEGIN
  IF nullif(btrim(p_worker_token), '') IS NULL
     OR p_lease_seconds < 5 OR p_lease_seconds > 600
     OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION USING errcode = '22023', message = 'invalid writeback claim';
  END IF;

  FOR v_row IN
    SELECT f.*
    FROM public.bess_dispatch_pending_forms f
    WHERE f.request_context ->> 'kind' = 'dispatch_ingest'
      AND jsonb_typeof(f.request_context -> 'pendingWritebacks') = 'object'
      AND EXISTS (
        SELECT 1
        FROM jsonb_each(f.request_context -> 'pendingWritebacks') e
        WHERE (
          coalesce(e.value ->> 'state', 'PENDING') IN ('PENDING', 'RETRY')
          AND coalesce(public.bess_safe_timestamptz(e.value ->> 'nextRetryAt'), '-infinity') <= p_now
        ) OR (
          e.value ->> 'state' = 'PROCESSING'
          AND coalesce(public.bess_safe_timestamptz(e.value ->> 'leaseExpiresAt'), '-infinity') <= p_now
        )
      )
    ORDER BY f.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    v_context := v_row.request_context;
    FOR v_entry IN SELECT e.key, e.value FROM jsonb_each(v_context -> 'pendingWritebacks') e
    LOOP
      EXIT WHEN v_claimed >= p_limit;
      IF NOT ((
        coalesce(v_entry.value ->> 'state', 'PENDING') IN ('PENDING', 'RETRY')
        AND coalesce(public.bess_safe_timestamptz(v_entry.value ->> 'nextRetryAt'), '-infinity') <= p_now
      ) OR (
        v_entry.value ->> 'state' = 'PROCESSING'
        AND coalesce(public.bess_safe_timestamptz(v_entry.value ->> 'leaseExpiresAt'), '-infinity') <= p_now
      )) THEN
        CONTINUE;
      END IF;

      v_attempt := CASE
        WHEN coalesce(v_entry.value ->> 'attempt', '') ~ '^[0-9]+$'
          THEN (v_entry.value ->> 'attempt')::int
        ELSE 0
      END;
      v_context := jsonb_set(
        v_context,
        ARRAY['pendingWritebacks', v_entry.key],
        v_entry.value || jsonb_build_object(
          'state', 'PROCESSING',
          'workerToken', p_worker_token,
          'leaseExpiresAt', to_char((p_now + make_interval(secs => p_lease_seconds)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        false
      );
      UPDATE public.bess_dispatch_pending_forms f
      SET request_context = v_context
      WHERE f.form_message_id = v_row.form_message_id;

      form_message_id := v_row.form_message_id;
      chat_id := v_row.chat_id;
      record_id := v_entry.key;
      operation_id := coalesce(v_context ->> 'operationId', '');
      attempt := v_attempt;
      v_claimed := v_claimed + 1;
      RETURN NEXT;
    END LOOP;
    EXIT WHEN v_claimed >= p_limit;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.bess_fail_claimed_writeback(
  p_form_message_id text,
  p_record_id text,
  p_worker_token text,
  p_error_code text,
  p_now timestamptz,
  p_next_retry_at timestamptz
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
    SET request_context = jsonb_set(
      f.request_context,
      ARRAY['pendingWritebacks', p_record_id],
      (f.request_context #> ARRAY['pendingWritebacks', p_record_id]) || jsonb_build_object(
        'state', 'RETRY',
        'workerToken', null,
        'leaseExpiresAt', null,
        'errorCode', left(coalesce(p_error_code, 'WRITEBACK_FAILED'), 100),
        'attempt', CASE
          WHEN coalesce(f.request_context #>> ARRAY['pendingWritebacks', p_record_id, 'attempt'], '') ~ '^[0-9]+$'
            THEN (f.request_context #>> ARRAY['pendingWritebacks', p_record_id, 'attempt'])::int + 1
          ELSE 1
        END,
        'failedAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'nextRetryAt', to_char(p_next_retry_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      false
    )
    WHERE f.form_message_id = p_form_message_id
      AND f.request_context #>> ARRAY['pendingWritebacks', p_record_id, 'state'] = 'PROCESSING'
      AND f.request_context #>> ARRAY['pendingWritebacks', p_record_id, 'workerToken'] = p_worker_token
    RETURNING 1
  ) SELECT exists(SELECT 1 FROM changed);
END;
$$;

DROP FUNCTION IF EXISTS public.bess_complete_writeback(text, text);

CREATE OR REPLACE FUNCTION public.bess_complete_writeback(
  p_form_message_id text,
  p_record_id text,
  p_worker_token text
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
    SET request_context = jsonb_set(
      f.request_context, '{pendingWritebacks}',
      coalesce(f.request_context -> 'pendingWritebacks', '{}'::jsonb) - p_record_id, true
    )
    WHERE f.form_message_id = p_form_message_id
      AND f.request_context #>> ARRAY['pendingWritebacks', p_record_id, 'state'] = 'PROCESSING'
      AND f.request_context #>> ARRAY['pendingWritebacks', p_record_id, 'workerToken'] = p_worker_token
    RETURNING 1
  ) SELECT exists(SELECT 1 FROM changed);
END;
$$;

REVOKE ALL ON FUNCTION public.bess_list_handoffs_to_reconcile(timestamptz, int) FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_list_handoffs_to_reconcile(timestamptz, int) TO service_role;
REVOKE ALL ON FUNCTION public.bess_mark_dispatch_handoff_rejected(text, text, text, text, jsonb, text, timestamptz, timestamptz) FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_mark_dispatch_handoff_rejected(text, text, text, text, jsonb, text, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.bess_record_writeback_failure(text, text, text, timestamptz, timestamptz) FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_record_writeback_failure(text, text, text, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.bess_claim_pending_writebacks(text, timestamptz, int, int) FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_claim_pending_writebacks(text, timestamptz, int, int) TO service_role;
REVOKE ALL ON FUNCTION public.bess_fail_claimed_writeback(text, text, text, text, timestamptz, timestamptz) FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_fail_claimed_writeback(text, text, text, text, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.bess_complete_writeback(text, text, text) FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bess_complete_writeback(text, text, text) TO service_role;

COMMIT;
