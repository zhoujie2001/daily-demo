import { handleAlishaMemoryRequest } from '../../../server/alishaMemoryApi.js';

export default function handler(req, res) {
  return handleAlishaMemoryRequest(req, res, 'recommendation');
}
