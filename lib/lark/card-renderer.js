// Renders the dispatch thread message and patches the original Card 2.0
// JSON to reflect the succeeded state (greyed-out button + result note).

export const DISPATCH_DONE_PREFIX = '✅ **已派单**｜需求';
const DISPATCHED_BUTTON_TEXT = '✅ 已派单';

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function walkElements(elements, visit) {
  if (!Array.isArray(elements)) {
    return;
  }
  for (const element of elements) {
    if (!element || typeof element !== 'object') {
      continue;
    }
    visit(element);
    if (Array.isArray(element.elements)) {
      walkElements(element.elements, visit);
    }
    if (Array.isArray(element.columns)) {
      for (const column of element.columns) {
        if (column && Array.isArray(column.elements)) {
          walkElements(column.elements, visit);
        }
      }
    }
  }
}

function buttonMatchesRequest(button, requestId) {
  if (!button || button.tag !== 'button') {
    return false;
  }
  if (typeof button.element_id === 'string' && button.element_id === `dsp_${requestId}`) {
    return true;
  }
  const behaviors = Array.isArray(button.behaviors) ? button.behaviors : [];
  return behaviors.some(
    (behavior) =>
      behavior?.type === 'callback'
      && String(behavior.value?.request_id ?? '').trim() === String(requestId),
  );
}

function replaceAssigneeLine(content, assignee) {
  if (typeof content !== 'string' || !content.includes('已分配给')) return content;
  return content.replace(/已分配给：[^\n]*/, `已分配给：✅ ${assignee || '派单话题已创建'}`);
}

function dispatchedNote(requestId, dispatchedAt) {
  return {
    tag: 'markdown',
    content: `${DISPATCH_DONE_PREFIX} ${requestId}：派单话题已创建（${dispatchedAt}），按钮已锁定，请勿重复点击。`,
  };
}

export function buildInitialDispatchCard(fields, actionValue) {
  const details = [
    `**需求 ${fields.requestId}｜${fields.requestName}**`,
    `- 业务类型：${fields.businessType}`,
    '- 已分配给：-',
  ];
  if (fields.rowIndex) details.push(`- 填入行：第 ${fields.rowIndex} 行`);
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: fields.cardTitle || `【${fields.businessType}】新增回扫需求` },
      template: fields.businessType === '千川' ? 'yellow' : 'blue',
    },
    body: { elements: [
      { tag: 'markdown', content: details.join('\n') },
      {
        tag: 'button',
        element_id: `dsp_${fields.requestId}`,
        text: { tag: 'plain_text', content: '🎯 自动派单' },
        type: 'primary_filled',
        behaviors: [{ type: 'callback', value: actionValue }],
      },
    ] },
  };
}

export function buildBatchDispatchCard(fieldsList, actionValue, { cardTitle, batchId, period = {} } = {}) {
  const first = fieldsList[0];
  const segment = period.segment || '';
  const windowLabel = period.windowStart && period.windowEnd
    ? `（${period.windowStart} ~ ${period.windowEnd} CST）`
    : '';
  const resolvedTitle = segment
    ? `【${first.businessType}】${segment}新增 ${fieldsList.length} 条｜批量自动派单${windowLabel}`
    : `${cardTitle || `【${first.businessType}】批量自动派单`}｜新增 ${fieldsList.length} 条`;
  const periodText = segment ? `${segment}需求` : '需求';
  const elements = [
    { tag: 'markdown', content: `共 **${fieldsList.length}** 条 ${periodText}，点击一次将按顺序处理全部需求。\n批次：${batchId || '-'}` },
    ...fieldsList.flatMap((fields, index) => [
      ...(index > 0 ? [{ tag: 'hr' }] : []),
      { tag: 'markdown', content: `**需求 ${fields.requestId}｜${fields.requestName}**\n- 业务类型：${fields.businessType}\n- 状态：READY${fields.rowIndex ? `\n- 填入行：第 ${fields.rowIndex} 行` : ''}` },
    ]),
    {
      tag: 'button',
      element_id: `batch_${batchId || 'dispatch'}`,
      text: { tag: 'plain_text', content: '🎯 批量自动派单' },
      type: 'primary_filled',
      behaviors: [{ type: 'callback', value: actionValue }],
    },
  ];
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: resolvedTitle },
      template: first.businessType === '千川' ? 'yellow' : 'blue',
    },
    body: { elements },
  };
}

const BATCH_STATUS_LABEL = {
  READY: '待处理', PROCESSING: '处理中', SUCCESS: '成功', PARTIAL: '部分成功', FAILED: '失败',
};

export function buildBatchStatusCard(fieldsList, {
  batchId, status, results = [], cardTitle, resumable = false, retryAction,
} = {}) {
  const resultMap = new Map(results.map((result) => [result.requestId, result]));
  const completed = results.filter((item) => item.status === 'SUCCESS').length;
  const elements = [{
    tag: 'markdown',
    content: `**批次状态：${status}（${BATCH_STATUS_LABEL[status] || status}）**\n批次：${batchId}\n进度：${results.length}/${fieldsList.length}，成功 ${completed} 条，失败 ${results.length - completed} 条`,
  }];
  fieldsList.forEach((fields) => {
    const result = resultMap.get(fields.requestId);
    const itemStatus = result?.status || (status === 'PROCESSING' ? 'PROCESSING' : 'READY');
    const detail = result?.assignee ? `，负责人：${result.assignee}` : result?.message ? `，原因：${result.message}` : '';
    elements.push({ tag: 'markdown', content: `- **${fields.requestId}｜${fields.requestName}**：${itemStatus}${detail}` });
  });
  if (resumable) {
    const retryingFailure = status === 'FAILED' || status === 'PARTIAL';
    elements.push({
      tag: 'markdown',
      content: retryingFailure
        ? '**派单未全部成功，可重试**：点击下方按钮仅补偿失败项，已成功项不会重复派单。'
        : '**处理中，可重试继续**：本轮已在安全截止时间前暂停，点击下方按钮可由同一批次继续未完成项。',
    });
  }
  elements.push({
    tag: 'button', element_id: `batch_${batchId}`,
    text: {
      tag: 'plain_text',
      content: resumable
        ? (status === 'FAILED' || status === 'PARTIAL' ? '🔄 重试失败项' : '▶️ 继续批量自动派单')
        : status === 'PROCESSING' ? '⏳ 批量派单处理中' : '✅ 批量派单已完成',
    },
    type: resumable ? 'primary' : 'default', disabled: !resumable,
    ...(resumable && retryAction ? { value: retryAction } : {}),
    ...(!resumable ? {
      disabled_tips: { tag: 'plain_text', content: status === 'PROCESSING' ? '请求已受理，请勿重复点击' : '该批次已处理' },
    } : {}),
    behaviors: [],
  });
  return {
    schema: '2.0', config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: cardTitle || '批量自动派单' },
      template: status === 'SUCCESS' ? 'green' : status === 'FAILED' ? 'red' : status === 'PARTIAL' ? 'orange' : 'blue',
    },
    body: { elements },
  };
}

export function buildBatchThreadText({ batchId, status, results, dispatchedAt }) {
  const lines = [`📋 批量自动派单结果｜${BATCH_STATUS_LABEL[status] || status}`, `批次：${batchId}`, `完成时间：${dispatchedAt}`];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.requestId}｜${result.requestName}：${result.status}${result.assignee ? `｜负责人 ${result.assignee}` : `｜${result.message || '派单失败'}`}`);
  });
  return lines.join('\n');
}

export function buildBatchDispatchResultCard(fieldsList, {
  batchId, status, results = [], roster = [], direction, dispatchedAt, cardTitle, replacementNotice,
} = {}) {
  const resultMap = new Map(results.map((result) => [result.requestId, result]));
  const directionLabel = direction === 'forward' ? '正序（从上到下）' : '倒序（从下到上）';
  const currentAssignee = [...results].reverse()
    .find((result) => result.status === 'SUCCESS' && result.assignee)?.assignee || '';
  const rosterNames = Array.isArray(roster) ? roster : [];
  const rosterContent = (names, listDirection) => names.map((name, index) => {
    const marker = name === currentAssignee && direction === listDirection ? ' **← 当前人员**' : '';
    return `${index + 1}. ${name}${marker}`;
  }).join('\n') || '-';
  const rows = fieldsList.map((fields, index) => {
    const result = resultMap.get(fields.requestId);
    return {
      dispatch_order: String(index + 1),
      request_id: String(fields.requestId),
      request_name: fields.requestName,
      assignee: result?.status === 'SUCCESS' ? result.assignee || '-' : '-',
    };
  });

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: cardTitle || '批量自动派单名单' },
      template: status === 'SUCCESS' ? 'green' : status === 'FAILED' ? 'red' : 'orange',
    },
    body: { elements: [
      ...(replacementNotice ? [{ tag: 'markdown', content: `⚠️ **${replacementNotice}**` }] : []),
      { tag: 'markdown', content: `**批次状态：${status}（${BATCH_STATUS_LABEL[status] || status}）**\n批次：${batchId}\n派单排序：${directionLabel}\n完成时间：${dispatchedAt}` },
      {
        tag: 'table',
        page_size: Math.max(1, Math.min(rows.length, 10)),
        row_height: 'low',
        columns: [
          { name: 'dispatch_order', display_name: '派单顺序', data_type: 'text', width: 'auto' },
          { name: 'request_id', display_name: '需求 ID', data_type: 'text', width: 'auto' },
          { name: 'request_name', display_name: '需求名称', data_type: 'text', width: 'auto' },
          { name: 'assignee', display_name: '负责人', data_type: 'text', width: 'auto' },
        ],
        rows,
      },
      { tag: 'hr' },
      { tag: 'column_set', columns: [
        {
          tag: 'column', width: 'weighted', weight: 1,
          elements: [{ tag: 'markdown', content: `🟡 **千川正序名单（从上到下）**\n${rosterContent(rosterNames, 'forward')}` }],
        },
        {
          tag: 'column', width: 'weighted', weight: 1,
          elements: [{ tag: 'markdown', content: `🔵 **本地倒序名单（从下到上）**\n${rosterContent([...rosterNames].reverse(), 'reverse')}` }],
        },
      ] },
    ] },
  };
}

// The message-read API returns a compact, display-only representation for
// interactive cards instead of the original Card JSON 2.0 payload. Build a
// safe replacement from the signed callback value when the original card
// therefore cannot be patched in place.
export function buildDispatchedCard(fields, { dispatchedAt, assignee } = {}) {
  const details = [
    `**需求 ${fields.requestId}｜${fields.requestName}**`,
    `- 业务类型：${fields.businessType}`,
    `- 已分配给：✅ ${assignee || '派单话题已创建'}`,
  ];
  if (fields.rowIndex) {
    details.push(`- 填入行：第 ${fields.rowIndex} 行`);
  }

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: fields.cardTitle || '自动派单' },
      template: 'green',
    },
    body: {
      elements: [
        { tag: 'markdown', content: details.join('\n') },
        dispatchedNote(fields.requestId, dispatchedAt),
        {
          tag: 'button',
          element_id: `dsp_${fields.requestId}`,
          text: { tag: 'plain_text', content: DISPATCHED_BUTTON_TEXT },
          type: 'default',
          disabled: true,
          disabled_tips: { tag: 'plain_text', content: '该需求已创建派单话题' },
          behaviors: [],
        },
      ],
    },
  };
}

function noteAlreadyExists(elements, requestId) {
  let exists = false;
  walkElements(elements, (element) => {
    if (
      element.tag === 'markdown'
      && typeof element.content === 'string'
      && element.content.includes(`${DISPATCH_DONE_PREFIX} ${requestId}`)
    ) {
      exists = true;
    }
  });
  return exists;
}

// Returns { patched: true, card } when the target button was found and
// disabled, or { patched: false } when the card does not contain the button
// (e.g. an older card revision). Never throws on unexpected shapes.
export function patchCardForDispatched(card, { requestId, threadMessageId, dispatchedAt, assignee }) {
  if (!card || typeof card !== 'object' || card.schema !== '2.0' || !Array.isArray(card.body?.elements)) {
    return { patched: false };
  }

  const cloned = deepClone(card);
  let found = false;

  let targetTop = null;
  for (const top of cloned.body.elements) {
    let containsButton = false;
    walkElements([top], (element) => {
      if (buttonMatchesRequest(element, requestId)) containsButton = true;
    });
    if (containsButton) {
      targetTop = top;
      break;
    }
  }

  if (targetTop) {
    walkElements([targetTop], (element) => {
      if (element.tag === 'markdown') {
        element.content = replaceAssigneeLine(element.content, assignee);
      }
      if (buttonMatchesRequest(element, requestId)) {
        found = true;
        element.disabled = true;
        delete element.disabled_tip;
        element.disabled_tips = { tag: 'plain_text', content: '该需求已创建派单话题' };
        element.type = 'default';
        element.text = { tag: 'plain_text', content: DISPATCHED_BUTTON_TEXT };
        element.behaviors = [];
      }
    });
  }

  if (!found) {
    return { patched: false };
  }

  if (!noteAlreadyExists(cloned.body.elements, requestId)) {
    const note = dispatchedNote(requestId, dispatchedAt);
    let inserted = false;
    for (let i = 0; i < cloned.body.elements.length; i += 1) {
      const top = cloned.body.elements[i];
      let containsButton = false;
      walkElements([top], (element) => {
        if (buttonMatchesRequest(element, requestId)) {
          containsButton = true;
        }
      });
      if (containsButton) {
        cloned.body.elements.splice(i + 1, 0, note);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      cloned.body.elements.push(note);
    }
  }

  return { patched: true, card: cloned, threadMessageId: threadMessageId || '' };
}

// Human-readable summary posted as the first reply in the new thread.
// Never includes technical identifiers beyond the request ID itself.
export function buildDispatchThreadText(fields, { dispatchedAt } = {}) {
  const lines = [
    '📋 自动派单话题已创建',
    `需求 ID：${fields.requestId}`,
    `需求名称：${fields.requestName}`,
    `业务类型：${fields.businessType}`,
  ];
  if (fields.rowIndex) {
    lines.push(`台账行号：第 ${fields.rowIndex} 行`);
  }
  if (fields.cardTitle) {
    lines.push(`来源卡片：${fields.cardTitle}`);
  }
  lines.push(`创建时间：${dispatchedAt}`);
  lines.push('状态：派单话题已创建，请在本话题内跟进接单人分配与台账回填。');
  return lines.join('\n');
}

export function formatDispatchTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(/\//g, '-');
}

function rosterLines(roster, selected) {
  return roster.map((name, index) => {
    const marker = name === selected ? ' **← 本次负责人**' : '';
    return `${index + 1}. ${name}${marker}`;
  }).join('\n');
}

export function buildRosterFormCard(fields) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '初始化今日自动派单名单' }, template: 'yellow' },
    body: { elements: [
      { tag: 'markdown', content: `**${fields.requestName}**（${fields.businessType}）首次派单，请录入今天在班人员。\n支持逗号、顿号、分号或换行分隔；只接受真实姓名，不接受纯数字/工号。` },
      { tag: 'form', name: 'dispatch_roster_form', elements: [
        {
          tag: 'input',
          name: 'roster_names',
          input_type: 'multiline_text',
          required: true,
          placeholder: { tag: 'plain_text', content: '例如：张三、李四、王五' },
          max_length: 1000,
        },
        {
          tag: 'button',
          name: 'dispatch_roster_submit',
          text: { tag: 'plain_text', content: '保存名单并立即派单' },
          type: 'primary_filled',
          form_action_type: 'submit',
        },
      ] },
    ] },
  };
}

export function buildRosterProcessingCard() {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '正在保存名单并派单' }, template: 'blue' },
    body: { elements: [
      { tag: 'markdown', content: '**请求已受理，无需重复点击。**\n正在保存今日名单、写回台账并生成派单结果，完成后本卡片会自动更新。' },
    ] },
  };
}

export function buildRosterCompletedCard(fields, { assignee, direction, dispatchedAt }) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '✅ 名单已保存并完成派单' }, template: 'green' },
    body: { elements: [
      { tag: 'markdown', content: `**需求：** ${fields.requestName}\n**负责人：** ${assignee}\n**派单方向：** ${direction === 'forward' ? '千川正序（从上到下）' : '倒序（从下到上）'}\n**完成时间：** ${dispatchedAt}\n\n名单已保存至今日 24:00，派单结果已写回台账。` },
    ] },
  };
}

export function buildRosterRetryCard(errorMessage = '派单未完成，请重新提交名单') {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '名单保存或派单失败' }, template: 'red' },
    body: { elements: [
      { tag: 'markdown', content: `**${errorMessage}**\n请确认名单均为真实姓名后重新提交；若仍失败，请联系值班同学。` },
      { tag: 'form', name: 'dispatch_roster_retry_form', elements: [
        { tag: 'input', name: 'roster_names', input_type: 'multiline_text', required: true, placeholder: { tag: 'plain_text', content: '请输入真实姓名，支持逗号、顿号、分号或换行分隔' }, max_length: 1000 },
        { tag: 'button', name: 'dispatch_roster_retry_submit', text: { tag: 'plain_text', content: '重新保存名单并派单' }, type: 'primary_filled', form_action_type: 'submit' },
      ] },
    ] },
  };
}

export function buildDispatchResultCard(fields, { assignee, direction, roster, dispatchedAt }) {
  const forward = rosterLines(roster, direction === 'forward' ? assignee : null);
  const reverse = rosterLines([...roster].reverse(), direction === 'reverse' ? assignee : null);
  return {
    schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: `✅ 已派单：${assignee}` }, template: direction === 'forward' ? 'yellow' : 'blue' },
    body: { elements: [
      { tag: 'markdown', content: `**需求：** ${fields.requestName}\n**负责人：** ${assignee}\n**方向：** ${direction === 'forward' ? '千川正序（从上到下）' : '倒序（从下到上）'}\n**时间：** ${dispatchedAt}` },
      { tag: 'hr' },
      { tag: 'column_set', columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `🟡 **正序名单（从上到下）**\n${forward}` }] },
        { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `🔵 **倒序名单（从下到上）**\n${reverse}` }] },
      ] },
    ] },
  };
}
