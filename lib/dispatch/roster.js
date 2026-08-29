import { randomInt } from 'node:crypto';

const PURE_NUMBER = /^\d+$/;
const NAME_PATTERN = /^[\p{Script=Han}A-Za-z·•.\-\s]{2,40}$/u;

export class RosterValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RosterValidationError';
    this.code = 'INVALID_ROSTER';
  }
}

export function parseRoster(input) {
  const source = String(input ?? '').trim();
  const names = source.split(/[,，、;；\n\r]+/u).map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) throw new RosterValidationError('请输入当天在班人员真实姓名');
  if (names.length > 100) throw new RosterValidationError('在班人员不能超过 100 人');
  for (const name of names) {
    if (PURE_NUMBER.test(name) || !NAME_PATTERN.test(name)) {
      throw new RosterValidationError(`“${name.slice(0, 20)}”不是有效真实姓名，请勿填写工号或纯数字`);
    }
  }
  const unique = [...new Set(names)];
  if (unique.length !== names.length) throw new RosterValidationError('名单中存在重复姓名，请去重后提交');
  return unique;
}

export function secureShuffle(names, randomIntImpl = randomInt) {
  const result = [...names];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomIntImpl(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function shanghaiDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function nextShanghaiMidnight(date = new Date()) {
  const day = shanghaiDay(date);
  const [year, month, dateOfMonth] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, dateOfMonth + 1) - 8 * 60 * 60 * 1000).toISOString();
}

export function dispatchDirection(businessType) {
  return String(businessType).trim() === '千川' ? 'forward' : 'reverse';
}
