import process from 'node:process';
import { registerQianchuanSource } from '../qianchuan-policy.js';
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
import { decodeDispatchPayload } from '../payload.js';
import { runDurableDispatchHandoff } from '../durable-handoff.js';

const FAILED_WITHOUT_HTTP_RECEIPT = new Set([
  'HTTP_HANDOFF_TIMEOUT_AFTER_SINGLE_RETRY',
  'AUTO_RETRY_REARM_AFTER_HTTP_NO_RESPONSE',
]);
const defaultStoreFactory = () => createSupabaseDispatchStore();

function authorized(req, secret) {
  const actual = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(actual);
  const right = Buffer.from(String(secret || ''));
  return right.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function field(fields, names) {
  const entries = Object.entries(fields || {});
  for (const name of names) {
    const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (match) return match[1];
  }
  return undefined;
}

function scalar(value) {
  if (Array.isArray(value)) return value.length === 1 ? scalar(value[0]) : value;
  if (value && typeof value === 'object') {
    for (const key of ['text', 'value', 'name']) {
      if (value[key] !== undefined) return scalar(value[key]);
    }
  }
  return value;
}

function textCell(value) {
  if (Array.isArray(value)) return value.map((item) => textCell(item)).join('');
  if (value && typeof value === 'object') {
    for (const key of ['text', 'value']) {
      if (value[key] !== undefined) return textCell(value[key]);
    }
    return value;
  }
  return value === undefined || value === null ? value : String(value);
}

function blank(value) {
  const normalized = scalar(value);
  return normalized === undefined || normalized === null
    || (typeof normalized === 'string' && normalized.trim() === '')
    || (Array.isArray(normalized) && normalized.length === 0);
}

function productionBoolean(value) {
  const normalized = scalar(value);
  return normalized === true || String(normalized || '').trim().toLowerCase() === 'true';
}

function parseRecordAllowlist(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean));
}

export function basePullHistoryEligibility({ recordId, batchId, minBatchId, recordAllowlist }) {
  const allowlist = recordAllowlist instanceof Set ? recordAllowlist : parseRecordAllowlist(recordAllowlist);
  if (allowlist.has(recordId)) return { eligible: true, reason: 'RECORD_ALLOWLIST' };
  const boundary = String(minBatchId || '').trim();
  if (!boundary) return { eligible: false, reason: 'HISTORY_ISOLATION_UNCONFIGURED' };
  if (!/^\d{8}-\S+$/.test(boundary)) return { eligible: false, reason: 'INVALID_MIN_BATCH_ID' };
  const candidate = String(batchId || '').trim();
  if (!/^\d{8}-\S+$/.test(candidate)) return { eligible: false, reason: 'BATCH_OUTSIDE_CONFIGURED_WINDOW' };
  return candidate >= boundary
    ? { eligible: true, reason: 'BATCH_WINDOW' }
    : { eligible: false, reason: 'BATCH_OUTSIDE_CONFIGURED_WINDOW' };
}

export function basePullEligibility(record) {
  const fields = record?.fields || {};
  const status = String(scalar(field(fields, ['automation_status'])) || '').trim().toUpperCase();
  const operationId = field(fields, ['operation_id', 'DispatchOperationID', 'Operation ID']);
  if (!blank(operationId)) return { eligible: false, reason: 'EXISTING_OPERATION' };
  const messageId = field(fields, ['message_id', 'dispatch_message_id', 'DispatchMessageID', 'Message ID']);
  if (!blank(messageId)) return { eligible: false, reason: 'EXISTING_MESSAGE' };

  if (status === 'PENDING' || status === 'UNKNOWN') return { eligible: true, status };
  if (status !== 'FAILED') return { eligible: false, reason: 'STATUS_NOT_RECOVERABLE' };

  const errorDetail = String(scalar(field(fields, ['error_detail', 'ErrorDetail', 'Error Detail'])) || '').trim();
  if (!FAILED_WITHOUT_HTTP_RECEIPT.has(errorDetail)) {
    return { eligible: false, reason: 'FAILED_NOT_PROVEN_NO_HTTP_RECEIPT' };
  }
  if (!blank(field(fields, ['http_status', 'HTTPStatus', 'HTTP Status']))) {
    return { eligible: false, reason: 'HTTP_STATUS_PRESENT' };
  }
  if (!blank(field(fields, ['items_accepted', 'ItemsAccepted', 'Items Accepted']))) {
    return { eligible: false, reason: 'ITEMS_ACCEPTED_PRESENT' };
  }
  return { eligible: true, status, recoveryReason: errorDetail };
}

function normalizeRecord(record) {
  const raw = textCell(field(record.fields, ['dispatch_payload', 'Dispatch Payload']));
  const payload = decodeDispatchPayload(raw);

  if (Array.isArray(payload.items)) {
    const normalized = normalizeBatchDispatchIngest(payload);
    return {
      payload,
      chatId: normalized.chatId,
      batchId: normalized.batchId,
      fieldsList: normalized.fieldsList,
      qianchuanSnapshot: normalized.qianchuanSnapshot,
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

function configurationError(missing) {
  return {
    httpStatus: 500,
    body: {
      ok: false,
      error: 'BASE_PULL_CONFIGURATION_MISSING',
      error_code: 'BASE_PULL_CONFIGURATION_MISSING',
      missing_configuration: missing,
    },
  };
}

export async function runBasePull({
  enabled = process.env.BESS_BASE_PULL_ENABLED === 'true',
  appToken = process.env.BESS_BASE_APP_TOKEN,
  tableId = process.env.BESS_BASE_TABLE_ID,
  viewId = process.env.BESS_BASE_VIEW_ID,
  appId = process.env.LARK_APP_ID,
  appSecret = process.env.LARK_APP_SECRET,
  pageSize = Number(process.env.BESS_BASE_PULL_PAGE_SIZE) || 20,
  maxPages = Number(process.env.BESS_BASE_PULL_MAX_PAGES) || 10,
  minBatchId = process.env.BESS_BASE_PULL_MIN_BATCH_ID,
  recordAllowlist = process.env.BESS_BASE_PULL_RECORD_ALLOWLIST,
  enforceHistoryIsolation = true,
  publishTimeoutMs = 5_000,
  defer = () => {},
  store,
  storeFactory = defaultStoreFactory,
  client,
  publishDispatch = publishDispatchQueueMessage,
  now = () => new Date(),
} = {}) {
  if (!enabled) return { httpStatus: 200, body: { ok: true, message: 'disabled' } };

  const missing = [
    !appToken && 'BESS_BASE_APP_TOKEN',
    !tableId && 'BESS_BASE_TABLE_ID',
    !client && !appId && 'LARK_APP_ID',
    !client && !appSecret && 'LARK_APP_SECRET',
    !store && storeFactory === defaultStoreFactory && !process.env.SUPABASE_URL && 'SUPABASE_URL',
    !store && storeFactory === defaultStoreFactory && !process.env.SUPABASE_SERVICE_ROLE_KEY
      && 'SUPABASE_SERVICE_ROLE_KEY',
  ].filter(Boolean);
  if (missing.length > 0) return configurationError(missing);

  const dispatchStore = store || storeFactory();
  const baseClient = client || new LarkClient({ appId, appSecret });
  const boundedPageSize = Math.max(1, Math.min(Number(pageSize) || 20, 100));
  const boundedMaxPages = Math.max(1, Math.min(Number(maxPages) || 10, 100));
  const records = [];
  const allowlist = parseRecordAllowlist(recordAllowlist);
  let pages = 0;
  let truncated = false;

  try {
    const token = typeof baseClient.getTenantAccessToken === 'function'
      ? await baseClient.getTenantAccessToken() : undefined;
    const recordsPath = `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;
    if (allowlist.size > 0) {
      // An allowlist is a strict access boundary: do not list or inspect any other Base records.
      for (const recordId of allowlist) {
        const response = await baseClient.request(
          'GET',
          `${recordsPath}/${encodeURIComponent(recordId)}`,
          { token },
        );
        pages += 1;
        if (response.data?.record) records.push(response.data.record);
      }
    } else {
      const seenTokens = new Set();
      let pageToken;
      // Restrict the remote scan to records that have not been accepted yet.
      // Sorting the whole table by batch_id is not enough: non-production test
      // prefixes sort ahead of date-based batches and can exhaust the page cap.
      const searchPath = `${recordsPath}/search`;
      while (pages < boundedMaxPages) {
        const query = { page_size: boundedPageSize };
        if (pageToken) query.page_token = pageToken;
        const body = {
          filter: {
            conjunction: 'and',
            conditions: [{ field_name: 'operation_id', operator: 'isEmpty', value: [] }],
          },
          sort: [{ field_name: 'batch_id', desc: true }],
          ...(viewId ? { view_id: viewId } : {}),
        };
        const page = await baseClient.request('POST', searchPath, { query, body, token });
        pages += 1;
        records.push(...(Array.isArray(page.data?.items) ? page.data.items : []));
        if (page.data?.has_more !== true) break;
        const nextToken = page.data?.page_token;
        if (!nextToken || seenTokens.has(nextToken)) {
          throw Object.assign(new Error('Base returned an invalid page cursor'), { code: 'INVALID_PAGE_CURSOR' });
        }
        seenTokens.add(nextToken);
        pageToken = nextToken;
        truncated = pages >= boundedMaxPages;
      }
    }

    const results = [];
    for (const record of records) {
      const recordId = String(record?.record_id || '').trim();
      const eligibility = basePullEligibility(record);
      if (!recordId || !eligibility.eligible) {
        results.push({ recordId: recordId || null, ok: true, skipped: true, reason: recordId ? eligibility.reason : 'MISSING_RECORD_ID' });
        continue;
      }
      try {
        const normalized = normalizeRecord(record);
        const { chatId, batchId, fieldsList, card } = normalized;
        if (enforceHistoryIsolation) {
          const history = basePullHistoryEligibility({
            recordId, batchId, minBatchId, recordAllowlist,
          });
          if (!history.eligible) {
            results.push({ recordId, ok: true, skipped: true, status: 'HISTORY_SKIPPED', reason: history.reason });
            continue;
          }
        }
        if (productionBoolean(field(record.fields, ['dry_run']))) {
          results.push({
            recordId, ok: true, skipped: true, status: 'DRY_RUN_OK',
            batchId, operationId: dispatchOperationId(chatId, batchId),
            itemsAccepted: fieldsList.length,
          });
          continue;
        }
        const requestIds = fieldsList.map((item) => item.requestId);
        const fingerprint = createHash('sha256')
          .update(JSON.stringify(fieldsList.map(dispatchIdempotencyValue)))
          .digest('hex');
        const operationId = dispatchOperationId(chatId, batchId);
        const current = now();
        await registerQianchuanSource(dispatchStore, normalized, current);
        const expiresAt = new Date(current.getTime() + 7 * 24 * 3600_000).toISOString();
        const queueMessage = createQueueMessage({
          chatId, batchId, fieldsList, card, fingerprint, operationId, recordId, now: current,
        });
        const acceptance = await runDurableDispatchHandoff({
          store: dispatchStore,
          registration: {
            chatId, batchId, fingerprint, requestIds, operationId, card, queueMessage,
            source: `pull:${recordId}`, sourceRecordId: recordId, expiresAt, now: current,
          },
          publishDispatch,
          publishTimeoutMs,
          defer,
          now,
        });
        const { handoff } = acceptance;

        if (acceptance.kind === 'CONFLICT') {
          results.push({ recordId, ok: false, error: 'PAYLOAD_CONFLICT' });
          continue;
        }
        if (acceptance.kind === 'DEAD') {
          results.push({ recordId, ok: false, status: 'FAILED', dead_letter: true });
          continue;
        }
        if (acceptance.kind === 'UNKNOWN') {
          results.push({
            recordId, ok: false, acceptedUnknown: true, status: 'ACCEPTED_UNKNOWN',
            error: acceptance.error?.code || 'HANDOFF_CONFIRM_FAILED',
          });
          continue;
        }

        const authoritativeStatus = acceptance.kind === 'PUBLISHED'
          ? 'QUEUED'
          : (['QUEUED', 'SENT'].includes(handoff.status) ? handoff.status : '');
        if (!authoritativeStatus) {
          results.push({
            recordId, ok: handoff.status === 'HANDOFF_PENDING',
            acceptedUnknown: handoff.status === 'ACCEPTED_UNKNOWN',
            status: handoff.status || 'HANDOFF_PENDING', writebackPending: false,
            publishClaimed: false,
          });
          continue;
        }

        let writebackPending = false;
        let writebackErrorCode = '';
        try {
          await baseClient.request(
            'PUT',
            `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
            {
              body: {
                fields: {
                  automation_status: 'QUEUED',
                  operation_id: operationId,
                  http_status: 202,
                  items_accepted: fieldsList.length,
                  error_detail: '',
                },
              },
              token,
            },
          );
        } catch (error) {
          writebackPending = true;
          writebackErrorCode = error?.code || 'BASE_WRITEBACK_FAILED';
          await dispatchStore.recordWritebackFailure({
            chatId, batchId, recordId, operationId,
            errorCode: writebackErrorCode,
            now: now(), nextRetryAt: new Date(now().getTime() + 5 * 60_000),
          });
        }

        results.push({
          recordId, ok: true,
          outcome: acceptance.kind === 'PUBLISHED' ? handoff.outcome : 'ALREADY_PROCESSED',
          status: authoritativeStatus, writebackPending,
          ...(writebackErrorCode ? { writebackErrorCode } : {}),
        });
      } catch (error) {
        results.push({ recordId, ok: false, error: error?.code || 'PROCESS_RECORD_FAILED', message: error?.message });
      }
    }

    return { httpStatus: 200, body: { ok: true, pages, truncated, results } };
  } catch (error) {
    return {
      httpStatus: 502,
      body: { ok: false, error: error?.code || 'BASE_PULL_FAILED', message: error?.message },
    };
  }
}

export function createBasePullHandler({ secret = process.env.CRON_SECRET, ...options } = {}) {
  return async function handler(req, res) {
    if (req?.method !== 'GET') {
      res.setHeader?.('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }
    if (!authorized(req, secret)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const result = await runBasePull(options);
    return res.status(result.httpStatus).json(result.body);
  };
}

export default function handler(req, res) {
  return createBasePullHandler()(req, res);
}
