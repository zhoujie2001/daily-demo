import { createHash } from 'node:crypto';
import { buildBatchDispatchCard } from '../lark/card-renderer.js';
import { batchDispatchActionValue, dispatchIdempotencyValue } from './ingest.js';
import { dispatchOperationId } from './operation.js';
import { DISPATCH_QUEUE_SCHEMA_VERSION } from './queue.js';

export const MAX_ITEMS_PER_CARD = 20;
export const MAX_BATCH_CHUNKS = 2;

export function dispatchChunkTargets(chatId, batchId) {
  return Array.from({ length: MAX_BATCH_CHUNKS }, (_, index) => ({
    chatId,
    batchId: dispatchChunkBatchId(batchId, index + 1, MAX_BATCH_CHUNKS),
  }));
}

export function dispatchChunkBatchId(batchId, chunkIndex, chunkCount) {
  const original = String(batchId);
  if (chunkCount <= 1) return original;
  const suffix = `_chunk_${chunkIndex}_of_${chunkCount}`;
  if (original.length + suffix.length <= 128) return `${original}${suffix}`;
  const digest = createHash('sha256').update(original).digest('hex').slice(0, 24);
  return `${original.slice(0, 88)}_${digest}${suffix}`.slice(0, 128);
}

export function splitDispatchCardChunks({ batchId, fieldsList }) {
  const chunkCount = Math.ceil(fieldsList.length / MAX_ITEMS_PER_CARD);
  return Array.from({ length: chunkCount }, (_, zeroIndex) => {
    const chunkIndex = zeroIndex + 1;
    const items = fieldsList.slice(zeroIndex * MAX_ITEMS_PER_CARD, chunkIndex * MAX_ITEMS_PER_CARD);
    return {
      originalBatchId: batchId,
      batchId: dispatchChunkBatchId(batchId, chunkIndex, chunkCount),
      chunkIndex,
      chunkCount,
      items,
      requestIds: items.map((item) => item.requestId),
    };
  });
}

export function buildDispatchCardChunkPlans(normalized, {
  source,
  sourceRecordId = '',
  expiresAt,
} = {}) {
  return splitDispatchCardChunks(normalized).map((chunk) => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(chunk.items.map(dispatchIdempotencyValue)))
      .digest('hex');
    const operationId = dispatchOperationId(normalized.chatId, chunk.batchId);
    const card = buildBatchDispatchCard(
      chunk.items,
      batchDispatchActionValue(chunk.batchId, chunk.items),
      {
        cardTitle: normalized.cardTitle,
        batchId: chunk.batchId,
        originalBatchId: normalized.batchId,
        period: normalized.period,
        cardLayout: normalized.cardLayout,
        chunkIndex: chunk.chunkIndex,
        chunkCount: chunk.chunkCount,
        originalItemCount: normalized.fieldsList.length,
      },
    );
    const queueMessage = {
      schema_version: DISPATCH_QUEUE_SCHEMA_VERSION,
      kind: 'dispatch',
      chat_id: normalized.chatId,
      batch_id: chunk.batchId,
      original_batch_id: normalized.batchId,
      chunk_index: chunk.chunkIndex,
      chunk_count: chunk.chunkCount,
      fingerprint,
      request_ids: chunk.requestIds,
      operation_id: operationId,
      card,
      source,
      ...(sourceRecordId ? { source_record_id: sourceRecordId } : {}),
      expires_at: expiresAt,
    };
    return { ...chunk, fingerprint, operationId, card, queueMessage };
  });
}

export function dispatchRootReservation(normalized, plans) {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(normalized.fieldsList.map(dispatchIdempotencyValue)))
    .digest('hex');
  return {
    chatId: normalized.chatId,
    batchId: normalized.batchId,
    fingerprint,
    requestIds: normalized.fieldsList.map((item) => item.requestId),
    chunkPlan: plans.map((plan) => ({
      batch_id: plan.batchId,
      fingerprint: plan.fingerprint,
      request_ids: plan.requestIds,
    })),
  };
}

export function dispatchChunkSummary(plan) {
  return {
    chunk_index: plan.chunkIndex,
    chunk_count: plan.chunkCount,
    batch_id: plan.batchId,
    operation_id: plan.operationId,
    request_ids: plan.requestIds,
    item_count: plan.requestIds.length,
  };
}

export function aggregateDispatchChunkStatuses(originalBatchId, rows) {
  const expected = Array.from({ length: MAX_BATCH_CHUNKS }, (_, index) => ({
    chunk_index: index + 1,
    chunk_count: MAX_BATCH_CHUNKS,
    batch_id: dispatchChunkBatchId(originalBatchId, index + 1, MAX_BATCH_CHUNKS),
  }));
  const byBatchId = new Map((rows || []).map((row) => [String(row.batch_id || ''), row]));
  const chunkRows = expected.map((chunk) => ({ ...chunk, ...(byBatchId.get(chunk.batch_id) || { found: false, status: 'NOT_FOUND' }) }));
  if (!chunkRows.some((row) => row.found)) return null;

  const failed = chunkRows.find((row) => ['FAILED', 'DEAD', 'RECONCILIATION_DEAD'].includes(row.status));
  const allSent = chunkRows.every((row) => row.found && row.status === 'SENT'
    && String(row.message_id || '').trim());
  const status = failed ? 'FAILED' : allSent ? 'SENT' : 'SENDING';
  const messageIds = chunkRows.map((row) => row.message_id).filter((value) => value && !String(value).startsWith('skipped:'));
  const operationIds = chunkRows.map((row) => row.operation_id).filter(Boolean);
  return {
    found: true,
    aggregate_chunks: true,
    status,
    batch_id: originalBatchId,
    chunks: chunkRows,
    message_ids: messageIds,
    operation_ids: operationIds,
    ...(messageIds[0] ? { message_id: messageIds[0] } : {}),
    ...(operationIds[0] ? { operation_id: operationIds[0] } : {}),
    request_ids: chunkRows.flatMap((row) => Array.isArray(row.request_ids) ? row.request_ids : []),
    retryable: failed ? failed.retryable === true : !allSent,
    ...(failed?.error_code ? { error_code: failed.error_code } : {}),
    ...(failed && ['DEAD', 'RECONCILIATION_DEAD'].includes(failed.status) ? {
      dead_letter: true,
      terminal_reason: failed.error_code || 'OUTBOX_DELIVERY_FAILED',
    } : {}),
  };
}
