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

  walkElements(cloned.body.elements, (element) => {
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
        { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', text_color: 'yellow', content: `🟡 **正序名单（从上到下）**\n${forward}` }] },
        { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', text_color: 'blue', content: `🔵 **倒序名单（从下到上）**\n${reverse}` }] },
      ] },
    ] },
  };
}
