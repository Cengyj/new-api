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

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import {
  BatchResultActionButton,
  CreationResultPreviewTile,
} from './BatchResultGallery.jsx';
import {
  CREATION_RESULT_GROUP_BATCH_SIZE,
  CREATION_RESULT_GROUP_INITIAL_COUNT,
} from './creationResultGroupAdapters.js';

function getItemStatus(item) {
  return item?.status || 'success';
}

function getPreviewStatus(status) {
  if (status === 'processing' || status === 'pending' || status === 'running') {
    return 'generating';
  }
  return status || 'success';
}

function getResultItemIdentity(item) {
  return item?.task?.id || item?.id;
}

function getResultItemTitle(labels, index) {
  return `${labels.resultItem} #${index + 1}`;
}

const ResultGalleryItem = memo(function ResultGalleryItem({
  item,
  index,
  mediaType,
  labels,
  onPreview,
  onDownloadItem,
  onDeleteItem,
  onShowErrorItem,
  renderThumb,
}) {
  const status = getPreviewStatus(getItemStatus(item));
  const isSuccess = status === 'success';
  const isGenerating = status === 'generating';
  const isFailed = status === 'failed';
  const isCancelled = status === 'cancelled';
  const canPreview = isSuccess && Boolean(onPreview);
  const canDownload = isSuccess && Boolean(onDownloadItem);
  const canDelete = Boolean(onDeleteItem && getResultItemIdentity(item));
  const errorMessage = item?.error || item?.task?.error || '';
  const canShowError = Boolean((isFailed || isCancelled) && onShowErrorItem);
  const itemTitle = getResultItemTitle(labels, index);
  const stateLabel = isFailed
    ? labels.failed
    : isCancelled
      ? labels.cancelled
      : isGenerating
        ? labels.generating
        : labels.completed;

  return (
    <article
      className={clsx(
        'creation-result-group-gallery__item',
        mediaType && `creation-result-group-gallery__item--${mediaType}`,
        status && `is-${status}`,
      )}
    >
      <div className='creation-result-group-gallery__preview'>
        <CreationResultPreviewTile
          mediaType={mediaType}
          item={item}
          index={index}
          status={status}
          renderMedia={renderThumb}
          onPreview={canPreview ? onPreview : undefined}
          emptyLabel={labels.emptyItem}
          loadingLabel={labels.generating}
          labels={labels}
          error={errorMessage}
          useFolderTileClass={false}
        />
        <span
          className={clsx(
            'creation-result-group-gallery__badge',
            `is-${status}`,
          )}
        >
          {stateLabel}
        </span>
      </div>
      <div className='creation-result-group-gallery__item-meta'>
        <span className='creation-result-group-gallery__item-index'>
          #{index + 1}
        </span>
        <p
          className='creation-result-group-gallery__item-title'
          title={itemTitle}
        >
          {itemTitle}
        </p>
        <div className='creation-result-group-gallery__item-actions'>
          {canShowError ? (
            <BatchResultActionButton
              action='error'
              title={errorMessage || labels.error}
              onClick={(event) => {
                event.stopPropagation();
                onShowErrorItem(item, index);
              }}
            />
          ) : null}
          {canDownload ? (
            <BatchResultActionButton
              action='download'
              title={labels.downloadItem}
              onClick={(event) => {
                event.stopPropagation();
                onDownloadItem(item, index);
              }}
            />
          ) : null}
          {canDelete ? (
            <BatchResultActionButton
              action='delete'
              title={labels.deleteItem}
              onClick={(event) => {
                event.stopPropagation();
                onDeleteItem(item, index);
              }}
            />
          ) : null}
        </div>
      </div>
    </article>
  );
});

export default function CreationResultGroupViewer({
  mediaType = 'image',
  items = [],
  title,
  prompt,
  resetKey,
  onPreview,
  onDownloadItem,
  onDeleteItem,
  onShowErrorItem,
  renderThumb,
}) {
  const { t } = useTranslation();
  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);
  const effectiveResetKey =
    resetKey ??
    `${mediaType}:${title || ''}:${items[0]?.task?.id || items[0]?.id || 'empty'}`;
  const [visibleCount, setVisibleCount] = useState(
    CREATION_RESULT_GROUP_INITIAL_COUNT,
  );

  const labels = useMemo(
    () => ({
      download: t('下载'),
      delete: t('删除'),
      generating: t('生成中'),
      open: t('预览'),
      resultItem: t('生成结果'),
      completed: t('成功'),
      failed: t('失败'),
      processing: t('生成中'),
      cancelled: t('已停止'),
      error: t('失败原因'),
      downloadItem: t('下载'),
      deleteItem: t('删除'),
      loadMore: t('加载更多'),
      empty: t('暂无生成结果'),
      emptyItem: t('暂无生成结果'),
    }),
    [t],
  );

  const shownLabel = useMemo(
    () =>
      t('已显示 {{shown}} / {{total}}', {
        shown: Math.min(visibleCount, items.length),
        total: items.length,
      }),
    [items.length, t, visibleCount],
  );

  const visibleItems = useMemo(
    () => items.slice(0, visibleCount),
    [items, visibleCount],
  );
  const hasMore = visibleCount < items.length;

  const loadMore = useCallback(() => {
    setVisibleCount((count) =>
      Math.min(items.length, count + CREATION_RESULT_GROUP_BATCH_SIZE),
    );
  }, [items.length]);

  useEffect(() => {
    setVisibleCount(CREATION_RESULT_GROUP_INITIAL_COUNT);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [effectiveResetKey]);

  useEffect(() => {
    setVisibleCount((count) => {
      if (items.length <= 0) return 0;
      if (count <= 0) {
        return Math.min(CREATION_RESULT_GROUP_INITIAL_COUNT, items.length);
      }
      return Math.min(count, items.length);
    });
  }, [items.length]);

  useEffect(() => {
    if (!hasMore || !sentinelRef.current || !scrollRef.current) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          loadMore();
        }
      },
      {
        root: scrollRef.current,
        rootMargin: '240px 0px',
        threshold: 0,
      },
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  return (
    <div
      className={`creation-result-group-gallery creation-result-group-gallery--${mediaType}`}
    >
      {prompt ? (
        <p className='creation-result-group-gallery__prompt' title={prompt}>
          {prompt}
        </p>
      ) : null}
      <div ref={scrollRef} className='creation-result-group-gallery__body'>
        {visibleItems.length > 0 ? (
          <div className='creation-result-group-gallery__grid'>
            {visibleItems.map((item, index) => (
              <ResultGalleryItem
                key={`${item?.id || item?.task?.id || index}-${index}`}
                item={item}
                index={index}
                mediaType={mediaType}
                labels={labels}
                onPreview={onPreview}
                onDownloadItem={onDownloadItem}
                onDeleteItem={onDeleteItem}
                onShowErrorItem={onShowErrorItem}
                renderThumb={renderThumb}
              />
            ))}
          </div>
        ) : (
          <div className='creation-result-group-gallery__empty'>
            {labels.empty}
          </div>
        )}
        <div className='creation-result-group-gallery__footer'>
          <span>{shownLabel}</span>
          {hasMore ? (
            <button
              ref={sentinelRef}
              type='button'
              className='creation-result-group-gallery__load-more'
              onClick={loadMore}
            >
              {labels.loadMore}
            </button>
          ) : (
            <span
              ref={sentinelRef}
              className='creation-result-group-gallery__sentinel'
            />
          )}
        </div>
      </div>
    </div>
  );
}
