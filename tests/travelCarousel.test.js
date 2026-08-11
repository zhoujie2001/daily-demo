import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getTravelItemId,
  getTravelPosterUrl,
  nextTravelIndex,
  normalizeTravelIndex,
} from '../src/utils/travelCarousel.js';

test('wraps controlled travel carousel indexes in both directions', () => {
  assert.equal(normalizeTravelIndex(0, 5), 0);
  assert.equal(normalizeTravelIndex(5, 5), 0);
  assert.equal(normalizeTravelIndex(-1, 5), 4);
  assert.equal(nextTravelIndex(4, 5), 0);
  assert.equal(nextTravelIndex(0, 5, -1), 4);
  assert.equal(nextTravelIndex(3, 0), 0);
});

test('supports current and future poster field names without a migration', () => {
  assert.equal(getTravelPosterUrl({ poster_url: '/poster.webp' }), '/poster.webp');
  assert.equal(getTravelPosterUrl({ thumbnailUrl: '/thumb.webp' }), '/thumb.webp');
  assert.equal(getTravelPosterUrl({ url: '/video.mp4' }), '');
});

test('creates stable ids for persisted and fallback travel items', () => {
  assert.equal(getTravelItemId({ id: 42, url: '/a.mp4' }, 0), '42');
  assert.equal(getTravelItemId({ url: '/a.mp4' }, 0), '/a.mp4');
  assert.equal(getTravelItemId({}, 3), 'travel-3');
});
