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

export const ABOUT_FILM_RETRY_DELAYS = Object.freeze([0, 350, 900, 1800]);
export const ABOUT_FILM_STALL_RECOVERY_MS = 1600;
export const ABOUT_FILM_PLAY_ATTEMPT_TIMEOUT_MS = 3500;

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
