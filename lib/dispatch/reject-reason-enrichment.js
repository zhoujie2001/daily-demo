import {
  LOCAL_PROMO_CHAT_ID,
  hasLocalPromoRejectReasonField,
} from './ingest.js';

const REJECT_REASON_FIELD_NAME = '拒绝理由';

function isPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1;
}

/**
 * 对本地推群批次中缺失 reject_reason 字段的 item，回查对应台账“拒绝理由”列兜底。
 *
 * 设计要点：
 * - 仅在本地推群生效；只补“字段缺失”的 item，空字符串（确无理由）不回查。
 * - 失败必须 fail-open（只告警不阻断投递），保持与历史行为一致，避免表格抖动时整批不派单。
 * - 同一 sheet_url+sheet_id 的行合并为一次连续区间读取（单批最多 20 行）。
 *
 * 返回新增补到 reject_reason 的 request_id 列表，便于调用方记录日志。
 */
export async function enrichLocalPromoRejectReasons({
  chatId,
  items,
  client,
  log = () => {},
} = {}) {
  if (String(chatId || '').trim() !== LOCAL_PROMO_CHAT_ID) return [];
  if (!Array.isArray(items) || !client) return [];

  const pending = items.filter(
    (item) => !hasLocalPromoRejectReasonField(item)
      && String(item?.sheet_url || '').trim()
      && String(item?.sheet_id || '').trim()
      && isPositiveInteger(item?.row_index),
  );
  if (pending.length === 0) return [];

  // 按 sheet_url + sheet_id 分组
  const groups = new Map();
  for (const item of pending) {
    const key = `${item.sheet_url}::${item.sheet_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        sheetUrl: String(item.sheet_url).trim(),
        sheetId: String(item.sheet_id).trim(),
        items: [],
      });
    }
    groups.get(key).items.push(item);
  }

  const enriched = [];
  await Promise.all([...groups.values()].map(async (group) => {
    try {
      const token = await client.getTenantAccessToken();
      const column = await client.resolveSheetColumn({
        sheetUrl: group.sheetUrl,
        sheetId: group.sheetId,
        fieldName: REJECT_REASON_FIELD_NAME,
        token,
      });
      // 一次读取覆盖本组最小到最大行（单批最多 20 条，区间很短）
      const rows = group.items.map((item) => Number(item.row_index)).sort((a, b) => a - b);
      const minRow = rows[0];
      const maxRow = rows[rows.length - 1];
      const range = `${group.sheetId}!${column}${minRow}:${column}${maxRow}`;
      const values = await client.getSheetValues({ sheetUrl: group.sheetUrl, range });

      for (const item of group.items) {
        const rowIndex = Number(item.row_index);
        const cell = values[rowIndex - minRow];
        const raw = Array.isArray(cell) ? cell[0] : cell;
        const text = String(raw ?? '').trim();
        item.reject_reason = text;
        if (text) enriched.push(String(item.request_id || ''));
      }
    } catch (error) {
      // fail-open：回查失败不阻断派单，但显式记录，避免过滤静默失效。
      log('warn', 'local_promo_reject_reason_lookup_failed', {
        chat_id: LOCAL_PROMO_CHAT_ID,
        sheet_id: group.sheetId,
        request_ids: group.items.map((item) => String(item.request_id || '')),
        error_code: error?.code || error?.apiCode || 'REJECT_REASON_LOOKUP_FAILED',
      });
    }
  }));

  return enriched;
}
