import { shanghaiDay } from './roster.js';

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

function datePartsToDay(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function numericDateToDay(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= 1 && value < 100000) {
    return shanghaiDay(new Date(EXCEL_EPOCH_UTC + Math.floor(value) * 86400000 + 8 * 3600000));
  }
  if (value >= 100000000000) return shanghaiDay(new Date(value));
  if (value >= 1000000000) return shanghaiDay(new Date(value * 1000));
  return null;
}

export function sheetDateDay(value, targetDay) {
  if (typeof value === 'number') return numericDateToDay(value);
  const text = String(value ?? '').trim();
  if (!text) return null;

  const full = text.match(/^(\d{4})[-/]([01]?\d)[-/]([0-3]?\d)(?:[ T].*)?$/);
  if (full) return datePartsToDay(Number(full[1]), Number(full[2]), Number(full[3]));

  const short = text.match(/^([01]?\d)\.([0-3]?\d)(?:[ T].*)?$/);
  if (short) {
    const year = Number(String(targetDay || '').slice(0, 4));
    return datePartsToDay(year, Number(short[1]), Number(short[2]));
  }
  if (/^\d+(?:\.\d+)?$/.test(text)) return numericDateToDay(Number(text));

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : shanghaiDay(parsed);
}

function projectText(value, seen = new Set()) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.map((item) => projectText(item, seen)).filter(Boolean).join(' ');
}

function normalizedProject(value) {
  return projectText(value).replace(/\s+/g, '').toLowerCase();
}

export function projectMatches(value, expectedProject, { allowBlank = false } = {}) {
  const expected = normalizedProject(expectedProject);
  if (!expected) return true;
  const actual = normalizedProject(value);
  if (!actual) return allowBlank;
  if (expected === '本地' || expected === '本地推') {
    return actual.includes('本地推') || actual.includes('本地');
  }
  return actual.includes(expected);
}

export function inspectLatestDailyAnchor(rows, {
  targetDay, roster, projectValue = '', allowBlankProject = false,
}) {
  const allowed = new Set((roster || []).map((name) => String(name).trim()));
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index] || [];
    if (sheetDateDay(row[0], targetDay) !== targetDay) continue;
    if (!projectMatches(row[2], projectValue, { allowBlank: allowBlankProject })) continue;
    const assignee = String(row[1] ?? '').trim();
    if (!assignee) continue;
    if (allowed.has(assignee)) {
      return {
        anchor: assignee, previousAssignee: assignee,
        hasRelevantAssignment: true, invalidAssignee: null,
      };
    }
    // Names outside today's roster are not rotation state. Keep scanning so a
    // newer manual/outdated value cannot hide the closest valid daily anchor.
  }
  return {
    anchor: null, previousAssignee: null,
    hasRelevantAssignment: false, invalidAssignee: null,
  };
}

export function latestDailyAnchor(rows, options) {
  return inspectLatestDailyAnchor(rows, options).anchor;
}
