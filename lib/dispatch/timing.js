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
      res.setHeader('Server-Timing', [...withoutTotal, `total;dur=${Math.max(0, now() - startedAt)}`].join(', '));
    },
  };
}
