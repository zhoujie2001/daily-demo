import process from 'node:process';
import { createSupabaseDispatchStore } from '../../lib/dispatch/supabase-store.js';
import { LarkClient } from '../../lib/lark/client.js';
import { dispatchOperationId } from '../../lib/dispatch/operation.js';
import { normalizeBatchDispatchIngest, normalizeDispatchIngest, dispatchIdempotencyValue } from '../../lib/dispatch/ingest.js';
import { createHash } from 'node:crypto';

const larkClient = new LarkClient({
  appId: () => process.env.LARK_APP_ID,
  appSecret: () => process.env.LARK_APP_SECRET,
});

export default async function handler(req, res) {
  if (process.env.BESS_BASE_PULL_ENABLED !== 'true') {
    return res.status(200).json({ ok: true, message: 'disabled' });
  }

  const appToken = process.env.BESS_BASE_APP_TOKEN;
  const tableId = process.env.BESS_BASE_TABLE_ID;
  if (!appToken || !tableId) {
    return res.status(500).json({ ok: false, error: 'BESS_BASE_APP_TOKEN or BESS_BASE_TABLE_ID not configured' });
  }

  const store = createSupabaseDispatchStore();
  const now = new Date();

  try {
    // 1. Pull PENDING/UNKNOWN records from Base
    // Filter query: (Status="PENDING" OR Status="UNKNOWN")
    const payload = await larkClient.request('GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
      query: { filter: `OR(CurrentValue.[Status]="PENDING",CurrentValue.[Status]="UNKNOWN")`, page_size: 20 }
    });

    const records = payload.data?.items || [];
    const results = [];

    for (const record of records) {
      const recordId = record.record_id;
      const fields = record.fields;
      
      // Parse dispatch_payload (usually stored in a long text field)
      let dispatchPayload;
      try {
        dispatchPayload = typeof fields.dispatch_payload === 'string' 
          ? JSON.parse(fields.dispatch_payload) 
          : fields.dispatch_payload;
      } catch {
        results.push({ recordId, ok: false, error: 'INVALID_PAYLOAD' });
        continue;
      }

      if (!dispatchPayload) {
        results.push({ recordId, ok: false, error: 'MISSING_PAYLOAD' });
        continue;
      }

      // Unified path: normalization and fingerprint
      const isBatch = Array.isArray(dispatchPayload.items);
      let chatId, batchId, normalizedItems;
      try {
        if (isBatch) {
          const norm = normalizeBatchDispatchIngest(dispatchPayload);
          chatId = norm.chatId;
          batchId = norm.batchId;
          normalizedItems = norm.fieldsList;
        } else {
          const norm = normalizeDispatchIngest(dispatchPayload);
          chatId = norm.chatId;
          normalizedItems = [norm.fields];
          batchId = `single:${norm.fields.requestId}`;
        }
      } catch (err) {
        results.push({ recordId, ok: false, error: 'NORMALIZE_FAILED', message: err.message });
        continue;
      }

      const fingerprint = createHash('sha256')
        .update(JSON.stringify(normalizedItems.map(dispatchIdempotencyValue)))
        .digest('hex');
      const operationId = dispatchOperationId(chatId, batchId);
      const requestIds = normalizedItems.map(i => i.requestId);
      const expiresAt = new Date(now.getTime() + 7 * 24 * 3600_000).toISOString();

      // 2. Atomic claim and handoff registration
      const handoff = await store.registerDispatchHandoff({
        chatId, batchId, fingerprint, requestIds, operationId,
        source: `pull:${recordId}`, expiresAt, now
      });

      if (handoff.outcome === 'PAYLOAD_CONFLICT') {
        // Mark in Base as conflict if possible, or just log
        results.push({ recordId, ok: false, error: 'PAYLOAD_CONFLICT' });
        continue;
      }

      if (handoff.outcome === 'ACCEPTED' || (handoff.outcome === 'REUSED' && ['HANDOFF_PENDING', 'ACCEPTED_UNKNOWN'].includes(handoff.status))) {
        // Only publish if not already queued/sent
        // In pull mode, we might want to publish immediately or let reconciler handle it.
        // The requirement says "重复领取不重复 publish".
        // Here we just registered. Now we should publish if it's the first time.
        results.push({ recordId, ok: true, outcome: handoff.outcome, status: handoff.status });
      } else {
        results.push({ recordId, ok: true, outcome: 'ALREADY_PROCESSED', status: handoff.status });
      }
    }

    return res.status(200).json({ ok: true, results });
  } catch (error) {
    console.error('Base pull failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
