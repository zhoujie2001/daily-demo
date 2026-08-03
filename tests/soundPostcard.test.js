import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  SOUND_POSTCARD_MAX_SECONDS,
  SOUND_POSTCARD_MIN_SECONDS,
  chooseRecorderMimeType,
  extensionForAudioMime,
  formatSoundDuration,
  isSoundPostcardFile,
  validateSoundPostcard,
} from '../src/utils/soundPostcard.js';

const root = new URL('../', import.meta.url);

test('homepage uses the Chinese brand title', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  assert.match(html, /<title>四十四次日落<\/title>/);
  assert.doesNotMatch(html, /<title>Dylan - Personal Site<\/title>/);
});

test('sound postcards accept common mobile audio names and format durations', () => {
  assert.equal(isSoundPostcardFile({ name: 'rain.m4a', type: '' }), true);
  assert.equal(isSoundPostcardFile({ name: 'street.bin', type: 'audio/webm' }), true);
  assert.equal(isSoundPostcardFile({ name: 'photo.jpg', type: 'image/jpeg' }), false);
  assert.equal(formatSoundDuration(0), '0:00');
  assert.equal(formatSoundDuration(29.6), '0:30');
  assert.equal(formatSoundDuration(61), '1:01');
});

test('sound postcard duration stays between ten and thirty seconds', () => {
  const file = { name: 'sea.mp3', type: 'audio/mpeg', size: 1024 };
  assert.equal(validateSoundPostcard(file, SOUND_POSTCARD_MIN_SECONDS), SOUND_POSTCARD_MIN_SECONDS);
  assert.equal(validateSoundPostcard(file, SOUND_POSTCARD_MAX_SECONDS), SOUND_POSTCARD_MAX_SECONDS);
  assert.throws(() => validateSoundPostcard(file, 8), /至少需要 10 秒/);
  assert.throws(() => validateSoundPostcard(file, 32), /最长只能录制 30 秒/);
  assert.throws(
    () => validateSoundPostcard({ ...file, size: 4 * 1024 * 1024 }, 20),
    /超过上传上限/
  );
});

test('recorder chooses a supported mobile-friendly format', () => {
  const Recorder = {
    isTypeSupported: (type) => type === 'audio/webm;codecs=opus',
  };
  assert.equal(chooseRecorderMimeType(Recorder), 'audio/webm;codecs=opus');
  assert.equal(extensionForAudioMime('audio/mp4;codecs=mp4a.40.2'), 'm4a');
  assert.equal(extensionForAudioMime('audio/webm;codecs=opus'), 'webm');
});

test('Daily wires sound selection, persistence and the accessible player', async () => {
  const [daily, editor, hook, media, player, composer] = await Promise.all([
    readFile(new URL('src/components/daily/Daily.jsx', root), 'utf8'),
    readFile(new URL('src/components/daily/DailyEditor.jsx', root), 'utf8'),
    readFile(new URL('src/hooks/useDiary.js', root), 'utf8'),
    readFile(new URL('src/components/daily/DailyMedia.jsx', root), 'utf8'),
    readFile(new URL('src/components/daily/SoundPostcard.jsx', root), 'utf8'),
    readFile(new URL('src/components/daily/SoundPostcardComposer.jsx', root), 'utf8'),
  ]);

  assert.match(daily, /inspectSoundPostcard/);
  assert.match(daily, /handleSoundFileSelected/);
  assert.match(editor, />声音</);
  assert.match(editor, /SoundPostcardComposer/);
  assert.match(hook, /att\.type === 'audio'/);
  assert.match(hook, /visualAttachmentCount/);
  assert.match(media, /soundMedia/);
  assert.match(media, /<SoundPostcard/);
  assert.match(player, /aria-label=\{playing \? '暂停声音明信片' : '播放声音明信片'\}/);
  assert.match(player, /preload="metadata"/);
  assert.match(composer, /getUserMedia/);
  assert.match(composer, /SOUND_POSTCARD_MAX_SECONDS/);
});
