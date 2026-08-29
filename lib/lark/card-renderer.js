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

function replaceAssigneeLine(content) {
  if (typeof content !== 'string' || !content.includes('已分配给')) {
    return content;
  }
  return content.replace(/已分配给：[-\u2014][^\n]*/, '已分配给：✅ 派单话题已创建');
}

function dispatchedNote(requestId, dispatchedAt) {
  return {
    tag: 'markdown',
    content: `${DISPATCH_DONE_PREFIX} ${requestId}：派单话题已创建（${dispatchedAt}），按钮已锁定，请勿重复点击。`,
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
export function patchCardForDispatched(card, { requestId, threadMessageId, dispatchedAt }) {
  if (!card || typeof card !== 'object' || card.schema !== '2.0' || !Array.isArray(card.body?.elements)) {
    return { patched: false };
  }

  const cloned = deepClone(card);
  let found = false;

  walkElements(cloned.body.elements, (element) => {
    if (element.tag === 'markdown') {
      element.content = replaceAssigneeLine(element.content);
    }
    if (buttonMatchesRequest(element, requestId)) {
      found = true;
      element.disabled = true;
      element.disabled_tip = { tag: 'plain_text', content: '该需求已创建派单话题' };
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
