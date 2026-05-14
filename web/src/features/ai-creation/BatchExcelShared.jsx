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

import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Checkbox, Tooltip } from '@douyinfe/semi-ui';
import {
  CheckSquare,
  ChevronDown,
  CircleStop,
  Download,
  ImagePlus,
  MoreHorizontal,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import {
  ComposerSelect,
  CreationPagination,
  clampCreationNumber,
  getCreationPageCount,
} from './AiCreationShared.jsx';

export const clampBatchNumber = (value, min, max) =>
  clampCreationNumber(value, min, max);

export const getBatchPageCount = (total, pageSize) =>
  getCreationPageCount(total, pageSize);

export function formatBatchResultTimeLabel(createdAt) {
  if (!createdAt) return null;
  const sec = createdAt > 1e10 ? createdAt / 1000 : createdAt;
  const diff = Date.now() / 1000 - sec;
  if (diff < 60) return null;
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 172800) return '昨天';
  return new Date(sec * 1000).toLocaleDateString();
}

export function useBatchFolderPageSize(ref, watchKey = '', options = {}) {
  const [pageSize, setPageSize] = useState(6);
  const {
    minCardWidth = 184,
    gap = 12,
    desktopRows = 2,
    mobileRows = 1,
  } = options;

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let frame = 0;
    const measure = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const node = ref.current;
        const viewportWidth =
          window.innerWidth || document.documentElement.clientWidth || 1280;
        const width = Math.max(190, node?.clientWidth || viewportWidth - 48);
        const columns = clampBatchNumber(
          Math.floor((width + gap) / (minCardWidth + gap)) || 1,
          1,
          8,
        );
        const rows = clampBatchNumber(
          viewportWidth >= 768 ? desktopRows : mobileRows,
          1,
          2,
        );
        setPageSize(Math.max(1, columns * rows));
      });
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(measure)
        : null;
    if (ref.current && resizeObserver) resizeObserver.observe(ref.current);
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [ref, watchKey, minCardWidth, gap, desktopRows, mobileRows]);

  return pageSize;
}

export function BatchPagination({
  total,
  pageSize,
  currentPage,
  onPageChange,
  className = 'batch-excel-pagination-bar',
  countClassName = 'batch-excel-pagination-count',
  showQuickJumper = true,
  t,
}) {
  return (
    <CreationPagination
      total={total}
      pageSize={pageSize}
      currentPage={currentPage}
      onPageChange={onPageChange}
      className={className}
      countClassName={countClassName}
      showQuickJumper={showQuickJumper}
      t={t}
    />
  );
}

export function BatchExcelShell({ children }) {
  return <div className='batch-excel-shell'>{children}</div>;
}

export function BatchExcelToolbar({ left, right }) {
  return (
    <div className='batch-excel-toolbar'>
      <div className='toolbar-left'>{left}</div>
      <div className='toolbar-right'>{right}</div>
    </div>
  );
}

const escapeEditableHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r\n|\r|\n/g, '<br>');

const readEditableText = (node) =>
  (node?.innerText ?? node?.textContent ?? '').replace(/\u00a0/g, ' ');

const compactBatchErrorMessage = (msg) => {
  if (!msg) return '';
  const text = String(msg).replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
};

export function BatchListView({
  variant = 'image',
  tableRef,
  isDraggingFill,
  isDraggingSelect,
  onMouseMove,
  onMouseUp,
  onMouseLeave,
  viewportHeight,
  rowHeight,
  headerHeight,
  rows,
  columns,
  activeCell,
  selectedRows,
  selectedCellKeySet,
  dragOverRowIndex,
  fillPreviewRows,
  onRowDragOver,
  onRowDragLeave,
  onRowDrop,
  onToggleSelectAll,
  onToggleRowSelection,
  onCellClick,
  onSelectCell,
  onStartSelectDrag,
  onStartFillDrag,
  onUpdateCellValue,
  onFocusCellControl,
  onClearCellSelection,
  editStartRef,
  t,
}) {
  const fillPreviewSet =
    fillPreviewRows instanceof Set
      ? fillPreviewRows
      : new Set(fillPreviewRows || []);
  const navigationKeys = columns
    .filter((column) => column.type !== 'preview' && column.navigable !== false)
    .map((column) => column.key);
  const allSelected = rows.length > 0 && selectedRows.size === rows.length;
  const isIndeterminate =
    selectedRows.size > 0 && selectedRows.size < rows.length;

  useEffect(() => {
    if (!onClearCellSelection) return undefined;
    const handlePointerDown = (event) => {
      const root = tableRef.current?.closest?.('.ai-batch-listview');
      if (!root || root.contains(event.target)) return;
      onClearCellSelection();
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [onClearCellSelection, tableRef]);

  return (
    <section
      className={clsx('ai-batch-listview', `ai-batch-listview--${variant}`)}
    >
      <div
        ref={tableRef}
        className={clsx(
          'ai-batch-listview__table-wrap',
          isDraggingFill && 'is-filling',
          isDraggingSelect && 'is-selecting',
        )}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        style={{
          '--ai-batch-table-viewport': `${viewportHeight}px`,
          '--ai-batch-row-height': `${rowHeight}px`,
          '--ai-batch-header-height': `${headerHeight}px`,
        }}
      >
        <table className='ai-batch-listview__table'>
          <thead>
            <tr>
              <th className='ai-batch-listview__col ai-batch-listview__col--checkbox'>
                <BatchRowCheckbox
                  checked={allSelected}
                  indeterminate={isIndeterminate}
                  onChange={onToggleSelectAll}
                />
              </th>
              <th className='ai-batch-listview__col ai-batch-listview__col--rownum'>
                #
              </th>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={clsx(
                    'ai-batch-listview__col',
                    `ai-batch-listview__col--${column.key}`,
                    column.headerClassName,
                  )}
                  style={
                    column.width
                      ? { width: column.width, minWidth: column.width }
                      : undefined
                  }
                >
                  <div className='ai-batch-listview__th-content'>
                    {column.label}
                    {column.fillable !== false && column.type !== 'preview' && (
                      <Tooltip content={t('向下填充')}>
                        <button
                          type='button'
                          className='ai-batch-listview__column-fill-btn'
                          onClick={() => column.onFill?.(column.key)}
                        >
                          <ChevronDown size={10} />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr
                key={row.id}
                data-row-index={rowIndex}
                className={clsx({
                  'row-selected': selectedRows.has(rowIndex),
                  'row-drag-over': dragOverRowIndex === rowIndex,
                  'fill-preview': fillPreviewSet.has(rowIndex),
                })}
                onDragOver={(event) => onRowDragOver?.(event, rowIndex)}
                onDragLeave={onRowDragLeave}
                onDrop={(event) => onRowDrop?.(event, rowIndex)}
              >
                <td
                  className='ai-batch-listview__col ai-batch-listview__col--checkbox'
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleRowSelection(rowIndex, event.shiftKey);
                  }}
                >
                  <BatchRowCheckbox
                    checked={selectedRows.has(rowIndex)}
                    onChange={() => {}}
                  />
                </td>
                <td
                  className='ai-batch-listview__col ai-batch-listview__col--rownum'
                  onClick={(event) =>
                    onToggleRowSelection(rowIndex, event.shiftKey)
                  }
                >
                  {rowIndex + 1}
                </td>
                {columns.map((column) => (
                  <td key={column.key}>
                    <BatchListViewCell
                      row={row}
                      rowIndex={rowIndex}
                      column={column}
                      rows={rows}
                      navigationKeys={navigationKeys}
                      activeCell={activeCell}
                      selectedCellKeySet={selectedCellKeySet}
                      onCellClick={onCellClick}
                      onSelectCell={onSelectCell}
                      onStartSelectDrag={onStartSelectDrag}
                      onStartFillDrag={onStartFillDrag}
                      onUpdateCellValue={onUpdateCellValue}
                      onFocusCellControl={onFocusCellControl}
                      editStartRef={editStartRef}
                      t={t}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BatchListViewCell({
  row,
  rowIndex,
  column,
  rows,
  navigationKeys,
  activeCell,
  selectedCellKeySet,
  onCellClick,
  onSelectCell,
  onStartSelectDrag,
  onStartFillDrag,
  onUpdateCellValue,
  onFocusCellControl,
  editStartRef,
  t,
}) {
  const col = column.key;
  const isActive = activeCell?.row === rowIndex && activeCell?.col === col;
  const isSelected = selectedCellKeySet.has(`${rowIndex}:${col}`);
  const isPreview = column.type === 'preview';
  const previewInfo = isPreview ? column.getInfo?.(row, rowIndex) : null;

  return (
    <div
      className={clsx(
        'ai-batch-listview-cell',
        `ai-batch-listview-cell--${column.type || 'custom'}`,
        `ai-batch-listview-cell--${col}`,
        previewInfo?.status &&
          `ai-batch-listview-cell--status-${previewInfo.status}`,
        {
          active: isActive,
          selected: isSelected && !isActive,
        },
      )}
      onMouseDown={(event) => {
        if (
          isPreview ||
          event.target?.closest?.('.ai-batch-listview__fill-handle')
        ) {
          return;
        }
        if (event.button === 0 && !event.shiftKey) {
          onStartSelectDrag(rowIndex, col);
        }
      }}
      onClick={(event) => {
        if (!isPreview) onCellClick(event, rowIndex, col);
      }}
      data-col-key={col}
    >
      {renderBatchCellContent({
        row,
        rowIndex,
        column,
        rows,
        navigationKeys,
        onUpdateCellValue,
        onSelectCell,
        onFocusCellControl,
        editStartRef,
        t,
      })}
      {column.fillable !== false && !isPreview && isActive && (
        <BatchFillHandle
          onMouseDown={(event) => {
            event.stopPropagation();
            onStartFillDrag(rowIndex, col);
          }}
        />
      )}
    </div>
  );
}

function renderBatchCellContent(args) {
  const { column } = args;
  if (column.render) return column.render(args);
  if (column.type === 'text' || column.type === 'number') {
    return <BatchEditableTextCell {...args} />;
  }
  if (column.type === 'select') return <BatchSelectCell {...args} />;
  if (column.type === 'images') return <BatchReferenceImagesCell {...args} />;
  if (column.type === 'preview') return <BatchPreviewCell {...args} />;
  return null;
}

export function BatchEditableTextCell({
  row,
  rowIndex,
  column,
  rows,
  navigationKeys,
  onUpdateCellValue,
  onSelectCell,
  onFocusCellControl,
  editStartRef,
}) {
  const col = column.key;
  const rawValue = row[col] ?? column.defaultValue ?? '';
  const startKey = `${row.id}:${col}`;
  const isNumber = column.type === 'number';
  const normalize = column.normalize || ((value) => value);

  const commit = (node) => {
    const nextValue = normalize(readEditableText(node));
    if (isNumber) node.textContent = String(nextValue);
    onUpdateCellValue(rowIndex, col, nextValue);
    editStartRef.current.delete(startKey);
    return nextValue;
  };

  const moveFocus = (nextRow, nextCol) => {
    onSelectCell(nextRow, nextCol);
    onFocusCellControl(nextRow, nextCol);
  };

  return (
    <div
      key={`${row.id}:${col}:${rawValue}`}
      className={clsx(
        'ai-batch-listview-editor',
        isNumber && 'ai-batch-listview-editor--number',
      )}
      data-batch-cell-editor={`${rowIndex}:${col}`}
      contentEditable
      suppressContentEditableWarning
      inputMode={isNumber ? 'numeric' : undefined}
      dangerouslySetInnerHTML={{ __html: escapeEditableHtml(rawValue) }}
      onFocus={() => {
        editStartRef.current.set(startKey, rawValue);
        onSelectCell(rowIndex, col);
      }}
      onBlur={(event) => commit(event.currentTarget)}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (
          isNumber &&
          event.key.length === 1 &&
          !/\d/.test(event.key) &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          event.preventDefault();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          const startValue = editStartRef.current.get(startKey) ?? rawValue;
          if (isNumber) event.currentTarget.textContent = String(startValue);
          else event.currentTarget.innerHTML = escapeEditableHtml(startValue);
          event.currentTarget.blur();
          return;
        }
        if (event.key === 'Enter' && (isNumber || !event.shiftKey)) {
          event.preventDefault();
          commit(event.currentTarget);
          event.currentTarget.blur();
          if (rowIndex < rows.length - 1) moveFocus(rowIndex + 1, col);
          return;
        }
        if (event.key === 'Tab') {
          event.preventDefault();
          commit(event.currentTarget);
          event.currentTarget.blur();
          const currentIndex = navigationKeys.indexOf(col);
          const nextIndex = currentIndex + (event.shiftKey ? -1 : 1);
          if (nextIndex >= 0 && nextIndex < navigationKeys.length) {
            moveFocus(rowIndex, navigationKeys[nextIndex]);
          }
        }
      }}
    />
  );
}

export function BatchSelectCell({
  row,
  rowIndex,
  column,
  onUpdateCellValue,
  onSelectCell,
}) {
  const options = column.getOptions?.(row, rowIndex) || column.options || [];
  return (
    <div
      className='ai-batch-listview-select'
      data-batch-cell-input={`${rowIndex}:${column.key}`}
      tabIndex={-1}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onSelectCell(rowIndex, column.key);
      }}
    >
      <ComposerSelect
        value={row[column.key]}
        options={options}
        onChange={(value) => {
          onUpdateCellValue(rowIndex, column.key, value);
          onSelectCell(rowIndex, column.key);
        }}
      />
    </div>
  );
}

export function BatchReferenceImagesCell({
  row,
  rowIndex,
  column,
  onSelectCell,
  t,
}) {
  const images = Array.isArray(row.images) ? row.images : [];
  return (
    <div className='ai-batch-listview-images'>
      {images.map((url, idx) => (
        <button
          key={`${url}-${idx}`}
          type='button'
          className='ai-batch-listview-thumb ai-batch-listview-thumb--reference'
          onClick={(event) => {
            event.stopPropagation();
            column.onPreviewImage?.(url, rowIndex, idx);
          }}
        >
          <img src={url} alt='' />
          <span
            role='button'
            tabIndex={0}
            className='ai-batch-listview-thumb__remove'
            onClick={(event) => {
              event.stopPropagation();
              column.onRemoveImage?.(rowIndex, url);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                column.onRemoveImage?.(rowIndex, url);
              }
            }}
            title={t('移除')}
          >
            x
          </span>
        </button>
      ))}
      <button
        type='button'
        className='ai-batch-listview-add-image'
        title={t('上传图片')}
        onClick={(event) => {
          event.stopPropagation();
          onSelectCell(rowIndex, column.key);
          column.onAddImage?.(rowIndex);
        }}
      >
        <ImagePlus size={18} />
      </button>
      {images.length === 0 && (
        <span className='ai-batch-listview-images__empty'>
          {t('点击 + 上传参考图')}
        </span>
      )}
    </div>
  );
}

export function BatchPreviewCell({ row, rowIndex, column, t }) {
  const info = column.getInfo?.(row, rowIndex);
  if (!info || info.status === 'idle') {
    return <span className='ai-batch-listview-preview__idle'>-</span>;
  }

  if (info.status === 'generating' && info.completedCount === 0) {
    return (
      <span className='ai-batch-listview-preview__generating'>
        <span className='ai-batch-listview-spinner' />
        {t('生成中...')}
      </span>
    );
  }

  if (info.status === 'failed') {
    return (
      <Tooltip content={info.firstError || t('生成失败')} position='top'>
        <div
          className='ai-batch-listview-preview__error'
          onClick={(event) => {
            event.stopPropagation();
            column.onFailedClick?.(rowIndex);
          }}
        >
          <span className='ai-batch-listview-preview__error-message'>
            {compactBatchErrorMessage(info.firstError) || t('生成失败')}
          </span>
        </div>
      </Tooltip>
    );
  }

  const visibleCount = info.status === 'generating' ? 2 : 3;
  const visibleItems = info.completedItems.slice(0, visibleCount);
  const hasMore =
    info.status !== 'generating' && info.completedCount > visibleCount;

  return (
    <div className='ai-batch-listview-preview'>
      {visibleItems.map((item, idx) => column.renderThumb?.(item, idx))}
      {info.status === 'generating' && info.processingCount > 0 && (
        <span className='ai-batch-listview-preview__generating-inline'>
          <span className='ai-batch-listview-spinner' />+{info.processingCount}
        </span>
      )}
      {hasMore && (
        <button
          type='button'
          className='ai-batch-listview-preview__more'
          onClick={(event) => {
            event.stopPropagation();
            column.onMore?.(row);
          }}
        >
          +{info.completedCount - visibleCount}
        </button>
      )}
      {info.status === 'partial' && (
        <span className='ai-batch-listview-preview__partial'>
          {info.completedCount}/{info.tasks.length}
        </span>
      )}
    </div>
  );
}

export function BatchRowCheckbox({ checked, indeterminate, onChange }) {
  return (
    <span className='ai-batch-listview-checkbox'>
      <Checkbox
        checked={checked}
        indeterminate={indeterminate}
        onChange={onChange}
      />
    </span>
  );
}

export function BatchFillHandle({ onMouseDown }) {
  return (
    <div className='ai-batch-listview__fill-handle' onMouseDown={onMouseDown} />
  );
}

export function BatchResultsActions({
  disabled,
  selectionMode,
  selectedCount,
  onEnterSelection,
  onExitSelection,
  onSelectVisible,
  onCancelSelected,
  onDeleteSelected,
  onDownloadSelected,
  onRetrySelected,
  onDownloadAll,
  onRetryFailed,
  onCancelActive,
  onClearSettled,
  activeCount = 0,
  activeSelectedCount = 0,
  downloadableSelectedCount = 0,
  retryableSelectedCount = 0,
  retryableCount = 0,
  settledCount = 0,
  onDeleteFailed,
  failedCount = 0,
  onDeleteAll,
  t,
}) {
  const [open, setOpen] = useState(false);
  const noRetryableSelectedTitle =
    selectedCount > 0 && retryableSelectedCount <= 0
      ? t('选中项中没有可重试任务')
      : undefined;

  if (selectionMode) {
    return (
      <>
        <span className='ai-creation-gallery__selected-count'>
          {t('已选中 {{count}} 项', { count: selectedCount })}
        </span>
        <button
          type='button'
          onClick={onSelectVisible}
          disabled={!onSelectVisible}
          className='ai-creation-ghost-btn ai-creation-gallery__toolbar-action'
        >
          {t('全选当前')}
        </button>
        <button
          type='button'
          onClick={onDownloadSelected}
          disabled={
            selectedCount === 0 ||
            downloadableSelectedCount <= 0 ||
            !onDownloadSelected
          }
          className='ai-creation-ghost-btn ai-creation-gallery__toolbar-action'
        >
          <Download size={14} />
          {t('下载选中')}
        </button>
        <button
          type='button'
          onClick={onRetrySelected}
          disabled={
            selectedCount === 0 ||
            retryableSelectedCount <= 0 ||
            !onRetrySelected
          }
          title={noRetryableSelectedTitle}
          className='ai-creation-ghost-btn ai-creation-gallery__toolbar-action'
        >
          <RotateCcw size={14} />
          {t('重试选中')}
        </button>
        <button
          type='button'
          onClick={onCancelSelected}
          disabled={
            selectedCount === 0 || activeSelectedCount <= 0 || !onCancelSelected
          }
          className='ai-creation-danger-btn ai-creation-gallery__toolbar-action'
        >
          <CircleStop size={14} />
          {t('停止选中')}
        </button>
        <button
          type='button'
          onClick={onDeleteSelected}
          disabled={selectedCount === 0 || !onDeleteSelected}
          className='ai-creation-danger-btn ai-creation-gallery__toolbar-action'
        >
          <Trash2 size={14} />
          {t('删除选中')}
        </button>
        <button
          type='button'
          onClick={onExitSelection}
          className='ai-creation-ghost-btn ai-creation-gallery__toolbar-action'
        >
          {t('退出多选')}
        </button>
      </>
    );
  }

  return (
    <>
      <button
        type='button'
        onClick={onEnterSelection}
        disabled={disabled}
        className='ai-creation-ghost-btn ai-creation-gallery__toolbar-action'
      >
        <CheckSquare size={15} />
        {t('多选')}
      </button>
      <div
        className='relative'
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setOpen(false);
          }
        }}
      >
        <button
          type='button'
          disabled={disabled}
          onClick={() => setOpen((visible) => !visible)}
          className='ai-creation-ghost-btn ai-creation-gallery__toolbar-action'
        >
          <MoreHorizontal size={16} />
          {t('管理')}
        </button>
        {open && !disabled && (
          <div className='ai-creation-menu ai-creation-history-menu ai-creation-gallery__toolbar-menu absolute right-0 top-10 z-30 min-w-[180px] overflow-hidden rounded-[14px] border p-1.5'>
            {onDownloadAll && (
              <button
                type='button'
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setOpen(false);
                  onDownloadAll();
                }}
                className='ai-creation-history-menu-item flex h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[13px] transition'
              >
                <Download size={15} />
                {t('下载全部')}
              </button>
            )}
            {onRetryFailed && (
              <>
                <button
                  type='button'
                  disabled={retryableCount <= 0}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setOpen(false);
                    onRetryFailed();
                  }}
                  className='ai-creation-history-menu-item flex h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[13px] transition'
                >
                  <RotateCcw size={15} />
                  {t('重试失败/已停止')}
                </button>
              </>
            )}
            {onCancelActive && (
              <>
                {(onDownloadAll || onRetryFailed) && (
                  <div className='ai-creation-history-menu-divider my-1' />
                )}
                <button
                  type='button'
                  disabled={activeCount <= 0}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setOpen(false);
                    onCancelActive();
                  }}
                  className='ai-creation-history-menu-item is-danger flex h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[13px] transition'
                >
                  <CircleStop size={15} />
                  {t('停止生成中')}
                </button>
              </>
            )}
            {onClearSettled && (
              <>
                {(onDownloadAll || onRetryFailed || onCancelActive) && (
                  <div className='ai-creation-history-menu-divider my-1' />
                )}
                <button
                  type='button'
                  disabled={settledCount <= 0}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setOpen(false);
                    onClearSettled();
                  }}
                  className='ai-creation-history-menu-item flex h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[13px] transition'
                >
                  <CheckSquare size={15} />
                  {t('清理已完成/已停止')}
                </button>
              </>
            )}
            {onDeleteFailed && (
              <>
                {(onDownloadAll ||
                  onRetryFailed ||
                  onCancelActive ||
                  onClearSettled) && (
                  <div className='ai-creation-history-menu-divider my-1' />
                )}
                <button
                  type='button'
                  disabled={failedCount <= 0}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setOpen(false);
                    onDeleteFailed();
                  }}
                  className='ai-creation-history-menu-item is-danger flex h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[13px] transition'
                >
                  <Trash2 size={15} />
                  {t('删除失败')}
                </button>
              </>
            )}
            {onDeleteAll && (
              <>
                {(onDownloadAll ||
                  onRetryFailed ||
                  onCancelActive ||
                  onClearSettled ||
                  onDeleteFailed) && (
                  <div className='ai-creation-history-menu-divider my-1' />
                )}
                <button
                  type='button'
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setOpen(false);
                    onDeleteAll();
                  }}
                  className='ai-creation-history-menu-item is-danger flex h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[13px] transition'
                >
                  <Trash2 size={15} />
                  {t('删除全部')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
