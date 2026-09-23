import { LOCAL_PROMO_CHAT_ID } from './ingest.js';

const REJECT_REASON_FIELD_NAME = '拒绝理由';

function isPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1;
}

function normalizeCellText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(normalizeCellText).join('').trim();
  if (typeof value === 'object') {
    return normalizeCellText(value.text ?? value.value ?? value.content ?? '');
  }
  return String(value).trim();
}

/**
 * 对本地推群批次中缺失 reject_reason 字段的 item，回查对应台账“拒绝理由”列兜底。
 *
 * 设计要点：
 * - 仅在本地推群生效；缺失或空白字段都回查，避免上游占位空串绕过过滤。
 * - 回查失败必须阻断入队并交给调用方重试，禁止在理由未知时 fail-open 派单。
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
    (item) => !String(item?.reject_reason ?? item?.rejectReason ?? '').trim()
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
        const text = normalizeCellText(raw);
        item.reject_reason = text;
        if (text) enriched.push(String(item.request_id || ''));
      }
    } catch (error) {
      log('error', 'local_promo_reject_reason_lookup_failed', {
        chat_id: LOCAL_PROMO_CHAT_ID,
        sheet_id: group.sheetId,
        request_ids: group.items.map((item) => String(item.request_id || '')),
        error_code: error?.code || error?.apiCode || 'REJECT_REASON_LOOKUP_FAILED',
      });
      throw Object.assign(
        error instanceof Error ? error : new Error('Reject reason lookup failed'),
        { code: 'REJECT_REASON_LOOKUP_FAILED', status: 503 },
      );
    }
  }));

  return enriched;
}
