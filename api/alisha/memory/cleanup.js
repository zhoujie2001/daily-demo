import { handleAlishaMemoryCleanup } from '../../../server/alishaMemoryApi.js';

export default function handler(req, res) {
  return handleAlishaMemoryCleanup(req, res);
}
