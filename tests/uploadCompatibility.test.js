import test from 'node:test';
import assert from 'node:assert/strict';
import { isImageFile } from '../src/utils/compressImage.js';
import { uploadErrorMessage } from '../src/utils/uploadErrors.js';

test('mobile image detection accepts files whose browser omitted the MIME type', () => {
  const jpeg = { name: 'IMG_6081.JPG', type: '', size: 1024 };

  assert.equal(isImageFile(jpeg), true);
  assert.equal(isImageFile({ name: 'notes.txt', type: '', size: 12 }), false);
});

test('upload errors explain expired sessions and unsupported mobile images', () => {
  assert.equal(uploadErrorMessage(401, 'Unauthorized'), '登录状态已失效，请重新登录后上传');
  assert.equal(uploadErrorMessage(403, 'Forbidden'), '登录状态已失效，请重新登录后上传');
  assert.equal(uploadErrorMessage(415, ''), '图片格式暂不支持，请在相册中导出为 JPEG 后重试');
  assert.equal(uploadErrorMessage(500, 'Storage unavailable'), 'Storage unavailable');
});
