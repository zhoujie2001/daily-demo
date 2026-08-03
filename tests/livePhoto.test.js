import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  formatCapturedAt,
  formatPhotoLocation,
  getPhotoMetadataAvailability,
  normalizePhotoMetadata,
  readJpegPhotoMetadata,
} from '../src/utils/photoMetadata.js';

const root = new URL('../', import.meta.url);

function createExifJpeg() {
  const tiffLength = 238;
  const buffer = new ArrayBuffer(2 + 2 + 2 + 6 + tiffLength + 2);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const tiff = 12;
  const set16 = (offset, value) => view.setUint16(tiff + offset, value, true);
  const set32 = (offset, value) => view.setUint32(tiff + offset, value, true);
  const ascii = (offset, value) => {
    [...`${value}\0`].forEach((character, index) => {
      bytes[tiff + offset + index] = character.charCodeAt(0);
    });
  };
  const entry = (ifdOffset, index, tag, type, count, value, inline = false) => {
    const offset = ifdOffset + 2 + index * 12;
    set16(offset, tag);
    set16(offset + 2, type);
    set32(offset + 4, count);
    if (inline) {
      bytes[tiff + offset + 8] = value.charCodeAt(0);
      bytes[tiff + offset + 9] = 0;
    } else {
      set32(offset + 8, value);
    }
  };
  const rationals = (offset, values) => {
    values.forEach(([numerator, denominator], index) => {
      set32(offset + index * 8, numerator);
      set32(offset + index * 8 + 4, denominator);
    });
  };

  bytes.set([0xff, 0xd8, 0xff, 0xe1], 0);
  view.setUint16(4, 2 + 6 + tiffLength, false);
  bytes.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  bytes[tiff] = 0x49;
  bytes[tiff + 1] = 0x49;
  set16(2, 42);
  set32(4, 8);

  set16(8, 5);
  entry(8, 0, 0x010f, 2, 6, 154);
  entry(8, 1, 0x0110, 2, 10, 160);
  entry(8, 2, 0x0132, 2, 20, 170);
  entry(8, 3, 0x8769, 4, 1, 82);
  entry(8, 4, 0x8825, 4, 1, 100);
  set32(70, 0);

  set16(82, 1);
  entry(82, 0, 0x9003, 2, 20, 170);
  set32(96, 0);

  set16(100, 4);
  entry(100, 0, 0x0001, 2, 2, 'N', true);
  entry(100, 1, 0x0002, 5, 3, 190);
  entry(100, 2, 0x0003, 2, 2, 'E', true);
  entry(100, 3, 0x0004, 5, 3, 214);
  set32(150, 0);

  ascii(154, 'Apple');
  ascii(160, 'iPhone 15');
  ascii(170, '2026:08:03 14:25:30');
  rationals(190, [[31, 1], [13, 1], [492, 10]]);
  rationals(214, [[121, 1], [28, 1], [242, 10]]);
  bytes[buffer.byteLength - 2] = 0xff;
  bytes[buffer.byteLength - 1] = 0xd9;
  return buffer;
}

test('reads embedded capture date, GPS and camera data from JPEG EXIF', () => {
  const metadata = readJpegPhotoMetadata(createExifJpeg());
  assert.equal(metadata.capturedAt, '2026-08-03T14:25:30');
  assert.equal(metadata.make, 'Apple');
  assert.equal(metadata.model, 'iPhone 15');
  assert.ok(Math.abs(metadata.latitude - 31.2303333) < 0.00001);
  assert.ok(Math.abs(metadata.longitude - 121.4733888) < 0.00001);
  assert.equal(formatCapturedAt(metadata.capturedAt), '2026年8月3日 14:25');
  assert.equal(formatPhotoLocation(metadata), '31.23033, 121.47339');
});

test('unavailable metadata stays disabled and cannot be forced visible', () => {
  const metadata = normalizePhotoMetadata({
    showCapturedAt: true,
    showLocation: true,
    showCamera: true,
  });
  assert.deepEqual(getPhotoMetadataAvailability(metadata), {
    capturedAt: false,
    location: false,
    camera: false,
  });
  assert.equal(metadata.showCapturedAt, false);
  assert.equal(metadata.showLocation, false);
  assert.equal(metadata.showCamera, false);
});

test('Daily editor pairs a still image with one motion clip and exposes disabled metadata controls', async () => {
  const [dailySource, editorSource, diarySource] = await Promise.all([
    readFile(new URL('src/components/daily/Daily.jsx', root), 'utf8'),
    readFile(new URL('src/components/daily/DailyEditor.jsx', root), 'utf8'),
    readFile(new URL('src/hooks/useDiary.js', root), 'utf8'),
  ]);

  assert.match(editorSource, /onFilesSelected\(e, 'live-photo'\)/);
  assert.match(editorSource, /选择动态片段/);
  assert.match(editorSource, /disabled=\{!available\}/);
  assert.match(dailySource, /extractPhotoMetadata/);
  assert.match(dailySource, /handleLiveMotionSelect/);
  assert.match(dailySource, /needsCompatibilityTranscode/);
  assert.match(dailySource, /force: needsCompatibilityTranscode/);
  assert.match(diarySource, /uploadedImageUrl/);
  assert.match(diarySource, /uploadedMotionUrl/);
  assert.match(diarySource, /motionUrl/);
});

test('Live Photo rendering supports viewport loading, hover, touch hold, sound lightbox and fallback', async () => {
  const source = await readFile(new URL('src/components/daily/LivePhoto.jsx', root), 'utf8');
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /onPointerEnter/);
  assert.match(source, /onPointerDown/);
  assert.match(source, /window\.setTimeout/);
  assert.match(source, /video\.muted = true/);
  assert.match(source, /activeLivePhotoStop/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /<VideoLightbox/);
  assert.match(source, /setMotionFailed\(true\)/);
});
