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

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import CreationResultGroupModal from './CreationResultGroupModal.jsx';
import {
  createCreationResultGroupItems,
  createCreationResultGroupStats,
  normalizeCreationResultGroupStats,
} from './creationResultGroupAdapters.js';

function useStableEvent(handler) {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  return useCallback((...args) => handlerRef.current?.(...args), []);
}

export default function CreationResultGroupModalContainer({
  visible,
  onClose,
  mediaType = 'image',
  row,
  rowIndex = -1,
  info,
  promptFallback,
  renderThumb,
  onPreviewItem,
  onDownloadItem,
  onDownloadAll,
  onRetryFailed,
  onCancelActive,
  onDeleteItem,
  onShowErrorItem,
}) {
  const { t } = useTranslation();
  const previewItem = useStableEvent(onPreviewItem);
  const downloadItem = useStableEvent(onDownloadItem);
  const downloadAll = useStableEvent(onDownloadAll);
  const retryFailed = useStableEvent(onRetryFailed);
  const cancelActive = useStableEvent(onCancelActive);
  const deleteItem = useStableEvent(onDeleteItem);
  const showErrorItem = useStableEvent(onShowErrorItem);
  const items = useMemo(
    () => createCreationResultGroupItems(info || {}),
    [info],
  );
  const stats = useMemo(
    () =>
      normalizeCreationResultGroupStats(
        createCreationResultGroupStats(info || {}),
        items,
      ),
    [info, items],
  );

  const handlePreview = useCallback(
    (item, index) => previewItem(item, index, row, rowIndex, info),
    [info, previewItem, row, rowIndex],
  );
  const handleDownloadItem = useCallback(
    (item, index) => downloadItem(item, index, row, rowIndex, info),
    [downloadItem, info, row, rowIndex],
  );
  const handleDownloadAll = useCallback(
    () => downloadAll(row, rowIndex, info),
    [downloadAll, info, row, rowIndex],
  );
  const handleRetryFailed = useCallback(
    () => retryFailed(row, rowIndex, info),
    [info, retryFailed, row, rowIndex],
  );
  const handleCancelActive = useCallback(
    () => cancelActive(row, rowIndex, info),
    [cancelActive, info, row, rowIndex],
  );
  const handleDeleteItem = useCallback(
    (item, index) => deleteItem(item, index, row, rowIndex, info),
    [deleteItem, info, row, rowIndex],
  );
  const handleShowErrorItem = useCallback(
    (item, index) => showErrorItem(item, index, row, rowIndex, info),
    [info, row, rowIndex, showErrorItem],
  );

  return (
    <CreationResultGroupModal
      mediaType={mediaType}
      visible={visible}
      onCancel={onClose}
      title={
        rowIndex >= 0 ? t('第 {{row}} 行生成结果', { row: rowIndex + 1 }) : ''
      }
      prompt={row?.prompt || promptFallback}
      items={items}
      stats={stats}
      resetKey={row?.id ?? rowIndex}
      onPreview={onPreviewItem ? handlePreview : undefined}
      onDownloadItem={onDownloadItem ? handleDownloadItem : undefined}
      onDownloadAll={
        row && stats.completed > 0 && onDownloadAll
          ? handleDownloadAll
          : undefined
      }
      onRetryFailed={
        row && (stats.failed > 0 || stats.cancelled > 0) && onRetryFailed
          ? handleRetryFailed
          : undefined
      }
      onCancelActive={
        row && stats.processing > 0 && onCancelActive
          ? handleCancelActive
          : undefined
      }
      onDeleteItem={onDeleteItem ? handleDeleteItem : undefined}
      onShowErrorItem={onShowErrorItem ? handleShowErrorItem : undefined}
      renderThumb={renderThumb}
    />
  );
}
