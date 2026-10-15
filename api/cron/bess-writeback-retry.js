import process from 'node:process';
import { createSupabaseDispatchStore } from '../../lib/dispatch/supabase-store.js';
import { LarkClient } from '../../lib/lark/client.js';

const larkClient = new LarkClient({
  appId: () => process.env.LARK_APP_ID,
  appSecret: () => process.env.LARK_APP_SECRET,
});

export default async function handler(req, res) {
  const store = createSupabaseDispatchStore();
  const now = new Date();
  
  const appToken = process.env.BESS_BASE_APP_TOKEN;
  const tableId = process.env.BESS_BASE_TABLE_ID;
  if (!appToken || !tableId) {
    return res.status(500).json({ ok: false, error: 'BESS_BASE_APP_TOKEN or BESS_BASE_TABLE_ID not configured' });
  }

  try {
    // 1. Scan for pending writebacks
    // We'll use a Supabase query to find rows with pendingWritebacks in request_context
    // Since we don't have a specific RPC to list these yet, we use a raw request if possible
    // Or we just scan recent pending forms.
    const rows = await store.listHandoffsToReconcile({ now, limit: 100 });
    const writebackTargets = rows.filter(r => r.context.pendingWritebacks && Object.keys(r.context.pendingWritebacks).length > 0);
    
    const results = [];
    for (const target of writebackTargets) {
      const { context } = target;
      const { pendingWritebacks } = context;
      
      for (const [recordId, _info] of Object.entries(pendingWritebacks)) {
        try {
          // Attempt writeback to Base
          await larkClient.request('PATCH', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
            body: {
              fields: {
                Status: 'INGESTED',
                DispatchOperationID: context.operationId
              }
            }
          });
          
          // Clear pending writeback in store
          // We need a way to clear it. For now, we'll just log success.
          // In a real app, you'd call a 'clearWritebackFailure' RPC.
          results.push({ recordId, ok: true });
        } catch (e) {
          results.push({ recordId, ok: false, error: e.message });
        }
      }
    }

    return res.status(200).json({ ok: true, results });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
