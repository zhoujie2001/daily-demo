export const ABOUT_FILMS = Object.freeze([
  Object.freeze({
    id: 'forty-fourth-sunset',
    src: '/media/about/forty-fourth-sunset.mp4',
    label: '四十四次日落',
  }),
  Object.freeze({
    id: 'drift-bottle',
    src: '/media/about/drift-bottle.mp4',
    label: '漂流瓶寄来的一天',
  }),
]);

const SLOW_CONNECTIONS = new Set(['slow-2g', '2g', '3g']);

export function shouldAutoplayAboutFilm({
  desktop = false,
  reducedMotion = false,
  saveData = false,
  effectiveType = '',
} = {}) {
  return Boolean(
    desktop
      && !reducedMotion
      && !saveData
      && !SLOW_CONNECTIONS.has(effectiveType)
  );
}

export function shouldCrossfadeAboutFilm({
  index,
  currentTime,
  duration,
  leadSeconds = 1.15,
} = {}) {
  if (index !== 0 || !Number.isFinite(currentTime) || !Number.isFinite(duration)) {
    return false;
  }
  return duration > 0 && duration - currentTime <= leadSeconds;
}

export function getAboutFilmProgress(index, currentTime, durations) {
  const safeIndex = Math.max(0, Math.min(index, ABOUT_FILMS.length - 1));
  const elapsedBefore = durations
    .slice(0, safeIndex)
    .reduce((total, duration) => total + Math.max(0, duration || 0), 0);
  const totalDuration = durations.reduce(
    (total, duration) => total + Math.max(0, duration || 0),
    0
  );
  if (!totalDuration) return 0;
  return Math.min(1, Math.max(0, (elapsedBefore + Math.max(0, currentTime || 0)) / totalDuration));
}
