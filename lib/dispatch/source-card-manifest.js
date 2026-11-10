import { createHash } from 'node:crypto';

const MANIFEST_KEYS = ['version', 'source_batch_id', 'chat_id', 'dispatch_profile', 'target_category',
  'total_item_count', 'chunk_count', 'chunks', 'manifest_hash'];
const BINDING_KEYS = MANIFEST_KEYS.filter((key) => key !== 'chunks').concat(['chunk_index', 'batch_id']);
const CHUNK_KEYS = ['chunk_index', 'batch_id', 'item_count', 'request_ids'];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[a-f0-9]{64}$/;

function fail(code = 'SOURCE_CARD_INVALID_MANIFEST') {
  throw Object.assign(new Error('源卡片清单缺失、无效或绑定冲突，已停止派单'), {
    code, userMessage: '源卡片清单缺失、无效或绑定冲突，已停止派单',
    status: code.endsWith('STORE_REQUIRED') ? 503 : code.includes('CONFLICT') ? 409 : 400,
  });
}
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail();
}
export function sourceCardCanonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sourceCardCanonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sourceCardCanonicalJson(value[key])}`).join(',')}}`;
}
export function sourceCardManifestHash(manifest) {
  const { manifest_hash: _hash, ...content } = manifest;
  return createHash('sha256').update(sourceCardCanonicalJson(content), 'utf8').digest('hex');
}
function header(value) {
  if (value.version !== 1 || typeof value.source_batch_id !== 'string' || !ID.test(value.source_batch_id)
      || typeof value.chat_id !== 'string' || !/^oc_[A-Za-z0-9_]{1,128}$/.test(value.chat_id)
      || value.dispatch_profile !== 'ad' || value.target_category !== 'game_agent'
      || !Number.isSafeInteger(value.total_item_count) || value.total_item_count < 1 || value.total_item_count > 1000
      || !Number.isSafeInteger(value.chunk_count) || value.chunk_count !== Math.ceil(value.total_item_count / 20)
      || typeof value.manifest_hash !== 'string' || !HASH.test(value.manifest_hash)) fail();
}
export function validateSourceCardManifest(manifest) {
  exactKeys(manifest, MANIFEST_KEYS);
  header(manifest);
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length !== manifest.chunk_count) fail();
  const batches = new Set(), requests = new Set();
  manifest.chunks.forEach((chunk, index) => {
    exactKeys(chunk, CHUNK_KEYS);
    const count = Math.min(20, manifest.total_item_count - index * 20);
    if (chunk.chunk_index !== index + 1 || typeof chunk.batch_id !== 'string' || !ID.test(chunk.batch_id)
        || batches.has(chunk.batch_id) || chunk.item_count !== count
        || !Array.isArray(chunk.request_ids) || chunk.request_ids.length !== count) fail();
    batches.add(chunk.batch_id);
    chunk.request_ids.forEach((id) => {
      if (typeof id !== 'string' || !REQUEST_ID.test(id) || requests.has(id)) fail();
      requests.add(id);
    });
  });
  if (requests.size !== manifest.total_item_count || manifest.manifest_hash !== sourceCardManifestHash(manifest)) {
    fail('SOURCE_CARD_HASH_OR_COUNT_MISMATCH');
  }
  return structuredClone(manifest);
}
export function stableSourceCardBinding(binding) {
  return Object.fromEntries(BINDING_KEYS.map((key) => [key, binding[key]]));
}
export function sourceCardBinding(manifest, index) {
  const value = { ...manifest, chunk_index: index, batch_id: manifest.chunks[index - 1].batch_id };
  return Object.fromEntries(BINDING_KEYS.map((key) => [key, value[key]]));
}
export function validateSourceCardBinding(binding, fields, chatId) {
  exactKeys(binding, BINDING_KEYS);
  header(binding);
  if (!Number.isSafeInteger(binding.chunk_index) || binding.chunk_index < 1 || binding.chunk_index > binding.chunk_count
      || typeof binding.batch_id !== 'string' || !ID.test(binding.batch_id)
      || binding.chat_id !== chatId || fields.dispatchProfile !== binding.dispatch_profile
      || fields.targetCategory !== binding.target_category || fields.businessType !== 'AD' || fields.dispatchScope !== 'ad_game') {
    fail('SOURCE_CARD_BINDING_CONFLICT');
  }
  return Object.fromEntries(BINDING_KEYS.map((key) => [key, binding[key]]));
}
export function rejectUnknownSourceCardKeys(value, allowed = []) {
  if (Object.keys(value || {}).some((key) => key.startsWith('source_card_') && !allowed.includes(key))) fail();
}
export function normalizeSourceCardDelivery(body, fieldsList, chatId, batchId) {
  rejectUnknownSourceCardKeys(body, ['source_card_manifest', 'source_card_chunk_index']);
  if (!Object.hasOwn(body, 'source_card_manifest') && !Object.hasOwn(body, 'source_card_chunk_index')) return null;
  const manifest = validateSourceCardManifest(body.source_card_manifest);
  const index = body.source_card_chunk_index;
  if (!Number.isSafeInteger(index) || index < 1 || index > manifest.chunk_count) fail();
  const chunk = manifest.chunks[index - 1];
  if (body.chat_id !== manifest.chat_id || body.batch_id !== chunk.batch_id
      || sourceCardCanonicalJson(body.items?.map((item) => item.request_id)) !== sourceCardCanonicalJson(chunk.request_ids)
      || body.items?.some((item) => (Object.hasOwn(item, 'source_batch_id') && item.source_batch_id !== manifest.source_batch_id)
        || (Object.hasOwn(item, 'dispatch_profile') && item.dispatch_profile !== manifest.dispatch_profile)
        || item.target_category !== manifest.target_category || item.business_type !== 'AD')
      || batchId !== chunk.batch_id || sourceCardCanonicalJson(fieldsList.map((item) => item.requestId)) !== sourceCardCanonicalJson(chunk.request_ids)
      || (Object.hasOwn(body, 'dispatch_profile') && body.dispatch_profile !== manifest.dispatch_profile)
      || (Object.hasOwn(body, 'source_batch_id') && body.source_batch_id !== manifest.source_batch_id)) fail('SOURCE_CARD_BINDING_CONFLICT');
  const binding = sourceCardBinding(manifest, index);
  fieldsList.forEach((fields) => validateSourceCardBinding(binding, fields, chatId));
  return { manifest, binding };
}
export async function assertLegacySourceCardBatch(store, batchId) {
  if (batchId && typeof store?.assertLegacySourceCardBatch === 'function') {
    await store.assertLegacySourceCardBatch({ batchId });
  }
}
export async function registerSourceCardManifest(store, normalized, root = null) {
  if (!normalized?.sourceCardManifest) {
    await assertSourceCardBinding(store, { chatId: normalized?.chatId, batchId: normalized?.batchId,
      items: normalized?.fieldsList || [] });
    return;
  }
  if (typeof store?.registerSourceCardManifest !== 'function') fail('SOURCE_CARD_STORE_REQUIRED');
  const result = await store.registerSourceCardManifest({ manifest: normalized.sourceCardManifest, root });
  if (result?.outcome !== 'ACCEPTED') fail('SOURCE_CARD_BINDING_CONFLICT');
}
export async function assertSourceCardBinding(store, { chatId, batchId, items, subset = false, messageId = null }) {
  const bindings = items.map((item) => item?.sourceCardBinding);
  if (!bindings.some(Boolean)) {
    await assertLegacySourceCardBatch(store, batchId);
    if (typeof store?.assertLegacySourceCardMembers === 'function') {
      await store.assertLegacySourceCardMembers({ chatId, messageId, items });
    }
    return;
  }
  const binding = bindings[0];
  if (!binding || bindings.some((value) => sourceCardCanonicalJson(value) !== sourceCardCanonicalJson(binding))) fail();
  items.forEach((fields) => validateSourceCardBinding(binding, fields, chatId));
  if (batchId !== binding.batch_id || (subset && items.length !== 1)
      || (!subset && items.length !== Math.min(20, binding.total_item_count - (binding.chunk_index - 1) * 20))) {
    fail('SOURCE_CARD_BINDING_CONFLICT');
  }
  if (typeof store?.assertSourceCardBinding !== 'function') fail('SOURCE_CARD_STORE_REQUIRED');
  const result = await store.assertSourceCardBinding({ binding, requestIds: items.map((item) => item.requestId), subset });
  if (result?.outcome !== 'ACCEPTED') fail('SOURCE_CARD_BINDING_CONFLICT');
}
export function sourceCardLabel(fields) {
  const binding = fields?.sourceCardBinding;
  return binding ? `源批次：${binding.source_batch_id}｜共 ${binding.total_item_count} 条｜第 ${binding.chunk_index}/${binding.chunk_count} 张` : '';
}
export function sourceCardTitle(title, fields) {
  const binding = fields?.sourceCardBinding;
  return binding ? `${title.replace(/｜第 \d+\/\d+ 张$/, '')}｜第 ${binding.chunk_index}/${binding.chunk_count} 张` : title;
}
