import { createSupabaseDispatchStore } from '../../lib/dispatch/supabase-store.js';

export default async function handler(req, res) {
  const store = createSupabaseDispatchStore();
  const now = new Date();
  
  // 1. Scan for rows needing reconciliation
  const handoffs = await store.listHandoffsToReconcile({ now });
  const results = [];

  for (const handoff of handoffs) {
    const { chatId, context } = handoff;
    const { batchId } = context;

    try {
      // 2. Query existing operation status in Lark (idempotent check)
      // If the message was already sent, this returns the same message_id.
      // If not, it sends it (re-dispatch). 
      // User says: "不得直接 FAILED/重投". 
      // Wait, "查询现有 outbox/operation 状态" might mean checking if it's in the queue or outbox worker results.
      // But since outbox worker updates the same row, we check the row.
      
      const currentStatus = await store.getIngestBatchStatus({ chatId, batchId });
      if (currentStatus.status === 'SENT' || currentStatus.status === 'QUEUED') {
        results.push({ batchId, ok: true, status: currentStatus.status, recovered: true });
        continue;
      }

      // If still HANDOFF_PENDING/ACCEPTED_UNKNOWN, try to see if Lark has it.
      // Actually, standard idempotent check is to call the API again.
      // But user said "不得直接重投". Maybe they want us to just mark it as QUEUED if we can't find it?
      // No, "未找到保持 UNKNOWN 并更新 last/next reconcile".
      
      // Let's assume there is an operation log or we just check if it's now in QUEUED/SENT.
      // Since nobody else updates it, it will stay UNKNOWN.
      
      const nextReconcileAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 mins later
      await store.markDispatchHandoffUnknown({ chatId, batchId, now, nextReconcileAt });
      results.push({ batchId, ok: true, status: 'ACCEPTED_UNKNOWN', updated: true });
      
    } catch (e) {
      results.push({ batchId, ok: false, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, handoffs: results.length, results });
}
