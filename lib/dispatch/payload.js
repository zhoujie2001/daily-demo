import { Buffer } from 'node:buffer';

function payloadError(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseObjectJson(text) {
  const parsed = JSON.parse(text);
  if (!isPlainObject(parsed)) throw payloadError('INVALID_DISPATCH_PAYLOAD', 'dispatch_payload must decode to an object');
  return parsed;
}

function decodeBase64Json(value) {
  const compact = value.replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw payloadError('INVALID_DISPATCH_PAYLOAD', 'dispatch_payload is neither JSON nor Base64 JSON');
  }
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = Buffer.from(normalized, 'base64').toString('utf8');
  if (!decoded.trim()) throw payloadError('INVALID_DISPATCH_PAYLOAD', 'dispatch_payload Base64 value is empty');
  return parseObjectJson(decoded);
}

/**
 * Decode the payload formats produced by Base and Automation.
 * Only a JSON object is accepted. Strings are attempted as plain JSON first,
 * then as strict Base64/Base64URL JSON. Every other shape fails closed.
 */
export function decodeDispatchPayload(value) {
  if (value === undefined || value === null || value === '') {
    throw payloadError('MISSING_DISPATCH_PAYLOAD', 'dispatch_payload is required');
  }
  if (isPlainObject(value)) return value;
  if (typeof value !== 'string') {
    throw payloadError('INVALID_DISPATCH_PAYLOAD', 'dispatch_payload must be an object, JSON, or Base64 JSON');
  }

  const text = value.trim();
  if (!text) throw payloadError('MISSING_DISPATCH_PAYLOAD', 'dispatch_payload is required');
  try {
    return parseObjectJson(text);
  } catch (error) {
    if (error?.code === 'INVALID_DISPATCH_PAYLOAD') throw error;
  }

  try {
    return decodeBase64Json(text);
  } catch {
    throw payloadError('INVALID_DISPATCH_PAYLOAD', 'dispatch_payload is neither valid JSON nor Base64 JSON');
  }
}
