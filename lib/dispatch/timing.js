const REQUIRED_METRICS = Object.freeze(['auth', 'cache', 'database', 'queue']);

function metricName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'unknown';
}

export function createServerTiming(res, now = () => Date.now()) {
  const startedAt = now();
  const metrics = [];
  return {
    measure(name, phaseStartedAt) {
      metrics.push(`${metricName(name)};dur=${Math.max(0, now() - phaseStartedAt)}`);
    },
    mark(name, durationMs) {
      metrics.push(`${metricName(name)};dur=${Math.max(0, Number(durationMs) || 0)}`);
    },
    flush() {
      const withoutTotal = metrics.filter((metric) => !metric.startsWith('total;'));
      const measuredNames = new Set(withoutTotal.map((metric) => metric.split(';', 1)[0]));
      const required = REQUIRED_METRICS
        .filter((name) => !measuredNames.has(name))
        .map((name) => `${name};dur=0`);
      res.setHeader('Server-Timing', [...withoutTotal, ...required, `total;dur=${Math.max(0, now() - startedAt)}`].join(', '));
    },
  };
}
