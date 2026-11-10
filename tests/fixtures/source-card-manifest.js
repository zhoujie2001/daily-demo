import { AD_DISPATCH_CHAT_ID } from '../../lib/dispatch/ingest.js';
import { sourceCardManifestHash } from '../../lib/dispatch/source-card-manifest.js';

export function sourceCardFixture(total = 78, source = `game_source_${total}`) {
  const items = Array.from({ length: total }, (_, index) => ({
    request_id: `game_${index + 1}`, request_name: `游戏需求 ${index + 1}`,
    business_type: 'AD', target_category: 'game_agent', dispatch_profile: 'ad',
    sheet_url: 'https://example.feishu.cn/sheets/game', sheet_id: 'gameSheet',
    row_index: index + 2, date_field_id: 'J', assignee_field_id: 'B',
  }));
  const chunks = Array.from({ length: Math.ceil(total / 20) }, (_, index) => {
    const part = items.slice(index * 20, (index + 1) * 20);
    return { chunk_index: index + 1, batch_id: `${source}_card_${index + 1}`,
      item_count: part.length, request_ids: part.map((item) => item.request_id) };
  });
  const manifest = { version: 1, source_batch_id: source, chat_id: AD_DISPATCH_CHAT_ID,
    dispatch_profile: 'ad', target_category: 'game_agent', total_item_count: total,
    chunk_count: chunks.length, chunks };
  manifest.manifest_hash = sourceCardManifestHash(manifest);
  const deliveries = chunks.map((chunk, index) => ({
    chat_id: AD_DISPATCH_CHAT_ID, dispatch_profile: 'ad', batch_id: chunk.batch_id,
    source_card_chunk_index: chunk.chunk_index, source_card_manifest: structuredClone(manifest),
    items: structuredClone(items.slice(index * 20, (index + 1) * 20)),
  }));
  return { manifest, deliveries };
}
