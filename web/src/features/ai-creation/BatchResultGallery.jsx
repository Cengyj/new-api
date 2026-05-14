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

import React from 'react';
import clsx from 'clsx';
import {
  CheckSquare,
  CircleStop,
  Download,
  FolderOpen,
  Info,
  Loader2,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import {
  CreationGalleryPanel,
  getCreationGalleryStyle,
} from './CreationGallery.jsx';

export function getBatchResultGalleryStyle(mediaType, overrides = {}) {
  return getCreationGalleryStyle(mediaType, overrides);
}

export function BatchResultGallery({
  mediaType = 'image',
  title,
  meta,
  actions,
  emptyState,
  isEmpty = false,
  gridRef,
  children,
  pagination,
  className,
  style,
}) {
  return (
    <CreationGalleryPanel
      mediaType={mediaType}
      variant='batch'
      title={title}
      caption={meta}
      className={className}
      style={style}
      actions={actions}
      emptyState={emptyState}
      isEmpty={isEmpty}
      gridRef={gridRef}
      pagination={pagination}
    >
      {children}
    </CreationGalleryPanel>
  );
}

export function BatchResultFolderCard({
  mediaType = 'image',
  variant = 'batch',
  rowId,
  title,
  timeLabel,
  status = 'idle',
  mediaItems = [],
  totalCount = 0,
  completedCount = mediaItems.length,
  processingCount = 0,
  failedCount = 0,
  cancelledCount = 0,
  errorMessage = '',
  selectionMode,
  selected,
  onToggleSelect,
  onOpen,
  onDownload,
  onCancel,
  onRetry,
  onShowError,
  onDelete,
  renderMedia,
  labels = {},
  canOpenWhenEmpty = false,
}) {
  const itemCount = mediaItems.length;
  const canOpen = itemCount > 0 || Boolean(canOpenWhenEmpty && onShowError);
  const actionableErrorCount = failedCount + cancelledCount;
  const effectiveTotal = Math.max(
    totalCount || 0,
    itemCount + processingCount + failedCount + cancelledCount,
  );
  const showCount =
    effectiveTotal > 1 ||
    itemCount > 1 ||
    processingCount > 0 ||
    failedCount > 0 ||
    cancelledCount > 0;
  const hasActive = status === 'generating' && Boolean(onCancel);
  const canDownload =
    status !== 'generating' && completedCount > 0 && Boolean(onDownload);
  const hasErrorDetails =
    status !== 'generating' && failedCount > 0 && Boolean(onShowError);
  const canRetry =
    status !== 'generating' && actionableErrorCount > 0 && Boolean(onRetry);
  const downloadTitle =
    status === 'partial'
      ? labels.downloadSuccess || labels.download
      : labels.download;
  const retryTitle =
    status === 'partial' ? labels.retryFailed || labels.retry : labels.retry;

  const toggle = () => onToggleSelect?.(rowId);
  const handleOpen = () => {
    if (selectionMode) {
      toggle();
      return;
    }
    if (itemCount > 0) {
      onOpen?.();
    } else if (canOpenWhenEmpty) {
      onShowError?.();
    }
  };

  return (
    <article
      className={clsx(
        'ai-batch-result-folder',
        mediaType && `ai-batch-result-folder--${mediaType}`,
        variant && `ai-batch-result-folder--${variant}`,
        status && `is-${status}`,
        selectionMode && 'is-selecting',
        selected && 'is-selected',
      )}
    >
      <button
        type='button'
        className='ai-batch-result-folder__media'
        disabled={!selectionMode && !canOpen}
        onClick={handleOpen}
        aria-label={labels.open}
      >
        <BatchResultMediaGrid
          mediaType={mediaType}
          mediaItems={mediaItems}
          renderMedia={renderMedia}
          emptyLabel={labels.empty}
          loading={status === 'generating' && itemCount === 0}
          loadingLabel={labels.generating}
        />
        {showCount ? (
          <span className='ai-batch-result-folder__count'>
            <FolderOpen size={12} />
            {completedCount}/{effectiveTotal || completedCount}
          </span>
        ) : null}
        <BatchResultStatus
          status={status}
          completedCount={completedCount}
          totalCount={effectiveTotal}
          processingCount={processingCount}
          failedCount={failedCount}
          cancelledCount={cancelledCount}
          labels={labels}
        />
      </button>

      <BatchResultMeta
        title={title}
        timeLabel={timeLabel}
        actions={
          <>
            {canDownload ? (
              <BatchResultActionButton
                action='download'
                title={downloadTitle}
                onClick={(event) => {
                  event.stopPropagation();
                  onDownload();
                }}
              />
            ) : null}
            {hasErrorDetails ? (
              <BatchResultActionButton
                action='error'
                title={errorMessage || labels.error}
                onClick={(event) => {
                  event.stopPropagation();
                  onShowError();
                }}
              />
            ) : null}
            {canRetry ? (
              <BatchResultActionButton
                action='retry'
                title={retryTitle}
                onClick={(event) => {
                  event.stopPropagation();
                  onRetry();
                }}
              />
            ) : null}
            {hasActive ? (
              <BatchResultActionButton
                action='stop'
                title={labels.stop}
                onClick={(event) => {
                  event.stopPropagation();
                  onCancel();
                }}
              />
            ) : onDelete ? (
              <BatchResultActionButton
                action='delete'
                title={labels.delete}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete();
                }}
              />
            ) : null}
          </>
        }
        selectionMode={selectionMode}
        selected={selected}
        onToggleSelect={toggle}
        selectLabel={labels.select}
      />
    </article>
  );
}

export function BatchResultActionButton({ action, title, onClick, disabled }) {
  const iconSize = 13;
  const icon =
    action === 'download' ? (
      <Download size={iconSize} />
    ) : action === 'error' ? (
      <Info size={iconSize} />
    ) : action === 'retry' ? (
      <RotateCcw size={iconSize} />
    ) : action === 'stop' ? (
      <CircleStop size={iconSize} />
    ) : (
      <Trash2 size={iconSize} />
    );

  return (
    <button
      type='button'
      className={clsx(
        'ai-batch-result-action',
        action && `ai-batch-result-action--${action}`,
        (action === 'delete' || action === 'stop') &&
          'ai-batch-result-action--danger',
      )}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

export function BatchResultMediaGrid({
  mediaType = 'image',
  mediaItems = [],
  renderMedia,
  emptyLabel,
  loading = false,
  loadingLabel,
}) {
  return (
    <CreationResultPreviewGrid
      mediaType={mediaType}
      mediaItems={mediaItems}
      renderMedia={renderMedia}
      emptyLabel={emptyLabel}
      loading={loading}
      loadingLabel={loadingLabel}
      className={clsx(
        'ai-batch-result-folder__mosaic',
        mediaType && `ai-batch-result-folder__mosaic--${mediaType}`,
      )}
      useFolderTileClass
    />
  );
}

export function CreationResultPreviewGrid({
  mediaType = 'image',
  mediaItems = [],
  renderMedia,
  emptyLabel,
  loading = false,
  loadingLabel,
  labels = {},
  maxItems = 4,
  showOverflow = true,
  className,
  tileClassName,
  tileProps = {},
  useFolderTileClass = false,
}) {
  const safeMaxItems = Math.max(1, maxItems);
  const renderedItems = mediaItems.slice(0, safeMaxItems);
  const overflowCount = Math.max(0, mediaItems.length - renderedItems.length);
  const layoutCount = Math.max(renderedItems.length, 1);

  return (
    <div
      className={clsx(
        'creation-result-preview-grid',
        mediaType && `creation-result-preview-grid--${mediaType}`,
        `items-${Math.min(layoutCount, 4)}`,
        className,
      )}
    >
      {renderedItems.length > 0 ? (
        renderedItems.map((item, index) => (
          <CreationResultPreviewTile
            key={item?.id || item?.url || index}
            mediaType={mediaType}
            item={item}
            index={index}
            renderMedia={renderMedia}
            emptyLabel={emptyLabel}
            labels={labels}
            moreCount={
              showOverflow &&
              overflowCount > 0 &&
              index === renderedItems.length - 1
                ? overflowCount
                : 0
            }
            className={tileClassName}
            useFolderTileClass={useFolderTileClass}
            {...tileProps}
          />
        ))
      ) : loading ? (
        <BatchResultLoadingPreview
          mediaType={mediaType}
          label={loadingLabel}
          className={tileClassName}
          useFolderTileClass={useFolderTileClass}
        />
      ) : (
        <CreationResultPreviewTile
          mediaType={mediaType}
          emptyLabel={emptyLabel}
          className={tileClassName}
          useFolderTileClass={useFolderTileClass}
          {...tileProps}
        />
      )}
    </div>
  );
}

export function BatchResultLoadingPreview({
  mediaType = 'image',
  label,
  className,
  useFolderTileClass = true,
}) {
  return (
    <CreationResultPreviewTile
      mediaType={mediaType}
      status='generating'
      loadingLabel={label}
      className={className}
      useFolderTileClass={useFolderTileClass}
    />
  );
}

function getPreviewTileStatus(status) {
  if (status === 'processing' || status === 'pending' || status === 'running') {
    return 'generating';
  }
  return status || 'success';
}

function getPreviewTileLabel(status, labels = {}, fallback) {
  if (status === 'failed') return labels.failed || fallback;
  if (status === 'cancelled') return labels.cancelled || fallback;
  if (status === 'generating')
    return labels.processing || labels.generating || fallback;
  return fallback || labels.empty;
}

export function CreationResultPreviewTile({
  mediaType = 'image',
  item,
  status = 'success',
  index,
  renderMedia,
  onPreview,
  emptyLabel,
  loadingLabel,
  labels = {},
  error,
  moreCount = 0,
  actionSlot,
  className,
  disabled = false,
  useFolderTileClass = true,
}) {
  const normalizedStatus = getPreviewTileStatus(status);
  const isLoading = normalizedStatus === 'generating';
  const isSuccess = normalizedStatus === 'success';
  const isFailed = normalizedStatus === 'failed';
  const isCancelled = normalizedStatus === 'cancelled';
  const renderedMedia = isSuccess ? renderMedia?.(item, index) : null;
  const isEmpty = isSuccess && !renderedMedia;
  const canPreview = isSuccess && Boolean(onPreview) && !disabled;
  const statusLabel = getPreviewTileLabel(
    normalizedStatus,
    labels,
    isLoading ? loadingLabel : emptyLabel,
  );
  const handlePreview = () => {
    if (canPreview) onPreview(item, index);
  };

  const handleKeyDown = (event) => {
    if (!canPreview) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handlePreview();
    }
  };

  return (
    <div
      className={clsx(
        useFolderTileClass && 'ai-batch-result-folder__tile',
        'creation-result-preview-tile',
        mediaType && `creation-result-preview-tile--${mediaType}`,
        isEmpty && [
          'is-empty',
          useFolderTileClass && 'ai-batch-result-folder__tile--empty',
        ],
        isLoading && [
          'is-loading',
          useFolderTileClass && 'ai-batch-result-folder__tile--loading',
        ],
        (isFailed || isCancelled) && [
          'is-empty',
          useFolderTileClass && 'ai-batch-result-folder__tile--empty',
        ],
        normalizedStatus && `is-${normalizedStatus}`,
        canPreview && 'is-interactive',
        className,
      )}
      role={canPreview ? 'button' : undefined}
      tabIndex={canPreview ? 0 : undefined}
      aria-disabled={canPreview ? undefined : true}
      title={isFailed ? error : undefined}
      onClick={handlePreview}
      onKeyDown={handleKeyDown}
      aria-live='polite'
    >
      {isLoading ? (
        <>
          <span
            className={clsx(
              'creation-result-preview-tile__loading-field',
              useFolderTileClass && 'ai-batch-result-folder__loading-field',
            )}
          />
          <span
            className={clsx(
              'creation-result-preview-tile__loading-label',
              useFolderTileClass && 'ai-batch-result-folder__loading-label',
            )}
          >
            {statusLabel}
          </span>
        </>
      ) : isSuccess ? (
        renderedMedia || <span>{emptyLabel}</span>
      ) : (
        <span className='creation-result-preview-tile__state'>
          {isCancelled ? (
            <CircleStop size={18} />
          ) : isFailed ? (
            <Info size={18} />
          ) : (
            <Loader2 size={18} className='animate-spin' />
          )}
          <span>{statusLabel}</span>
        </span>
      )}
      {moreCount > 0 ? (
        <span
          className={clsx(
            'creation-result-preview-tile__more',
            useFolderTileClass && 'ai-batch-result-folder__more',
          )}
        >
          +{moreCount}
        </span>
      ) : null}
      {actionSlot}
    </div>
  );
}

export function BatchResultMeta({
  title,
  timeLabel,
  actions,
  selectionMode,
  selected,
  onToggleSelect,
  selectLabel,
}) {
  return (
    <div
      className={clsx(
        'ai-batch-result-folder__meta',
        selectionMode && 'is-selecting',
      )}
      onClick={() => {
        if (selectionMode) onToggleSelect?.();
      }}
    >
      {selectionMode ? (
        <button
          type='button'
          className={clsx(
            'ai-batch-result-folder__select',
            selected && 'is-selected',
          )}
          aria-label={selectLabel}
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect?.();
          }}
        >
          {selected ? <CheckSquare size={13} /> : <Square size={13} />}
        </button>
      ) : (
        <span className='ai-batch-result-folder__time'>{timeLabel}</span>
      )}
      <p className='ai-batch-result-folder__prompt' title={title}>
        {title}
      </p>
      {!selectionMode && actions ? (
        <div className='ai-batch-result-folder__actions'>{actions}</div>
      ) : null}
    </div>
  );
}

export function BatchResultStatus({
  status,
  completedCount,
  totalCount,
  processingCount,
  failedCount,
  cancelledCount,
  labels = {},
}) {
  if (status === 'generating') {
    return (
      <span className='ai-batch-result-folder__status is-generating'>
        <Loader2 size={14} className='animate-spin' />
        {processingCount > 0 ? `+${processingCount}` : labels.generating}
      </span>
    );
  }

  if (status === 'failed') {
    return (
      <span className='ai-batch-result-folder__status is-failed'>
        {labels.failed}
        {failedCount > 1 ? ` ${failedCount}` : ''}
      </span>
    );
  }

  if (status === 'cancelled') {
    return (
      <span className='ai-batch-result-folder__status is-cancelled'>
        {labels.cancelled}
        {cancelledCount > 1 ? ` ${cancelledCount}` : ''}
      </span>
    );
  }

  if (status === 'partial') {
    const failedText =
      failedCount > 0 ? ` - ${labels.failed || ''} ${failedCount}` : '';
    const cancelledText =
      cancelledCount > 0
        ? ` - ${labels.cancelled || ''} ${cancelledCount}`
        : '';

    return (
      <span className='ai-batch-result-folder__status is-partial'>
        {labels.partial} {completedCount}/{totalCount}
        {failedText}
        {cancelledText}
      </span>
    );
  }

  return null;
}
