import { DispatchValidationError } from '../lark/card-actions.js';

export const AD_STATUS_SCOPES = Object.freeze(['ad_review', 'ad_game', 'ad_emergency']);
export const AD_STATUS_SPARSE_MODE = 'preserve-open-snapshot-v1';
export const AD_STATUS_ALL_ON_DUTY = '__BESS_ALL_ON_DUTY_V1__';

const isStringArray = (value) => Array.isArray(value)
  && value.every((item) => typeof item === 'string' && item.trim().length > 0);

export function adStatusFieldShapes(formValue) {
  return Object.fromEntries(AD_STATUS_SCOPES.map((scope) => {
    const field = `${scope}_off_duty`;
    const value = formValue?.[field];
    const shape = !Object.hasOwn(formValue || {}, field) ? 'missing'
      : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    return [field, shape];
  }));
}

export function resolveAdStatusSelections(formValue, context) {
  const sparse = context.statusFormSelectionMode === AD_STATUS_SPARSE_MODE;
  const initial = context.initialAdOffDuty;
  if (sparse && !AD_STATUS_SCOPES.every((scope) => (
    Object.hasOwn(initial || {}, scope) && isStringArray(initial[scope])
    && !initial[scope].includes(AD_STATUS_ALL_ON_DUTY)
  ))) {
    throw new DispatchValidationError('AD_STATUS_FORM_CONTEXT_INVALID',
      '表单缺少打开时的人员状态快照，未修改任何名单；请重新打开表单');
  }
  return Object.fromEntries(AD_STATUS_SCOPES.map((scope) => {
    const field = `${scope}_off_duty`;
    const value = formValue?.[field];
    const omitted = !Object.hasOwn(formValue || {}, field) || value === null || value === '';
    if (omitted && sparse) return [scope, [...initial[scope]]];
    if (omitted || !isStringArray(value)) {
      throw new DispatchValidationError('AD_STATUS_FORM_FIELDS_INVALID',
        '表单名单字段不完整或格式无效，未修改任何名单；请重新打开表单');
    }
    if (value.includes(AD_STATUS_ALL_ON_DUTY)) {
      if (!sparse || value.length !== 1) {
        throw new DispatchValidationError('AD_STATUS_FORM_SELECTION_CONFLICT',
          '“全员在岗”不能与离岗人员同时选择，未修改任何名单；请检查后提交');
      }
      return [scope, []];
    }
    return [scope, [...value]];
  }));
}
