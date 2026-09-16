import process from 'node:process';
import { DuplicateMessageError, QueueClient } from '@vercel/queue';

export const DISPATCH_QUEUE_TOPIC = 'bess-dispatch-v2';
export const DISPATCH_QUEUE_SCHEMA_VERSION = 1;

function queueRegion() {
  return process.env.BESS_DISPATCH_QUEUE_REGION
    || process.env.VERCEL_REGION
    || 'hnd1';
}

function client() {
  return new QueueClient({ region: queueRegion() });
}

export async function publishDispatchQueueMessage(message) {
  try {
    const result = await client().send(DISPATCH_QUEUE_TOPIC, message, {
      idempotencyKey: message.operation_id,
      retentionSeconds: 86_400,
      headers: {
        'x-bess-operation-id': message.operation_id,
      },
    });
    return { message_id: result.messageId || '', deduplicated: false };
  } catch (error) {
    // A retry with the same operation id means the original publish was already
    // accepted. Treat that as a successful durable hand-off, never as a reason
    // to send a card through a second path.
    if (error instanceof DuplicateMessageError) {
      return { message_id: '', deduplicated: true };
    }
    throw error;
  }
}

export function createDispatchQueueNodeHandler(onMessage, options = {}) {
  return client().handleNodeCallback(onMessage, options);
}
