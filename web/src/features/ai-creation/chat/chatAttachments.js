/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

export const CHAT_ATTACHMENT_LIMIT = 8;

const TEXT_CLIPBOARD_TYPES = new Set(['text/plain', 'text/html']);
const IMAGE_FILE_EXTENSIONS = new Set([
  'avif',
  'gif',
  'jpeg',
  'jpg',
  'png',
  'webp',
]);

export const getFileExtension = (fileName = '') => {
  const parts = String(fileName).toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
};

export const getFileIdentity = (file) =>
  [file?.name, file?.type, file?.size, file?.lastModified].join(':');

export const isImageFile = (file) =>
  String(file?.type || '')
    .toLowerCase()
    .startsWith('image/') ||
  IMAGE_FILE_EXTENSIONS.has(getFileExtension(file?.name));

export const getClipboardFiles = (clipboardData) => {
  const seen = new Set();
  const files = [
    ...Array.from(clipboardData?.items || [])
      .filter(
        (item) => item?.kind === 'file' && typeof item.getAsFile === 'function',
      )
      .map((item) => item.getAsFile()),
    ...Array.from(clipboardData?.files || []),
  ].filter(Boolean);

  return files.filter((file) => {
    const identity = getFileIdentity(file);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};

export const getClipboardImageFiles = (clipboardData, files = null) =>
  (files || getClipboardFiles(clipboardData)).filter(isImageFile);

export const hasClipboardText = (clipboardData) =>
  Array.from(clipboardData?.types || []).some((type) =>
    TEXT_CLIPBOARD_TYPES.has(type),
  );

const createAttachmentId = () => {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  return `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const createPreviewUrl = (file) => {
  if (
    !isImageFile(file) ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return '';
  }

  try {
    return URL.createObjectURL(file);
  } catch {
    return '';
  }
};

export const revokeAttachmentPreview = (attachment) => {
  if (
    attachment?.previewUrl &&
    typeof URL !== 'undefined' &&
    typeof URL.revokeObjectURL === 'function'
  ) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
};

export const buildAttachmentRecord = (file) => {
  const extension = getFileExtension(file?.name);
  const kind = isImageFile(file) ? 'image' : 'file';

  return {
    id: createAttachmentId(),
    file,
    name: file?.name || '',
    type: file?.type || '',
    size: Number.isFinite(file?.size) ? file.size : 0,
    lastModified: Number.isFinite(file?.lastModified) ? file.lastModified : 0,
    extension,
    kind,
    status: 'ready',
    previewUrl: kind === 'image' ? createPreviewUrl(file) : '',
  };
};

export const toStoredAttachment = (attachment) => ({
  id: attachment.id,
  name: attachment.name,
  type: attachment.type,
  size: attachment.size,
  lastModified: attachment.lastModified,
  extension: attachment.extension,
  kind: attachment.kind,
  status: attachment.status || 'ready',
});

export const formatFileSize = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export const getAttachmentKindLabel = (attachment, t) => {
  if (attachment?.kind === 'image') return t('图片');
  if (attachment?.extension) return attachment.extension.toUpperCase();
  return t('文件');
};

export const readAttachmentAsDataUrl = (attachment) =>
  new Promise((resolve, reject) => {
    if (!attachment?.file) {
      reject(new Error('attachment file is missing'));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(attachment.file);
  });
