-- Migration: P1 Handoff Reconciler and Base Pull Support
BEGIN;

-- List handoffs that need reconciliation (HANDOFF_PENDING or ACCEPTED_UNKNOWN)
CREATE OR REPLACE FUNCTION public.bess_list_handoffs_to_reconcile(
  p_now timestamptz,
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  form_message_id text,
  chat_id text,
  request_context jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT f.form_message_id, f.chat_id, f.request_context
  FROM public.bess_dispatch_pending_forms f
  WHERE (f.request_context ->> 'status' = 'HANDOFF_PENDING' 
         OR (f.request_context ->> 'status' = 'ACCEPTED_UNKNOWN' 
             AND (f.request_context ->> 'nextReconcileAt')::timestamptz <= p_now))
    AND f.expires_at > p_now
    AND f.completed_at IS NULL
  ORDER BY (f.request_context ->> 'nextReconcileAt') ASC NULLS FIRST, f.created_at ASC
  LIMIT p_limit;
END;
$$;

-- Record a writeback failure for a specific record in a batch
CREATE OR REPLACE FUNCTION public.bess_record_writeback_failure(
  p_form_message_id text,
  p_record_id text,
  p_error_code text,
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
  SET request_context = jsonb_set(
        request_context,
        '{pendingWritebacks}',
        coalesce(request_context -> 'pendingWritebacks', '{}'::jsonb) || 
        jsonb_build_object(p_record_id, jsonb_build_object(
          'errorCode', p_error_code,
          'failedAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ))
      )
  WHERE form_message_id = p_form_message_id
  RETURNING true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bess_list_handoffs_to_reconcile(timestamptz, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.bess_record_writeback_failure(text, text, text, timestamptz) TO service_role;

COMMIT;
