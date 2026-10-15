import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createSupabaseDispatchStore } from '../supabase-store.js';
import { LarkClient } from '../../lark/client.js';
import { dispatchOperationId } from '../operation.js';
import {
  batchDispatchActionValue, dispatchActionValue, dispatchIdempotencyValue,
  normalizeBatchDispatchIngest, normalizeDispatchIngest,
} from '../ingest.js';
import { buildBatchDispatchCard, buildInitialDispatchCard } from '../../lark/card-renderer.js';
import { DISPATCH_QUEUE_SCHEMA_VERSION, publishDispatchQueueMessage } from '../queue.js';

function authorized(req, secret) {
  const actual = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(actual);
  const right = Buffer.from(String(secret || ''));
  return right.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function normalizeRecord(record) {
  const raw = record.fields?.dispatch_payload;
  const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!payload) throw Object.assign(new Error('dispatch_payload is required'), { code: 'MISSING_PAYLOAD' });

  if (Array.isArray(payload.items)) {
    const normalized = normalizeBatchDispatchIngest(payload);
    return {
      payload,
      chatId: normalized.chatId,
      batchId: normalized.batchId,
      fieldsList: normalized.fieldsList,
      card: buildBatchDispatchCard(
        normalized.fieldsList,
        batchDispatchActionValue(normalized.batchId, normalized.fieldsList),
        {
          cardTitle: normalized.cardTitle,
          batchId: normalized.batchId,
          period: normalized.period,
          cardLayout: normalized.cardLayout,
        },
      ),
    };
  }

  const normalized = normalizeDispatchIngest(payload);
  return {
    payload,
    chatId: normalized.chatId,
    batchId: `single:${normalized.fields.requestId}`,
    fieldsList: [normalized.fields],
    card: buildInitialDispatchCard(normalized.fields, dispatchActionValue(normalized.fields)),
  };
}

function createQueueMessage({ chatId, batchId, fieldsList, card, fingerprint, operationId, recordId, now }) {
  return {
    schema_version: DISPATCH_QUEUE_SCHEMA_VERSION,
    kind: 'dispatch',
    chat_id: chatId,
    batch_id: batchId,
    fingerprint,
    request_ids: fieldsList.map((item) => item.requestId),
    operation_id: operationId,
    card,
    records: fieldsList,
    source_record_id: recordId,
    created_at: now.toISOString(),
  };
}

export function createBasePullHandler({
  secret = process.env.CRON_SECRET,
  enabled = process.env.BESS_BASE_PULL_ENABLED === 'true',
  appToken = process.env.BESS_BASE_APP_TOKEN,
  tableId = process.env.BESS_BASE_TABLE_ID,
  viewId = process.env.BESS_BASE_VIEW_ID,
  pageSize = Number(process.env.BESS_BASE_PULL_PAGE_SIZE) || 20,
  maxPages = Number(process.env.BESS_BASE_PULL_MAX_PAGES) || 10,
  storeFactory = () => createSupabaseDispatchStore(),
  client = new LarkClient({
    appId: () => process.env.LARK_APP_ID,
    appSecret: () => process.env.LARK_APP_SECRET,
  }),
  publishDispatch = publishDispatchQueueMessage,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    if (req?.method !== 'GET') {
      res.setHeader?.('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }
    if (!authorized(req, secret)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!enabled) return res.status(200).json({ ok: true, message: 'disabled' });
    if (!appToken || !tableId) return res.status(500).json({ ok: false, error: 'Base pull is not configured' });

    const store = storeFactory();
    const boundedPageSize = Math.max(1, Math.min(Number(pageSize) || 20, 100));
    const boundedMaxPages = Math.max(1, Math.min(Number(maxPages) || 10, 100));
    const records = [];
    const seenTokens = new Set();
    let pageToken;
    let pages = 0;
    let truncated = false;

    try {
      // Fetch the bounded snapshot before changing Status, otherwise mutating the filtered
      // result set while traversing its cursor can skip records.
      while (pages < boundedMaxPages) {
        const query = {
          filter: 'OR(CurrentValue.[Status]="PENDING",CurrentValue.[Status]="UNKNOWN")',
          page_size: boundedPageSize,
        };
        if (viewId) query.view_id = viewId;
        if (pageToken) query.page_token = pageToken;
        const page = await client.request(
          'GET',
          `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
          { query },
        );
        pages += 1;
        records.push(...(page.data?.items || []));
        if (page.data?.has_more !== true) break;
        const nextToken = page.data?.page_token;
        if (!nextToken || seenTokens.has(nextToken)) {
          throw Object.assign(new Error('Base returned an invalid page cursor'), { code: 'INVALID_PAGE_CURSOR' });
        }
        seenTokens.add(nextToken);
        pageToken = nextToken;
        truncated = pages >= boundedMaxPages;
      }

      const results = [];
      for (const record of records) {
        const recordId = record.record_id;
        try {
          const normalized = normalizeRecord(record);
          const { chatId, batchId, fieldsList, card } = normalized;
          const requestIds = fieldsList.map((item) => item.requestId);
          const fingerprint = createHash('sha256')
            .update(JSON.stringify(fieldsList.map(dispatchIdempotencyValue)))
            .digest('hex');
          const operationId = dispatchOperationId(chatId, batchId);
          const current = now();
          const expiresAt = new Date(current.getTime() + 7 * 24 * 3600_000).toISOString();
          const queueMessage = createQueueMessage({
            chatId, batchId, fieldsList, card, fingerprint, operationId, recordId, now: current,
          });
          const handoff = await store.registerDispatchHandoff({
            chatId, batchId, fingerprint, requestIds, operationId, card, queueMessage,
            source: `pull:${recordId}`, sourceRecordId: recordId, expiresAt, now: current,
          });

          if (handoff.outcome === 'PAYLOAD_CONFLICT') {
            results.push({ recordId, ok: false, error: 'PAYLOAD_CONFLICT' });
            continue;
          }
          if (handoff.status === 'DEAD') {
            results.push({ recordId, ok: false, status: 'FAILED', dead_letter: true });
            continue;
          }

          let requiresPublish = handoff.outcome === 'ACCEPTED';
          let publishWorkerToken = null;
          let publishMessage = queueMessage;
          if (handoff.status === 'HANDOFF_PENDING' && typeof store.claimDispatchHandoffPublish === 'function') {
            const claim = await store.claimDispatchHandoffPublish({
              chatId, batchId, operationId, fingerprint, card, now: current,
            });
            requiresPublish = claim.claimed;
            if (claim.claimed) {
              publishWorkerToken = claim.workerToken;
              publishMessage = claim.queueMessage || queueMessage;
            }
          }
          if (!requiresPublish && handoff.status === 'HANDOFF_PENDING') {
            results.push({ recordId, ok: true, status: 'HANDOFF_PENDING', publishClaimed: false });
            continue;
          }
          if (requiresPublish) {
            try {
              await publishDispatch(publishMessage);
            } catch (error) {
              if (error?.code === 'DISPATCH_QUEUE_TIMEOUT') {
                // A timeout cannot prove whether the queue accepted the message.
                await store.markDispatchHandoffUnknown({
                  chatId, batchId, workerToken: publishWorkerToken, now: now(),
                });
                results.push({
                  recordId, ok: false, acceptedUnknown: true, status: 'ACCEPTED_UNKNOWN',
                  error: 'DISPATCH_QUEUE_TIMEOUT',
                });
                continue;
              }
              // Any other awaited publish rejection is authoritative non-acceptance.
              // Keep the complete message context so reconciliation can safely retry it.
              await store.markDispatchHandoffRejected({
                chatId, batchId, operationId, fingerprint, card,
                errorCode: error?.code || 'DISPATCH_QUEUE_UNAVAILABLE',
                workerToken: publishWorkerToken, now: now(),
              });
              throw error;
            }

            try {
              await store.confirmDispatchHandoff({
                chatId, batchId, operationId, workerToken: publishWorkerToken, now: now(),
              });
            } catch (error) {
              // Publish succeeded, so failed confirmation is ambiguous acceptance.
              // Do not mark the Base row INGESTED until reconciliation confirms it.
              await store.markDispatchHandoffUnknown({
                chatId, batchId, workerToken: publishWorkerToken, now: now(),
              });
              results.push({
                recordId, ok: false, acceptedUnknown: true, status: 'ACCEPTED_UNKNOWN',
                error: error?.code || 'HANDOFF_CONFIRM_FAILED',
              });
              continue;
            }
          }

          let writebackPending = false;
          try {
            await client.request(
              'PATCH',
              `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
              { body: { fields: { Status: 'INGESTED', DispatchOperationID: operationId } } },
            );
          } catch (error) {
            writebackPending = true;
            await store.recordWritebackFailure({
              chatId, batchId, recordId, operationId,
              errorCode: error?.code || 'BASE_WRITEBACK_FAILED',
              now: now(), nextRetryAt: new Date(now().getTime() + 5 * 60_000),
            });
          }

          results.push({
            recordId, ok: true, outcome: requiresPublish ? handoff.outcome : 'ALREADY_PROCESSED',
            status: handoff.status, writebackPending,
          });
        } catch (error) {
          results.push({ recordId, ok: false, error: error?.code || 'PROCESS_RECORD_FAILED', message: error?.message });
        }
      }

      return res.status(200).json({ ok: true, pages, truncated, results });
    } catch (error) {
      return res.status(502).json({ ok: false, error: error?.code || 'BASE_PULL_FAILED' });
    }
  };
}

export default function handler(req, res) {
  // Resolve environment at invocation time; serverless modules may be loaded before
  // runtime secrets/feature flags are injected (and tests intentionally mutate env).
  return createBasePullHandler()(req, res);
}
