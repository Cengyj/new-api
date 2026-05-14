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

import React, { useEffect, useMemo, useState } from 'react';

import { CreationEmptyState } from './AiCreationShared.jsx';
import { BatchResultFolderCard } from './BatchResultGallery.jsx';
import { TASK_STATUS } from './constants.js';
import {
  CACHE_WARN_MS as IMAGE_CACHE_WARN_MS,
  ensureCachedImageUrl,
  getCachedBlobUrl,
  getCacheRemainingMs as getImageCacheRemainingMs,
  isDataImageUrl,
  isSessionBlobUrl as isSessionImageBlobUrl,
  resolveCachedImageUrl,
} from './imageCache.js';
import {
  CACHE_WARN_MS as VIDEO_CACHE_WARN_MS,
  getCachedBlobUrl as getCachedVideoBlobUrl,
  getCacheRemainingMs as getVideoCacheRemainingMs,
  isSessionBlobUrl as isSessionVideoBlobUrl,
  resolveCachedVideoUrl,
} from './videoCache.js';
import {
  isCreationTaskActive,
  isCreationTaskCancelled,
} from './creationTaskUtils.js';
import { normalizeVideoContentUrl } from './videoAdapters.js';

const CACHE_WARNING_BY_TYPE = {
  image: IMAGE_CACHE_WARN_MS,
  video: VIDEO_CACHE_WARN_MS,
};

const DEFAULT_TRANSLATE = (value, options) => {
  if (!options) return value;
  return Object.entries(options).reduce(
    (text, [key, next]) => text.replace(`{{${key}}}`, String(next)),
    value,
  );
};

const compactPrompt = (prompt) => {
  const text = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > 28 ? `${text.slice(0, 28)}...` : text;
};

const compactErrorLine = (raw) => {
  const text = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
};

export async function downloadCreationAsset(url, filename) {
  if (!url) return false;
  try {
    if (url.startsWith('data:')) {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return true;
    }
    const response = await fetch(url, { credentials: 'omit' });
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
    return true;
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
}

export const getTaskImageSourceUrl = (item = {}) => {
  const url = typeof item.url === 'string' ? item.url : '';
  const remoteUrl = typeof item.remoteUrl === 'string' ? item.remoteUrl : '';
  if (isSessionImageBlobUrl(url)) {
    return isSessionImageBlobUrl(remoteUrl) ? '' : remoteUrl;
  }
  return url || (isSessionImageBlobUrl(remoteUrl) ? '' : remoteUrl);
};

export const getTaskVideoSourceUrl = (item = {}) => {
  const url = typeof item.url === 'string' ? item.url : '';
  const remoteUrl = typeof item.remoteUrl === 'string' ? item.remoteUrl : '';
  if (remoteUrl && !isSessionVideoBlobUrl(remoteUrl)) {
    return normalizeVideoContentUrl(remoteUrl);
  }
  if (isSessionVideoBlobUrl(url)) {
    return normalizeVideoContentUrl(remoteUrl) || url;
  }
  return normalizeVideoContentUrl(
    url || (isSessionVideoBlobUrl(remoteUrl) ? '' : remoteUrl),
  );
};

export const getCreationWorkSourceUrl = (item, mediaType) =>
  mediaType === 'video'
    ? getTaskVideoSourceUrl(item)
    : getTaskImageSourceUrl(item);

export async function resolveCreationWorkAssetUrl(item, mediaType = 'image') {
  if (!item || item.status !== TASK_STATUS.SUCCESS) return '';
  const sourceUrl = getCreationWorkSourceUrl(item, mediaType);
  if (!sourceUrl) {
    return mediaType === 'video'
      ? (await getCachedVideoBlobUrl(item.id)) || ''
      : (await getCachedBlobUrl(item.id)) || '';
  }

  try {
    const result =
      mediaType === 'video'
        ? await resolveCachedVideoUrl(item.id, sourceUrl)
        : await resolveCachedImageUrl(item.id, sourceUrl);
    return result?.url || '';
  } catch {
    if (
      mediaType === 'image' &&
      (isDataImageUrl(sourceUrl) || !isSessionImageBlobUrl(sourceUrl))
    ) {
      return sourceUrl;
    }
    if (mediaType === 'video' && !isSessionVideoBlobUrl(sourceUrl)) {
      return sourceUrl;
    }
    return '';
  }
}

export async function downloadCreationWorkAsset(item, mediaType, displayUrl) {
  const resolvedUrl =
    displayUrl || (await resolveCreationWorkAssetUrl(item, mediaType));
  if (!resolvedUrl) return false;
  const extension = mediaType === 'video' ? 'mp4' : 'png';
  await downloadCreationAsset(
    resolvedUrl,
    `${item.model || mediaType}-${item.id}.${extension}`,
  );
  return true;
}

function useRelativeTime(createdAt, t = DEFAULT_TRANSLATE) {
  const fmt = (ts) => {
    if (!ts) return null;
    const sec = ts > 1e10 ? ts / 1000 : ts;
    const diff = Date.now() / 1000 - sec;
    if (diff < 60) return null;
    if (diff < 3600) {
      return t('{{count}}分钟前', { count: Math.floor(diff / 60) });
    }
    if (diff < 86400) {
      return t('{{count}}小时前', { count: Math.floor(diff / 3600) });
    }
    if (diff < 172800) return t('昨天');
    return new Date(sec * 1000).toLocaleDateString();
  };
  const [label, setLabel] = useState(() => fmt(createdAt));

  useEffect(() => {
    setLabel(fmt(createdAt));
    const id = setInterval(() => setLabel(fmt(createdAt)), 60000);
    return () => clearInterval(id);
  }, [createdAt, t]);

  return label;
}

function useImageDisplayUrl(item, enabled) {
  const sourceUrl = enabled ? getTaskImageSourceUrl(item) : '';
  const [displayUrl, setDisplayUrl] = useState(
    enabled && isDataImageUrl(sourceUrl) ? sourceUrl : '',
  );
  const [cacheWarning, setCacheWarning] = useState(null);

  useEffect(() => {
    setCacheWarning(null);
    if (!enabled || item?.status !== TASK_STATUS.SUCCESS) {
      setDisplayUrl('');
      return undefined;
    }

    if (isDataImageUrl(sourceUrl)) {
      setDisplayUrl(sourceUrl || '');
      return undefined;
    }

    let cancelled = false;
    Promise.all([
      getCachedBlobUrl(item.id),
      getImageCacheRemainingMs(item.id),
    ]).then(async ([blobUrl, remainingMs]) => {
      if (cancelled) return;
      if (blobUrl) {
        setDisplayUrl(blobUrl);
      } else {
        const nextBlobUrl = await ensureCachedImageUrl(item.id, sourceUrl);
        if (cancelled) return;
        if (nextBlobUrl) {
          setDisplayUrl(nextBlobUrl);
        } else {
          setDisplayUrl(isSessionImageBlobUrl(sourceUrl) ? '' : sourceUrl);
        }
      }
      if (remainingMs !== null && remainingMs < CACHE_WARNING_BY_TYPE.image) {
        setCacheWarning(remainingMs);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, item?.id, item?.status, sourceUrl]);

  return { displayUrl, sourceUrl, cacheWarning };
}

export function useCachedVideoDisplayUrl(task, enabled = true) {
  const sourceUrl = enabled ? getTaskVideoSourceUrl(task) : '';
  const [displayUrl, setDisplayUrl] = useState(() =>
    enabled && isSessionVideoBlobUrl(sourceUrl) ? sourceUrl : '',
  );

  useEffect(() => {
    if (!enabled || !sourceUrl) {
      setDisplayUrl('');
      return undefined;
    }

    let cancelled = false;
    resolveCachedVideoUrl(task?.id, sourceUrl)
      .then(({ url }) => {
        if (!cancelled) setDisplayUrl(url || '');
      })
      .catch(() => {
        if (!cancelled) {
          setDisplayUrl(isSessionVideoBlobUrl(sourceUrl) ? '' : sourceUrl);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, task?.id, sourceUrl]);

  return displayUrl;
}

function useVideoDisplayUrl(item, enabled) {
  const displayUrl = useCachedVideoDisplayUrl(item, enabled);
  const sourceUrl = enabled ? getTaskVideoSourceUrl(item) : '';
  const [cacheWarning, setCacheWarning] = useState(null);

  useEffect(() => {
    setCacheWarning(null);
    if (!enabled || !item?.id) return undefined;

    let cancelled = false;
    getVideoCacheRemainingMs(item.id).then((remainingMs) => {
      if (cancelled) return;
      if (remainingMs !== null && remainingMs < CACHE_WARNING_BY_TYPE.video) {
        setCacheWarning(remainingMs);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, item?.id]);

  return { displayUrl, sourceUrl, cacheWarning };
}

export function useCreationWorkMedia(item, mediaType = 'image') {
  const imageState = useImageDisplayUrl(item, mediaType === 'image');
  const videoState = useVideoDisplayUrl(item, mediaType === 'video');
  return mediaType === 'video' ? videoState : imageState;
}

function getSingleWorkStatus({ item, isActive, isCancelled, isError, canOpen }) {
  if (isActive) return 'generating';
  if (isCancelled) return 'cancelled';
  if (isError) return 'failed';
  if (canOpen) return 'completed';
  return 'generating';
}

function getSingleWorkLabels(mediaType, t) {
  return {
    open: t('打开结果'),
    select: t('选择'),
    download: mediaType === 'video' ? t('下载原视频') : t('下载原图'),
    delete: t('删除'),
    stop: t('停止'),
    retry: t('重试'),
    error: t('查看错误'),
    failed: t('失败'),
    cancelled: t('已停止'),
    generating: t('生成中'),
    partial: t('部分完成'),
    empty: t('暂无结果'),
    justNow: t('刚刚'),
    untitledPrompt: t('未命名提示词'),
  };
}

export function CreationWorkCard({
  mediaType = 'image',
  item,
  selected,
  selectionMode,
  onToggleSelect,
  onOpen,
  onDelete,
  onCancel,
  onRetry,
  onShowError,
  renderMedia,
  t = DEFAULT_TRANSLATE,
}) {
  const { displayUrl, sourceUrl } = useCreationWorkMedia(item, mediaType);
  const isActive = isCreationTaskActive(item);
  const isCancelled = isCreationTaskCancelled(item);
  const isError = item.status === TASK_STATUS.ERROR && !isCancelled;
  const canOpen =
    item.status === TASK_STATUS.SUCCESS && Boolean(displayUrl || sourceUrl);
  const timeLabel = useRelativeTime(item.created_at, t) || t('刚刚');
  const prompt = compactPrompt(item.prompt) || item.model || t('未命名提示词');
  const errorLine = compactErrorLine(item.error);
  const labels = useMemo(() => getSingleWorkLabels(mediaType, t), [mediaType, t]);
  const status = getSingleWorkStatus({
    item,
    isActive,
    isCancelled,
    isError,
    canOpen,
  });
  const mediaItems = canOpen
    ? [
        {
          ...item,
          url: displayUrl || sourceUrl,
          remoteUrl: sourceUrl,
          displayUrl: displayUrl || sourceUrl,
          task: item,
        },
      ]
    : [];

  const openMedia = async () => {
    if (isError || isCancelled) {
      onShowError?.(item);
      return;
    }
    const url =
      displayUrl || (await resolveCreationWorkAssetUrl(item, mediaType));
    if (!url) return;
    onOpen?.({
      id: item.id,
      url,
      type: mediaType,
      title: item.model || '',
    });
  };

  const renderSingleMedia = (mediaItem, index) => {
    if (renderMedia) {
      return renderMedia({
        item: mediaItem?.task || item,
        displayUrl: mediaItem?.displayUrl || displayUrl || sourceUrl,
        mediaType,
        index,
      });
    }
    const url = mediaItem?.displayUrl || displayUrl || sourceUrl;
    if (!url) return null;
    return mediaType === 'video' ? (
      <video src={url} muted playsInline preload='metadata' />
    ) : (
      <img src={url} alt='' loading='lazy' />
    );
  };

  return (
    <BatchResultFolderCard
      mediaType={mediaType}
      variant='single'
      rowId={item.id}
      title={prompt}
      timeLabel={timeLabel}
      status={status}
      mediaItems={mediaItems}
      totalCount={1}
      completedCount={canOpen ? 1 : 0}
      processingCount={isActive ? 1 : 0}
      failedCount={isError ? 1 : 0}
      cancelledCount={isCancelled ? 1 : 0}
      errorMessage={errorLine || item.error}
      selectionMode={selectionMode}
      selected={selected}
      onToggleSelect={onToggleSelect}
      onOpen={openMedia}
      onDownload={
        canOpen
          ? () => downloadCreationWorkAsset(item, mediaType, displayUrl)
          : undefined
      }
      onCancel={isActive && onCancel ? () => onCancel(item.id) : undefined}
      onRetry={
        (isError || isCancelled) && onRetry ? () => onRetry(item) : undefined
      }
      onShowError={
        (isError || isCancelled) && onShowError
          ? () => onShowError(item)
          : undefined
      }
      onDelete={onDelete ? () => onDelete(item.id) : undefined}
      renderMedia={renderSingleMedia}
      labels={labels}
      canOpenWhenEmpty={Boolean(isError || isCancelled)}
    />
  );
}

export function CreationWorksEmptyState({ icon, children }) {
  return (
    <CreationEmptyState icon={icon} className='ai-creation-gallery__empty'>
      {children}
    </CreationEmptyState>
  );
}
