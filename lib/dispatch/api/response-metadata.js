import { randomUUID } from 'node:crypto';

const SAFE_REQUEST_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

function incomingRequestId(req) {
  const value = String(req?.headers?.['x-bess-request-id'] || '').trim();
  return SAFE_REQUEST_ID.test(value) ? value : '';
}

export function attachDispatchResponseMetadata(req, res, { statusSource = 'none' } = {}) {
  const requestId = incomingRequestId(req) || randomUUID();
  res.setHeader('X-Bess-Request-Id', requestId);
  res.setHeader('X-Bess-Status-Source', statusSource);
  return {
    requestId,
    setStatusSource(value) {
      res.setHeader('X-Bess-Status-Source', String(value || 'none').slice(0, 64));
    },
  };
}
