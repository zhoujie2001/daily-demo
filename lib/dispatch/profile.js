export const DISPATCH_PROFILE = Object.freeze({
  DEFAULT: 'default',
  AD: 'ad',
});

export const AD_SCOPE = Object.freeze({
  REVIEW: 'ad_review',
  GAME: 'ad_game',
});

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
const AD_REVIEW_SHARED_SHEET_ID = '288afd';

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
  if (scope === AD_SCOPE.REVIEW) return 'AD 复盘';
  if (scope === AD_SCOPE.GAME) return '游戏货不对板';
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
  dispatchProfile, businessType, targetCategory, sheetId, dateFieldId, assigneeFieldId,
} = {}) {
  const rawProfile = normalized(dispatchProfile);
  const explicit = rawProfile !== '';
  const businessIsAd = isAdBusinessType(businessType);
  let category = normalized(targetCategory);
  const categoryWasMissing = !category;

  if (explicit && !['legacy', DISPATCH_PROFILE.DEFAULT, DISPATCH_PROFILE.AD].includes(rawProfile)) {
    return { errorCode: 'INVALID_DISPATCH_PROFILE', errorMessage: '派单 profile 不受支持' };
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
  const requested = explicit
    ? (rawProfile === 'legacy' ? DISPATCH_PROFILE.DEFAULT : rawProfile)
    : (businessIsAd && categoryIsAd ? DISPATCH_PROFILE.AD : DISPATCH_PROFILE.DEFAULT);
  const defaultConflictsWithAdHint = requested === DISPATCH_PROFILE.DEFAULT
    && (businessIsAd || categoryIsAd);
  if ((requested === DISPATCH_PROFILE.AD && (!businessIsAd || !categoryIsAd)) || defaultConflictsWithAdHint) {
    return {
      errorCode: 'DISPATCH_PROFILE_MISMATCH',
      errorMessage: '派单 profile 与业务类型或目标分类不一致',
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
      name: DISPATCH_PROFILE.AD, scope, direction: 'forward',
      ...(categoryWasMissing ? { resolvedTargetCategory: category } : {}),
    };
  }

  const type = normalized(businessType);
  return {
    name: DISPATCH_PROFILE.DEFAULT,
    scope: 'default',
    direction: type === '千川' || type === 'qianchuan' ? 'forward' : 'reverse',
  };
}
