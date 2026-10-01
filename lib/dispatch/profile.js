export const DISPATCH_PROFILE = Object.freeze({
  DEFAULT: 'default',
  AD: 'ad',
});

export const AD_TARGET_CATEGORIES = Object.freeze([
  'ad',
  'game_agent',
  'qianchuan_ad',
  'ehc_emergency_ad',
]);

const AD_TARGET_CATEGORY_SET = new Set(AD_TARGET_CATEGORIES);

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isAdBusinessType(businessType) {
  return ['ad', '广告'].includes(normalized(businessType));
}

export function isAdTargetCategory(targetCategory) {
  return AD_TARGET_CATEGORY_SET.has(normalized(targetCategory));
}

/**
 * Resolve the server-owned dispatch policy. Callers may select a named profile,
 * but never provide scope or direction directly.
 *
 * Old cards have no dispatch_profile. They remain compatible by inferring AD
 * from the historical business/category fields; a blank category is accepted
 * for the oldest AD cards. Explicit profiles are fail-closed.
 */
export function resolveDispatchProfile({ dispatchProfile, businessType, targetCategory } = {}) {
  const rawProfile = normalized(dispatchProfile);
  const explicit = rawProfile !== '';
  const businessIsAd = isAdBusinessType(businessType);
  const category = normalized(targetCategory);
  const categoryIsAd = isAdTargetCategory(category);

  if (explicit && !['legacy', DISPATCH_PROFILE.DEFAULT, DISPATCH_PROFILE.AD].includes(rawProfile)) {
    return { errorCode: 'INVALID_DISPATCH_PROFILE', errorMessage: '派单 profile 不受支持' };
  }

  if (explicit) {
    const requested = rawProfile === 'legacy' ? DISPATCH_PROFILE.DEFAULT : rawProfile;
    const validAdIdentity = businessIsAd && categoryIsAd;
    const defaultConflictsWithAdHint = requested === DISPATCH_PROFILE.DEFAULT
      && (businessIsAd || categoryIsAd);
    if ((requested === DISPATCH_PROFILE.AD && !validAdIdentity) || defaultConflictsWithAdHint) {
      return {
        errorCode: 'DISPATCH_PROFILE_MISMATCH',
        errorMessage: '派单 profile 与业务类型或目标分类不一致',
      };
    }
    return policy(requested, businessType);
  }

  // Compatibility for old cards: known AD categories and category-less AD
  // payloads share the AD roster. Contradictory old hints do not gain AD scope.
  const inferred = businessIsAd && (categoryIsAd || !category)
    ? DISPATCH_PROFILE.AD
    : DISPATCH_PROFILE.DEFAULT;
  return policy(inferred, businessType);
}

function policy(name, businessType) {
  if (name === DISPATCH_PROFILE.AD) {
    return { name, scope: 'ad', direction: 'reverse' };
  }
  const type = normalized(businessType);
  return {
    name: DISPATCH_PROFILE.DEFAULT,
    scope: 'default',
    direction: type === '千川' || type === 'qianchuan' ? 'forward' : 'reverse',
  };
}
