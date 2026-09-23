/**
 * Gate 1: automation-send — Lark Base Automation → dispatch queue bridge.
 *
 * Accepts body-token authenticated requests from Lark Automation workflows
 * and feeds them into the same queue pipeline as the HMAC-based `/send`.
 *
 * Request body:
 *   {
 *     "automation_token": "<secret>",
 *     "dispatch_payload": <string|object>,   // same shape as /send body
 *     "source_record_id": "rec...",           // optional, for tracing
 *     "dry_run": false                        // optional, validate without queueing
 *   }
 *
 * The endpoint reuses normalizeBatchDispatchIngest, buildBatchDispatchCard,
 * publishDispatchQueueMessage, etc. — identical business logic, different auth.
 */
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { LarkClient } from '../../lark/client.js';
import { buildBatchDispatchCard, buildInitialDispatchCard } from '../../lark/card-renderer.js';
import { enrichLocalPromoRejectReasons } from '../reject-reason-enrichment.js';
import { dispatchOperationId } from '../operation.js';
import { DISPATCH_QUEUE_SCHEMA_VERSION, publishDispatchQueueMessage } from '../queue.js';
import { createDispatchStatusCache, queuedDispatchStatus, writeDispatchStatusCache } from '../status-cache.js';
import {
  DispatchIngestError,
  batchDispatchActionValue,
  dispatchActionValue,
  normalizeBatchDispatchIngest,
  normalizeDispatchIngest,
  shouldSkipLocalPromoDispatch,
  LOCAL_PROMO_CHAT_ID,
} from '../ingest.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function safeEqualText(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/**
 * SHA-256 hash of the automation token for hash-based fallback auth.
 * When GATE0_AUTOMATION_DISPATCH_SECRET env var is not set, the endpoint
 * compares SHA-256(incoming_token) against this committed hash instead.
 * The raw token is never stored in the codebase.
 */
const AUTOMATION_TOKEN_SHA256 = '92732e685e1c9de868d7b7be1bfe0fd3493790321f736a2941e3ce0a29b8b725';

function verifyAutomationToken(token, envSecret) {
  if (envSecret) {
    return safeEqualText(token, envSecret);
  }
  // Fallback: hash comparison when env var is not configured
  const incoming = createHash('sha256').update(String(token || '')).digest('hex');
  return incoming.length === AUTOMATION_TOKEN_SHA256.length
    && incoming.length > 0
    && timingSafeEqual(Buffer.from(incoming), Buffer.from(AUTOMATION_TOKEN_SHA256));
}

const MAX_BODY_BYTES = 64 * 1024; // 64 KiB — generous for up-to-30-item batches

function jsonSize(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return Infinity; }
}

function log(level, stage, fields = {}) {
  console[level](JSON.stringify({ module: 'bess-automation-send', stage, ...fields }));
}

/* ------------------------------------------------------------------ */
/*  Reject-reason enrichment (bounded, identical to send.js)          */
/* ------------------------------------------------------------------ */

async function enrichRejectReasonsWithinDeadline({
  chatId, items, client, enrichRejectReasons, timeoutMs, source,
}) {
  if (!Array.isArray(items) || items.length === 0 || timeoutMs <= 0) return [];
  const lookupItems = structuredClone(items);
  let timer;
  const lookup = Promise.resolve()
    .then(() => enrichRejectReasons({ chatId, items: lookupItems, client, log }))
    .then((requestIds) => ({ requestIds, lookupItems }));
  try {
    const { requestIds, lookupItems: enriched } = await Promise.race([
      lookup,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Enrichment timeout')), timeoutMs);
      }),
    ]);
    if (requestIds.length) {
      for (let i = 0; i < items.length; i++) {
        if (requestIds.includes(String(items[i]?.request_id || ''))) {
          items[i] = enriched[i];
        }
      }
    }
    return requestIds;
  } catch (error) {
    log('error', 'enrichment_failed', {
      source, chat_id: chatId, timeout_ms: timeoutMs,
      error_code: error?.code || 'REJECT_REASON_LOOKUP_TIMEOUT',
    });
    throw Object.assign(error instanceof Error ? error : new Error('Reject reason enrichment failed'), {
      code: error?.code || 'REJECT_REASON_LOOKUP_TIMEOUT', status: error?.status || 503,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  Handler factory                                                    */
/* ------------------------------------------------------------------ */

export function createAutomationLarkClient() {
  return new LarkClient({
    appId: () => process.env.LARK_APP_ID,
    appSecret: () => process.env.LARK_APP_SECRET,
    baseUrl: () => process.env.LARK_API_BASE_URL || 'https://open.feishu.cn',
  });
}

const defaultClient = createAutomationLarkClient();

export function createAutomationSendHandler({
  secret = process.env.GATE0_AUTOMATION_DISPATCH_SECRET
        || process.env.GATE0_AUTOMATION_PROBE_SECRET,
  client = defaultClient,
  enrichRejectReasons = enrichLocalPromoRejectReasons,
  enrichmentTimeoutMs = 2_500,
  publishDispatch = publishDispatchQueueMessage,
  publishTimeoutMs = 5_000,
  defer = waitUntil,
  statusCache = createDispatchStatusCache(),
  now = () => new Date(),
} = {}) {
  return async function automationSendHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req?.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ ok: false, error_code: 'METHOD_NOT_ALLOWED' });
    }

    /* ---------- parse body ---------- */
    let body = req?.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {
        return res.status(400).json({ ok: false, error_code: 'INVALID_JSON' });
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || jsonSize(body) > MAX_BODY_BYTES) {
      return res.status(400).json({ ok: false, error_code: 'INVALID_BODY' });
    }

    /* ---------- auth ---------- */
    const token = body.automation_token;
    if (!verifyAutomationToken(token, secret)) {
      return res.status(401).json({ ok: false, error_code: 'INVALID_AUTOMATION_TOKEN' });
    }

    /* ---------- extract dispatch payload ---------- */
    const sourceRecordId = String(body.source_record_id || '').slice(0, 128);
    const dryRun = body.dry_run === true;
    let payload;
    if (typeof body.dispatch_payload === 'string') {
      let decoded = body.dispatch_payload;
      // Try Base64 decode first (monitor script encodes to avoid JSON-in-JSON)
      if (/^[A-Za-z0-9+/=]+$/.test(decoded) && decoded.length > 20) {
        try {
          decoded = Buffer.from(decoded, 'base64').toString('utf8');
        } catch { /* not base64, use raw */ }
      }
      try { payload = JSON.parse(decoded); } catch {
        return res.status(400).json({ ok: false, error_code: 'INVALID_DISPATCH_PAYLOAD' });
      }
    } else if (body.dispatch_payload && typeof body.dispatch_payload === 'object') {
      payload = body.dispatch_payload;
    } else {
      return res.status(400).json({ ok: false, error_code: 'MISSING_DISPATCH_PAYLOAD' });
    }

    /* ---------- core pipeline (mirrors send.js 174-342) ---------- */
    const source = `automation:${sourceRecordId || 'unknown'}`;
    try {
      const isBatch = Array.isArray(payload?.items);
      const idempotencyFields = isBatch
        ? normalizeBatchDispatchIngest(payload).fieldsList
        : [normalizeDispatchIngest(payload).fields];

      let dispatchBody = payload;
      let skippedItems = [];
      let allSkipped = false;

      /* reject-reason enrichment (local promo) */
      const enrichmentItems = isBatch ? payload.items : [payload];
      const enrichedRequestIds = await enrichRejectReasonsWithinDeadline({
        chatId: payload?.chat_id,
        items: enrichmentItems,
        client,
        enrichRejectReasons,
        timeoutMs: enrichmentTimeoutMs,
        source,
      });
      if (enrichedRequestIds.length) {
        log('info', 'enriched', { source, request_ids: enrichedRequestIds });
      }

      /* local promo skip filtering */
      if (isBatch) {
        const before = dispatchBody.items.length;
        dispatchBody = { ...dispatchBody, items: dispatchBody.items.filter((item) => !shouldSkipLocalPromoDispatch(dispatchBody.chat_id, item)) };
        skippedItems = payload.items.filter((item) => shouldSkipLocalPromoDispatch(payload.chat_id, item));
        if (dispatchBody.items.length < before) {
          log('info', 'local_promo_skipped', { source, skipped: before - dispatchBody.items.length });
        }
        allSkipped = dispatchBody.items.length === 0;
      } else if (shouldSkipLocalPromoDispatch(payload?.chat_id, payload)) {
        skippedItems = [payload];
        allSkipped = true;
      }

      /* normalize + build card */
      let chatId, fieldsList, batchId, card;
      if (isBatch) {
        const normalized = normalizeBatchDispatchIngest(allSkipped ? payload : dispatchBody);
        ({ chatId, batchId } = normalized);
        fieldsList = allSkipped ? [] : normalized.fieldsList;
        if (!allSkipped) {
          card = buildBatchDispatchCard(fieldsList, batchDispatchActionValue(batchId, fieldsList), {
            cardTitle: normalized.cardTitle, batchId, period: normalized.period,
          });
        }
      } else {
        const normalized = normalizeDispatchIngest(dispatchBody);
        chatId = normalized.chatId;
        fieldsList = allSkipped ? [] : [normalized.fields];
        batchId = `single:${normalized.fields.requestId}`;
        if (!allSkipped) card = buildInitialDispatchCard(normalized.fields, dispatchActionValue(normalized.fields));
      }

      const fingerprint = createHash('sha256').update(JSON.stringify(idempotencyFields)).digest('hex');
      const requestIds = (allSkipped ? idempotencyFields : fieldsList).map((item) => item.requestId);
      const operation = dispatchOperationId(chatId, batchId);
      const expiresAt = new Date(now().getTime() + 7 * 24 * 3600_000).toISOString();

      const queueMessage = {
        schema_version: DISPATCH_QUEUE_SCHEMA_VERSION,
        kind: allSkipped ? 'skip' : 'dispatch',
        chat_id: chatId,
        batch_id: batchId,
        fingerprint,
        request_ids: requestIds,
        operation_id: operation,
        card: allSkipped ? null : card,
        source,
        expires_at: expiresAt,
      };

      /* --- DRY RUN: validate only, do not queue --- */
      if (dryRun) {
        log('info', 'dry_run', { source, batch_id: batchId, operation_id: operation, request_count: requestIds.length });
        return res.status(200).json({
          ok: true, status: 'DRY_RUN_OK',
          batch_id: batchId,
          operation_id: operation,
          request_ids: requestIds,
          skipped_request_ids: skippedItems.map((i) => String(i?.request_id || '')),
          items_accepted: fieldsList.length,
          all_skipped: allSkipped,
          source_record_id: sourceRecordId,
        });
      }

      /* --- PUBLISH --- */
      let published;
      const publishStart = Date.now();
      try {
        published = await Promise.race([
          publishDispatch(queueMessage),
          new Promise((_, reject) => {
            setTimeout(() => reject(Object.assign(new Error('Queue publish timed out'), {
              code: 'DISPATCH_QUEUE_TIMEOUT', status: 503,
            })), publishTimeoutMs);
          }),
        ]);
      } catch (error) {
        if (error?.code === 'DISPATCH_QUEUE_TIMEOUT') {
          const latePublish = publishDispatch(queueMessage).catch(() => {});
          try { defer(latePublish); } catch { /* swallow */ }
          log('warn', 'queue_timeout', { source, batch_id: batchId, duration_ms: Date.now() - publishStart });
          return res.status(503).json({
            ok: false, accepted_unknown: true, status: 'QUEUING',
            error_code: 'DISPATCH_QUEUE_TIMEOUT',
            batch_id: batchId, operation_id: operation,
          });
        }
        throw error;
      }

      log('info', 'queue_accepted', {
        source, batch_id: batchId, chat_id: chatId, operation_id: operation,
        request_count: requestIds.length,
        queue_message_id: published?.message_id || '',
        deduplicated: Boolean(published?.deduplicated),
        duration_ms: Date.now() - publishStart,
      });

      if (!published?.deduplicated) {
        await writeDispatchStatusCache(statusCache, {
          chatId, batchId,
          value: queuedDispatchStatus({ operationId: operation, requestIds }),
        }).catch(() => {});
      }

      return res.status(202).json({
        ok: true, accepted: true, status: 'QUEUED',
        batch_id: batchId,
        operation_id: operation,
        request_ids: requestIds,
        skipped_request_ids: skippedItems.map((i) => String(i?.request_id || '')),
        items_accepted: fieldsList.length,
        source_record_id: sourceRecordId,
        ...(published?.deduplicated ? { reused: true } : {}),
      });
    } catch (error) {
      const status = error instanceof DispatchIngestError ? error.status : error?.status || 502;
      const code = error instanceof DispatchIngestError ? error.code
        : error?.code || 'AUTOMATION_SEND_FAILED';
      log('error', 'failed', { source, error_code: code, message: error?.message });
      return res.status(status).json({ ok: false, error_code: code, source_record_id: sourceRecordId });
    }
  };
}
