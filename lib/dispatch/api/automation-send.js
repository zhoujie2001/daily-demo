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
import { registerQianchuanSource } from '../qianchuan-policy.js';
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { LarkClient } from '../../lark/client.js';
import { buildBatchDispatchCard, buildInitialDispatchCard } from '../../lark/card-renderer.js';
import { buildDispatchCardChunkPlans, dispatchChunkSummary, dispatchRootReservation } from '../card-chunks.js';
import { dispatchOperationId } from '../operation.js';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import { DISPATCH_QUEUE_SCHEMA_VERSION, publishDispatchQueueMessage } from '../queue.js';
import { decodeDispatchPayload } from '../payload.js';
import { runDurableDispatchHandoff } from '../durable-handoff.js';
import {
  createDispatchStatusCache,
  queuedDispatchStatus,
  readDispatchStatusCache,
  writeDispatchStatusCache,
} from '../status-cache.js';
import {
  DispatchIngestError,
  batchDispatchActionValue,
  dispatchBatchSizeRejection,
  dispatchActionValue,
  dispatchIdempotencyValue,
  normalizeBatchDispatchIngest,
  normalizeDispatchIngest,
} from '../ingest.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function safeEqualText(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function verifyAutomationToken(token, envSecret) {
  // Authentication is deliberately fail-closed. Production must provide one of
  // the explicit environment secrets resolved by createAutomationSendHandler.
  return Boolean(envSecret) && safeEqualText(token, envSecret);
}

const MAX_BODY_BYTES = 64 * 1024; // Independent byte budget; item/card limits are shared.

function jsonSize(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return Infinity; }
}

function log(level, stage, fields = {}) {
  console[level](JSON.stringify({ module: 'bess-automation-send', stage, ...fields }));
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

export function createAutomationSendHandler({
  secret = process.env.GATE0_AUTOMATION_DISPATCH_SECRET
        || process.env.GATE0_AUTOMATION_PROBE_SECRET,
  publishDispatch = publishDispatchQueueMessage,
  publishTimeoutMs = 5_000,
  defer = waitUntil,
  statusCache = createDispatchStatusCache(),
  storeFactory = () => createSupabaseDispatchStore(),
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
    try {
      payload = decodeDispatchPayload(body.dispatch_payload);
    } catch (error) {
      return res.status(error?.status || 400).json({
        ok: false,
        error_code: error?.code || 'INVALID_DISPATCH_PAYLOAD',
      });
    }

    /* ---------- core pipeline (mirrors send.js 174-342) ---------- */
    const source = `automation:${sourceRecordId || 'unknown'}`;
    try {
      const isBatch = Array.isArray(payload?.items);
      const idempotencyFields = isBatch
        ? normalizeBatchDispatchIngest(payload, { splitCards: true }).fieldsList
        : [normalizeDispatchIngest(payload).fields];

      const dispatchBody = payload;
      const skippedItems = [];
      const allSkipped = false;

      /* normalize + build card */
      let chatId, fieldsList, batchId, card, batchNormalized;
      if (isBatch) {
        const normalized = normalizeBatchDispatchIngest(allSkipped ? payload : dispatchBody, { splitCards: true });
        batchNormalized = normalized;
        ({ chatId, batchId } = normalized);
        fieldsList = allSkipped ? [] : normalized.fieldsList;
        if (!allSkipped && fieldsList.length <= 20) {
          card = buildBatchDispatchCard(fieldsList, batchDispatchActionValue(batchId, fieldsList), {
            cardTitle: normalized.cardTitle, batchId, period: normalized.period,
            cardLayout: normalized.cardLayout,
          });
        }
      } else {
        const normalized = normalizeDispatchIngest(dispatchBody);
        if (normalized.fields.sourceBatchId) throw new DispatchIngestError('QIANCHUAN_BATCH_ACTION_REQUIRED', '千川 v2 必须通过批次入口提交');
        chatId = normalized.chatId;
        fieldsList = allSkipped ? [] : [normalized.fields];
        batchId = `single:${normalized.fields.requestId}`;
        if (!allSkipped) card = buildInitialDispatchCard(normalized.fields, dispatchActionValue(normalized.fields));
      }

      const fingerprint = createHash('sha256')
        .update(JSON.stringify(idempotencyFields.map(dispatchIdempotencyValue)))
        .digest('hex');
      const requestIds = (allSkipped ? idempotencyFields : fieldsList).map((item) => item.requestId);
      const operation = dispatchOperationId(chatId, batchId);
      const expiresAt = new Date(now().getTime() + 7 * 24 * 3600_000).toISOString();
      const chunkPlans = isBatch && !allSkipped
        ? buildDispatchCardChunkPlans(batchNormalized, { source, sourceRecordId, expiresAt })
        : [];

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
        ...(sourceRecordId ? { source_record_id: sourceRecordId } : {}),
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
          chunks: chunkPlans.map(dispatchChunkSummary),
          source_record_id: sourceRecordId,
        });
      }

      const store = storeFactory();
      await registerQianchuanSource(store, batchNormalized, now());
      if (chunkPlans.length > 0) {
        if (typeof store.reserveDispatchIngestRoot !== 'function') {
          throw Object.assign(new Error('原始派单批次幂等预留尚未配置'), {
            code: 'DISPATCH_ROOT_RESERVATION_UNAVAILABLE', status: 503,
          });
        }
        const root = dispatchRootReservation(batchNormalized, chunkPlans);
        const rootReservation = await store.reserveDispatchIngestRoot({
          ...root, expiresAt, now: now(),
        });
        if (rootReservation.outcome === 'PAYLOAD_CONFLICT') {
          log('warn', 'root_payload_conflict', { source, batch_id: batchId, request_count: requestIds.length });
          return res.status(409).json({
            ok: false, error_code: 'PAYLOAD_CONFLICT',
            message: '同批次号已绑定不同的需求内容或拆卡规划',
            batch_id: batchId, source_record_id: sourceRecordId,
          });
        }
      }

      if (chunkPlans.length > 1) {
        const acceptances = await Promise.all(chunkPlans.map((plan) => runDurableDispatchHandoff({
          store,
          registration: {
            chatId, batchId: plan.batchId, fingerprint: plan.fingerprint,
            requestIds: plan.requestIds, operationId: plan.operationId,
            card: plan.card, queueMessage: plan.queueMessage, source, sourceRecordId,
            expiresAt, now: now(),
          },
          publishDispatch, publishTimeoutMs, defer, now,
        })));
        const conflict = acceptances.findIndex((item) => item.kind === 'CONFLICT');
        if (conflict >= 0) {
          return res.status(409).json({
            ok: false, error_code: 'PAYLOAD_CONFLICT', message: '同批次号已存在不同的请求内容',
            batch_id: batchId, chunk_batch_id: chunkPlans[conflict].batchId,
            chunks: chunkPlans.map(dispatchChunkSummary), source_record_id: sourceRecordId,
          });
        }
        const chunks = chunkPlans.map((plan, index) => ({
          ...dispatchChunkSummary(plan),
          durable_status: acceptances[index].handoff.status,
          reused: acceptances[index].kind === 'REUSED',
        }));
        // Registration lacks message receipts and may race the delivery worker.
        // Do not overwrite authoritative split-card status caches on replay.
        const dead = acceptances.findIndex((item) => item.kind === 'DEAD');
        if (dead >= 0) {
          return res.status(200).json({
            ok: false, accepted: false, status: 'FAILED', dead_letter: true,
            error_code: acceptances[dead].handoff.error_code || 'OUTBOX_DELIVERY_FAILED',
            batch_id: batchId, request_ids: requestIds, chunks, source_record_id: sourceRecordId,
          });
        }
        const unknown = acceptances.findIndex((item) => item.kind === 'UNKNOWN');
        if (unknown >= 0) {
          const timedOut = acceptances[unknown].error?.code === 'DISPATCH_QUEUE_TIMEOUT';
          return res.status(timedOut ? 503 : 202).json({
            ok: !timedOut, accepted: !timedOut, accepted_unknown: true, status: 'QUEUING',
            durable_status: 'ACCEPTED_UNKNOWN', recovery: 'NEEDS_RECONCILIATION',
            error_code: acceptances[unknown].error?.code || 'HANDOFF_CONFIRM_FAILED',
            batch_id: batchId, request_ids: requestIds, chunks, source_record_id: sourceRecordId,
          });
        }
        const allSent = acceptances.every((item) => item.handoff.status === 'SENT');
        return res.status(allSent ? 200 : 202).json({
          ok: true, accepted: true, status: allSent ? 'SENT' : 'QUEUED',
          durable_status: allSent ? 'SENT' : 'QUEUED', recovery: 'CONFIRMED',
          batch_id: batchId, request_ids: requestIds, items_accepted: fieldsList.length,
          operation_ids: chunks.map((chunk) => chunk.operation_id), chunks,
          source_record_id: sourceRecordId,
          ...(chunks.every((chunk) => chunk.reused) ? { reused: true } : {}),
        });
      }

      const publishStart = Date.now();
      const acceptance = await runDurableDispatchHandoff({
        store,
        registration: {
          chatId, batchId, fingerprint, requestIds, operationId: operation,
          card, queueMessage, source, sourceRecordId, expiresAt, now: now(),
        },
        publishDispatch,
        publishTimeoutMs,
        defer,
        now,
      });
      const { handoff } = acceptance;

      if (acceptance.kind === 'CONFLICT') {
        log('warn', 'payload_conflict', { source, batch_id: batchId, operation_id: operation });
        return res.status(409).json({
          ok: false, error_code: 'PAYLOAD_CONFLICT',
          message: '同批次号已存在不同的请求内容',
          batch_id: batchId, operation_id: handoff.operation_id,
        });
      }

      if (acceptance.kind === 'DEAD') {
        return res.status(200).json({
          ok: false, accepted: false, status: 'FAILED', dead_letter: true,
          error_code: 'OUTBOX_DELIVERY_FAILED',
          batch_id: batchId, operation_id: handoff.operation_id,
          request_ids: requestIds, source_record_id: sourceRecordId, reused: true,
        });
      }

      if (acceptance.kind === 'REUSED') {
        log('info', 'handoff_reused', { source, batch_id: batchId, status: handoff.status });
        const cachedStatus = await readDispatchStatusCache(statusCache, { chatId, batchId });
        if (!cachedStatus) {
          await writeDispatchStatusCache(statusCache, {
            chatId, batchId,
            value: { found: true, status: handoff.status, operation_id: handoff.operation_id, request_ids: requestIds },
          });
        }
        const isSent = handoff.status === 'SENT';
        const acceptedUnknown = ['HANDOFF_PENDING', 'ACCEPTED_UNKNOWN'].includes(handoff.status);
        return res.status(isSent ? 200 : 202).json({
          ok: true, accepted: true, status: isSent ? 'SENT' : 'QUEUED',
          batch_id: batchId,
          operation_id: handoff.operation_id,
          request_ids: requestIds,
          skipped_request_ids: skippedItems.map((i) => String(i?.request_id || '')),
          items_accepted: fieldsList.length,
          source_record_id: sourceRecordId,
          reused: true,
          durable_status: handoff.status,
          ...(acceptedUnknown ? {
            accepted_unknown: true,
            recovery: 'NEEDS_RECONCILIATION',
          } : { recovery: 'CONFIRMED' }),
        });
      }

      if (acceptance.kind === 'UNKNOWN') {
        const timedOut = acceptance.error?.code === 'DISPATCH_QUEUE_TIMEOUT';
        log('warn', timedOut ? 'queue_timeout' : 'queue_confirm_unknown', {
          source, batch_id: batchId, operation_id: operation,
          error_code: acceptance.error?.code || 'HANDOFF_CONFIRM_FAILED',
        });
        return res.status(timedOut ? 503 : 202).json({
          ok: !timedOut, accepted: !timedOut, accepted_unknown: true, status: 'QUEUING',
          durable_status: 'ACCEPTED_UNKNOWN', recovery: 'NEEDS_RECONCILIATION',
          error_code: acceptance.error?.code || 'HANDOFF_CONFIRM_FAILED',
          batch_id: batchId, operation_id: operation, request_ids: requestIds,
        });
      }

      const published = acceptance.published;

      log('info', 'queue_accepted', {
        source, batch_id: batchId, chat_id: chatId, operation_id: operation,
        request_count: requestIds.length,
        queue_message_id: published?.message_id || '',
        deduplicated: Boolean(published?.deduplicated),
        duration_ms: Date.now() - publishStart,
      });

      const cachedStatus = published?.deduplicated
        ? await readDispatchStatusCache(statusCache, { chatId, batchId })
        : null;
      if (!published?.deduplicated || !cachedStatus) {
        await writeDispatchStatusCache(statusCache, {
          chatId, batchId,
          value: queuedDispatchStatus({ operationId: operation, requestIds }),
        });
      }

      return res.status(202).json({
        ok: true, accepted: true, status: 'QUEUED',
        durable_status: 'QUEUED', recovery: 'CONFIRMED',
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
      const rejection = dispatchBatchSizeRejection(error);
      log('error', 'failed', { source, error_code: code, message: error?.message, ...rejection });
      return res.status(status).json({ ok: false, error_code: code, source_record_id: sourceRecordId, ...rejection });
    }
  };
}
