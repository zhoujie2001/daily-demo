import { createHash } from 'node:crypto';

export function dispatchOperationId(chatId, batchId) {
  return `bess-outbox-${createHash('sha256')
    .update(`${String(chatId)}:${String(batchId)}`)
    .digest('hex')
    .slice(0, 32)}`;
}
