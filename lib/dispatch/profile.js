export const TEST_DISPATCH_CHAT_ID = 'oc_00fc5c981185c2bdfb0af92cc01f874f';

export const DISPATCH_PROFILE = Object.freeze({
  DEFAULT: 'default',
  TEST_DEFAULT: 'test_default',
  AD: 'ad',
});

export const AD_SCOPE = Object.freeze({
  REVIEW: 'ad_review',
  GAME: 'ad_game',
});

export const AD_ISOLATION_PROFILE_PREFIX = Object.freeze({
  REVIEW: 'ad_isolation:',
  GAME: 'ad_game_isolation:',
});

const ISOLATION_RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED_ISOLATION_RUN_IDS = new Set(['ad', 'ad_game']);

export function parseAdIsolationProfile(value) {
  const profile = String(value ?? '');
  const prefix = Object.values(AD_ISOLATION_PROFILE_PREFIX)
    .find((candidate) => profile.startsWith(candidate));
  if (!prefix) return null;
  const runId = profile.slice(prefix.length);
  if (!ISOLATION_RUN_ID_PATTERN.test(runId) || RESERVED_ISOLATION_RUN_IDS.has(runId)) {
    return { errorCode: 'INVALID_AD_ISOLATION_RUN_ID', errorMessage: 'AD 隔离 run_id 格式不正确' };
  }
  return {
    name: `${prefix}${runId}`,
    scope: `${prefix}${runId}`,
    runId,
    lane: prefix === AD_ISOLATION_PROFILE_PREFIX.GAME ? 'game' : 'review',
  };
}

export function isAdIsolationScope(scope) {
  const parsed = parseAdIsolationProfile(scope);
  return Boolean(parsed && !parsed.errorCode && parsed.scope === String(scope ?? ''));
}

export const AD_REVIEW_TARGET_CATEGORIES = Object.freeze([
  'ad',
  'qianchuan_ad',
  'ehc_emergency_ad',
]);
export const AD_GAME_TARGET_CATEGORIES = Object.freeze(['game_agent']);
export const AD_TARGET_CATEGORIES = Object.freeze([
  ...AD_REVIEW_TARGET_CATEGORIES,
  ...AD_GAME_TARGET_CATEGORIES,
]);

const AD_REVIEW_TARGET_CATEGORY_SET = new Set(AD_REVIEW_TARGET_CATEGORIES);
const AD_GAME_TARGET_CATEGORY_SET = new Set(AD_GAME_TARGET_CATEGORIES);
const AD_TARGET_CATEGORY_SET = new Set(AD_TARGET_CATEGORIES);
// 应急 AD 需求表「AD回扫专项排查总表2026 / 临时需求」（2026-10-13 切换）。
// AD 复盘线上化（dd8b7a）与游戏货不对板（VTgGZs）使用各自表，不受此切换影响。
const AD_REVIEW_SHARED_SHEET_ID = 'Vp2A6O';

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isAdBusinessType(businessType) {
  return ['ad', '广告'].includes(normalized(businessType));
}

export function isAdTargetCategory(targetCategory) {
  return AD_TARGET_CATEGORY_SET.has(normalized(targetCategory));
}

export function dispatchScopeLabel(scope) {
  if (scope === AD_SCOPE.REVIEW) return 'AD 大盘';
  if (scope === AD_SCOPE.GAME) return '游戏货不对板';
  const isolation = parseAdIsolationProfile(scope);
  if (isolation && !isolation.errorCode) {
    return isolation.lane === 'game' ? '游戏货不对板（隔离）' : 'AD 复盘（隔离）';
  }
  return '默认派单';
}

function inferHistoricalAdCategory({ sheetId, dateFieldId, assigneeFieldId }) {
  const sheet = String(sheetId || '').trim();
  const dateField = String(dateFieldId || '').trim().toUpperCase();
  const assigneeField = String(assigneeFieldId || '').trim().toUpperCase();
  if (sheet === AD_REVIEW_SHARED_SHEET_ID
      && (!dateField || dateField === 'A')
      && (!assigneeField || assigneeField === 'F')) return 'qianchuan_ad';
  return '';
}

function validateAdSheetContract({ category, sheetId, dateFieldId, assigneeFieldId }) {
  const sheet = String(sheetId || '').trim();
  const dateField = String(dateFieldId || '').trim().toUpperCase();
  const assigneeField = String(assigneeFieldId || '').trim().toUpperCase();
  if (!sheet && !dateField && !assigneeField) return true;
  const sharedReviewCategory = ['qianchuan_ad', 'ehc_emergency_ad'].includes(category);

  if (sharedReviewCategory) {
    return sheet === AD_REVIEW_SHARED_SHEET_ID
      && (!dateField || dateField === 'A')
      && (!assigneeField || assigneeField === 'F');
  }
  if (category === 'ad' || category === 'game_agent') {
    // Old AD/game cards used other assignee columns; the service overwrites them
    // with the server-owned B/姓名 contract before any sheet access.
    return sheet !== AD_REVIEW_SHARED_SHEET_ID
      && (!dateField || dateField === 'J');
  }
  return false;
}

/**
 * Resolve the server-owned policy. dispatch_profile may identify the AD policy,
 * but the concrete scope is always derived from target_category (or a unique
 * historical sheet contract); callers can never choose a scope directly.
 */
export function resolveDispatchProfile({
  dispatchProfile, businessType, targetCategory, sheetId, dateFieldId, assigneeFieldId, chatId,
} = {}) {
  const rawProfile = normalized(dispatchProfile);
  const explicit = rawProfile !== '';
  const isolation = parseAdIsolationProfile(dispatchProfile);
  const businessIsAd = isAdBusinessType(businessType);
  const isTestChat = String(chatId || '').trim() === TEST_DISPATCH_CHAT_ID;
  let category = normalized(targetCategory);
  const categoryWasMissing = !category;

  if (isolation?.errorCode) return isolation;
  if (isolation && !isTestChat) {
    return { errorCode: 'AD_ISOLATION_PROFILE_FORBIDDEN', errorMessage: 'AD 隔离 profile 仅允许固定测试群使用' };
  }
  if (explicit && !isolation
      && !['legacy', DISPATCH_PROFILE.DEFAULT, DISPATCH_PROFILE.TEST_DEFAULT, DISPATCH_PROFILE.AD].includes(rawProfile)) {
    return { errorCode: 'INVALID_DISPATCH_PROFILE', errorMessage: '派单 profile 不受支持' };
  }
  if (rawProfile === DISPATCH_PROFILE.TEST_DEFAULT && !isTestChat) {
    return { errorCode: 'TEST_DISPATCH_PROFILE_FORBIDDEN', errorMessage: '测试派单 profile 仅允许测试群使用' };
  }

  if (!category && businessIsAd) {
    category = inferHistoricalAdCategory({ sheetId, dateFieldId, assigneeFieldId });
    if (!category) {
      return {
        errorCode: 'AMBIGUOUS_AD_SCOPE',
        errorMessage: '历史 AD 卡片缺少可判定派单类型的分类或表格契约，已停止派单',
      };
    }
  }

  const categoryIsAd = isAdTargetCategory(category);
  const supplied = explicit
    ? (rawProfile === 'legacy' ? DISPATCH_PROFILE.DEFAULT : rawProfile)
    : (businessIsAd && categoryIsAd ? DISPATCH_PROFILE.AD : DISPATCH_PROFILE.DEFAULT);
  // The callback chat is trusted server context. Old/default cards in the test
  // chat are upgraded to the isolated lane, while payloads from every other
  // chat can never opt into it.
  const requested = isTestChat && !businessIsAd && !categoryIsAd
    ? DISPATCH_PROFILE.TEST_DEFAULT
    : supplied;
  const defaultConflictsWithAdHint = requested === DISPATCH_PROFILE.DEFAULT
    && (businessIsAd || categoryIsAd);
  const testConflictsWithAdHint = requested === DISPATCH_PROFILE.TEST_DEFAULT
    && (businessIsAd || categoryIsAd);
  const isolationLaneMismatch = isolation && (
    !businessIsAd || !categoryIsAd
    || (isolation.lane === 'game') !== AD_GAME_TARGET_CATEGORY_SET.has(category)
  );
  if ((requested === DISPATCH_PROFILE.AD && (!businessIsAd || !categoryIsAd))
      || isolationLaneMismatch || defaultConflictsWithAdHint || testConflictsWithAdHint) {
    return {
      errorCode: 'DISPATCH_PROFILE_MISMATCH',
      errorMessage: '派单 profile 与业务类型或目标分类不一致',
    };
  }

  if (isolation) {
    if (!validateAdSheetContract({ category, sheetId, dateFieldId, assigneeFieldId })) {
      return {
        errorCode: 'AD_SHEET_CONTRACT_MISMATCH',
        errorMessage: 'AD 分类与目标表格或字段契约不一致，已停止派单',
      };
    }
    return {
      name: isolation.name, scope: isolation.scope, direction: 'forward',
      ...(categoryWasMissing ? { resolvedTargetCategory: category } : {}),
    };
  }

  if (requested === DISPATCH_PROFILE.AD) {
    if (!validateAdSheetContract({ category, sheetId, dateFieldId, assigneeFieldId })) {
      return {
        errorCode: 'AD_SHEET_CONTRACT_MISMATCH',
        errorMessage: 'AD 分类与目标表格或字段契约不一致，已停止派单',
      };
    }
    const scope = AD_GAME_TARGET_CATEGORY_SET.has(category) ? AD_SCOPE.GAME : AD_SCOPE.REVIEW;
    return {
      name: DISPATCH_PROFILE.AD, scope,
      direction: category === 'ehc_emergency_ad' ? 'emergency_forward' : 'forward',
      ...(categoryWasMissing ? { resolvedTargetCategory: category } : {}),
    };
  }

  if (requested === DISPATCH_PROFILE.TEST_DEFAULT) {
    const type = normalized(businessType);
    return {
      name: DISPATCH_PROFILE.TEST_DEFAULT,
      scope: DISPATCH_PROFILE.TEST_DEFAULT,
      direction: type === '千川' || type === 'qianchuan' ? 'forward' : 'reverse',
    };
  }

  const type = normalized(businessType);
  return {
    name: DISPATCH_PROFILE.DEFAULT,
    scope: 'default',
    direction: category === 'ehc_emergency' ? 'emergency_forward'
      : type === '千川' || type === 'qianchuan' ? 'forward' : 'reverse',
  };
}
