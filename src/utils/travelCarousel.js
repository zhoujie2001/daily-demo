export function normalizeTravelIndex(index, itemCount) {
  const count = Math.max(0, Number(itemCount) || 0);
  if (!count) return 0;
  const value = Number(index) || 0;
  return ((value % count) + count) % count;
}

export function nextTravelIndex(current, itemCount, direction = 1) {
  return normalizeTravelIndex((Number(current) || 0) + direction, itemCount);
}

export function getTravelPosterUrl(video = {}) {
  return video.poster_url
    || video.posterUrl
    || video.thumbnail_url
    || video.thumbnailUrl
    || '';
}

export function getTravelItemId(video = {}, index = 0) {
  return String(video.id ?? video.url ?? `travel-${index}`);
}
