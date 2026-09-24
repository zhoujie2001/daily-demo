export function uploadErrorMessage(status, detail = '') {
  if (status === 401 || status === 403) return '登录状态已失效，请重新登录后上传';
  if (status === 413) return '图片处理后仍然过大，请裁剪后重试';
  if (status === 415) return '图片格式暂不支持，请在相册中导出为 JPEG 后重试';
  if (status === 429) return '上传过于频繁，请稍后重试';
  return detail || `文件上传失败（HTTP ${status}）`;
}
