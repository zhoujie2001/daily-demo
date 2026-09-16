import { createDispatchQueueNodeHandler } from '../../lib/dispatch/queue.js';
import { processDispatchQueueMessage } from '../../lib/dispatch/outbox-worker.js';

export function createDispatchOutboxQueueHandler({
  processMessage = processDispatchQueueMessage,
  createHandler = createDispatchQueueNodeHandler,
} = {}) {
  return createHandler(
    async (message, metadata) => {
      const startedAt = Date.now();
      try {
        const result = await processMessage(message);
        console.info(JSON.stringify({
          module: 'bess-dispatch-queue', stage: 'processed',
          queue_message_id: metadata.messageId,
          delivery_count: metadata.deliveryCount,
          operation_id: String(message?.operation_id || ''),
          duration_ms: Date.now() - startedAt,
        }));
        return result;
      } catch (error) {
        console.error(JSON.stringify({
          module: 'bess-dispatch-queue', stage: 'failed',
          queue_message_id: metadata.messageId,
          delivery_count: metadata.deliveryCount,
          operation_id: String(message?.operation_id || ''),
          error_code: error?.code || 'DISPATCH_QUEUE_CONSUMER_FAILED',
          duration_ms: Date.now() - startedAt,
        }));
        throw error;
      }
    },
    {
      visibilityTimeoutSeconds: 60,
      retry(error, metadata) {
        if (error?.acknowledge || metadata.deliveryCount >= 12) return { acknowledge: true };
        return { afterSeconds: Math.min(300, 5 * (2 ** Math.max(0, metadata.deliveryCount - 1))) };
      },
    },
  );
}

// A queue trigger makes this function private on Vercel. It is deliberately
// not shared with the public Cron endpoint; queue callbacks are authenticated
// and invoked exclusively by Vercel's queue infrastructure.
export default createDispatchOutboxQueueHandler();
