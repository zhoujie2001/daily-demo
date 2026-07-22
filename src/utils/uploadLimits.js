// Vercel Functions reject request bodies larger than 4.5 MB. Keep enough
// headroom for multipart boundaries and request metadata.
export const MAX_UPLOAD_REQUEST_BYTES = Math.floor(3.75 * 1024 * 1024);

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function assertUploadRequestSize(files) {
  const list = Array.isArray(files) ? files : [files];
  const totalBytes = list.reduce((sum, file) => sum + (Number(file?.size) || 0), 0);
  if (totalBytes <= MAX_UPLOAD_REQUEST_BYTES) return;

  throw new Error(
    `文件处理后仍有 ${formatFileSize(totalBytes)}，超过上传服务的安全上限 ${formatFileSize(
      MAX_UPLOAD_REQUEST_BYTES
    )}。请缩短视频或降低文件大小后重试。`
  );
}
