export const DEFAULT_WRITEBACK_MAX_ATTEMPTS = 8;

const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422]);

export function isPermanentWritebackError(error) {
  const status = Number(error?.httpStatus || error?.status || error?.statusCode || 0);
  if (PERMANENT_HTTP_STATUSES.has(status)) return true;
  const code = String(error?.code || '').toUpperCase();
  return code === 'INVALID_RECORD_ID'
    || code === 'INVALID_BASE_FIELD'
    || code === 'BASE_RECORD_NOT_FOUND'
    || code === 'BASE_PERMISSION_DENIED';
}

export function writebackRetryDelayMs(attempt) {
  return Math.min(6 * 60 * 60_000, 5 * 60_000 * (2 ** Math.max(0, Number(attempt || 0))));
}
