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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button, InputNumber, Modal, Toast, Tooltip } from '@douyinfe/semi-ui';
import {
  CheckSquare,
  Download,
  FileDown,
  Image as ImageIcon,
  Loader2,
  Plus,
  Repeat,
  Square,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { DEFAULT_IMAGE_CONFIG, TASK_STATUS } from './constants.js';
import {
  createBatchRowImageParams,
  getImageParameterState,
} from './imageParams.js';
import { getImageAspectRatio, readImageFileAsDataUrl } from './utils.js';
import { ComposerSelect } from './AiCreationShared.jsx';
import {
  CREATION_CONCURRENCY_OPTIONS,
  clampCreationConcurrency,
  isCreationTaskActive,
  isCreationTaskCancelled,
} from './creationTaskUtils.js';
import {
  IMAGE_BATCH_STATUS,
  IMAGE_TASK_SOURCE,
  createImageBatchQueueItems,
} from './imageBatchQueue.js';
import {
  ensureCachedImageUrl,
  isDataImageUrl,
  isSessionBlobUrl,
  resolveCachedImageUrl,
} from './imageCache.js';
import {
  BATCH_ROW_DEFAULTS,
  BATCH_TABLE_MAX_ROWS,
  SIZE_OPTIONS,
  createBatchRow,
  createInitialBatchRows,
  downloadBatchTemplate,
  exportBatchRowsToExcel,
  insertRowAfter,
  loadBatchRows,
  parseSpreadsheetFile,
  removeRowsAt,
  saveBatchRows,
  updateRowAt,
} from './imageBatchTable.js';
import {
  BatchResultsActions,
  BatchExcelShell,
  BatchListView,
  BatchExcelToolbar,
  BatchPagination,
  clampBatchNumber,
  formatBatchResultTimeLabel,
  getBatchPageCount,
  useBatchFolderPageSize,
} from './BatchExcelShared.jsx';
import {
  BatchResultFolderCard,
  BatchResultGallery,
  getBatchResultGalleryStyle,
} from './BatchResultGallery.jsx';
import { CreationGalleryEmptyState } from './CreationGallery.jsx';
import CreationResultGroupModalContainer from './CreationResultGroupModalContainer.jsx';
import './imageBatchExcel.css';
import './creationResultGroup.css';

const COL_KEYS = ['prompt', 'size', 'images', 'count'];
const HISTORY_LIMIT = 50;
const STORAGE_QUOTA_WARN_BYTES = 4 * 1024 * 1024;
const CONCURRENCY_OPTIONS = CREATION_CONCURRENCY_OPTIONS;
const CONCURRENCY_STORAGE_KEY = 'ai_creation_image_batch_concurrency';
const CONFIG_STORAGE_KEY = 'ai_creation_image_batch_config';

const loadConcurrency = () => {
  if (typeof window === 'undefined') return 1;
  try {
    const v = Number(window.localStorage.getItem(CONCURRENCY_STORAGE_KEY));
    return CONCURRENCY_OPTIONS.includes(clampCreationConcurrency(v))
      ? clampCreationConcurrency(v)
      : 1;
  } catch {
    return 1;
  }
};

const persistConcurrency = (value) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      CONCURRENCY_STORAGE_KEY,
      String(clampCreationConcurrency(value)),
    );
  } catch {
    /* ignore */
  }
};

const loadBatchConfig = () => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const saveBatchConfig = (patch) => {
  if (typeof window === 'undefined') return;
  try {
    const prev = loadBatchConfig();
    window.localStorage.setItem(
      CONFIG_STORAGE_KEY,
      JSON.stringify({ ...prev, ...patch }),
    );
  } catch {
    /* ignore */
  }
};

const clampNumber = clampBatchNumber;
const getPageCount = getBatchPageCount;

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

const normalizeBatchCount = (value) => {
  const number = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(number) ? clampNumber(Math.floor(number), 1, 99) : 1;
};

const IMAGE_BATCH_TABLE_HEADER_HEIGHT = 34;
const IMAGE_BATCH_TABLE_ROW_HEIGHT = 37;
const IMAGE_BATCH_TABLE_VIEWPORT_HEIGHT = 242;

const compactErrorMessage = (msg) => {
  if (!msg) return '';
  const text = String(msg).replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

const cloneRowsForHistory = (rows) =>
  rows.map((row) => ({
    ...row,
    images: [...row.images],
    taskIds: [...row.taskIds],
  }));

const useStableCallback = (fn) => {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args) => ref.current?.(...args), []);
};

async function downloadBatchAssetUrl(url, filename) {
  if (!url) return;
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.target = '_blank';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

const getTaskImageSourceUrl = (item = {}) => {
  const safeItem = item || {};
  const source = safeItem.task || safeItem;
  const url =
    typeof safeItem.url === 'string'
      ? safeItem.url
      : typeof source.url === 'string'
        ? source.url
        : '';
  const remoteUrl =
    typeof safeItem.remoteUrl === 'string'
      ? safeItem.remoteUrl
      : typeof source.remoteUrl === 'string'
        ? source.remoteUrl
        : '';
  if (isSessionBlobUrl(url)) {
    return isSessionBlobUrl(remoteUrl) ? '' : remoteUrl;
  }
  return url || (isSessionBlobUrl(remoteUrl) ? '' : remoteUrl);
};

const useCachedImageItemUrl = (item) => {
  const sourceUrl = getTaskImageSourceUrl(item);
  const [displayUrl, setDisplayUrl] = useState(
    isDataImageUrl(sourceUrl) ? sourceUrl : '',
  );

  useEffect(() => {
    if (!item?.id) {
      setDisplayUrl(isSessionBlobUrl(sourceUrl) ? '' : sourceUrl);
      return;
    }

    if (isDataImageUrl(sourceUrl)) {
      setDisplayUrl(sourceUrl);
      return;
    }

    let cancelled = false;
    ensureCachedImageUrl(item.id, sourceUrl)
      .then((blobUrl) => {
        if (cancelled) {
          return;
        }
        if (blobUrl) {
          setDisplayUrl(blobUrl);
        } else {
          setDisplayUrl(isSessionBlobUrl(sourceUrl) ? '' : sourceUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDisplayUrl(isSessionBlobUrl(sourceUrl) ? '' : sourceUrl);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [item?.id, sourceUrl]);

  return displayUrl;
};

const openCachedImagePreview = (item, onPreview, title) => {
  if (!item || !onPreview) return;
  const sourceUrl = getTaskImageSourceUrl(item);
  resolveCachedImageUrl(item.id, sourceUrl)
    .then(({ url }) => {
      if (!url) return;
      onPreview({
        url,
        type: 'image',
        title,
      });
    })
    .catch(() => {
      const fallbackUrl = isSessionBlobUrl(sourceUrl) ? '' : sourceUrl;
      if (fallbackUrl) {
        onPreview({ url: fallbackUrl, type: 'image', title });
      }
    });
};

const CachedResultImage = ({ item, style }) => {
  const displayUrl = useCachedImageItemUrl(item);
  return displayUrl ? (
    <img src={displayUrl} alt='' loading='lazy' style={style} />
  ) : (
    <div className='empty-tile' />
  );
};

const getPreviewRatioStyle = (item) =>
  item?.aspectRatio
    ? { '--ai-preview-thumb-ratio': item.aspectRatio }
    : undefined;

const CachedPreviewThumb = ({ item, onPreview, t }) => {
  const displayUrl = useCachedImageItemUrl(item);
  return (
    <div
      className='ai-batch-listview-thumb ai-batch-listview-thumb--preview'
      style={getPreviewRatioStyle(item)}
      onClick={(e) => {
        e.stopPropagation();
        openCachedImagePreview(item, onPreview, t('我的作品'));
      }}
    >
      {displayUrl ? (
        <img src={displayUrl} alt='' />
      ) : (
        <div className='empty-tile' />
      )}
    </div>
  );
};

const BatchImageResultTile = ({ item }) => {
  const displayUrl = useCachedImageItemUrl(item);
  return displayUrl ? (
    <img src={displayUrl} alt='' loading='lazy' />
  ) : (
    <div className='ai-batch-result-folder__tile ai-batch-result-folder__tile--empty' />
  );
};

const resolveLatestOptionValue = (refValue, inputValue, options = []) => {
  const optionValues = new Set(options.map((option) => String(option.value)));
  if (refValue && (!optionValues.size || optionValues.has(String(refValue)))) {
    return refValue;
  }
  if (inputValue && (!optionValues.size || optionValues.has(String(inputValue)))) {
    return inputValue;
  }
  return options[0]?.value || '';
};

export default function ImageBatchTab({
  inputs,
  models,
  groups,
  handleInputChange,
  tasks,
  onEnqueue,
  onDeleteTasks,
  onCancelTasks,
  onRetryTask,
  onShowError,
  onPreview,
}) {
  const { t } = useTranslation();
  const savedConfig = loadBatchConfig();

  // ────────────────── data state ──────────────────
  const [rows, setRows] = useState(() => loadBatchRows());
  const [resolution, setResolution] = useState(
    savedConfig.resolution ?? DEFAULT_IMAGE_CONFIG.quality,
  );
  const [concurrency, setConcurrency] = useState(loadConcurrency);

  useEffect(() => {
    persistConcurrency(concurrency);
  }, [concurrency]);

  // selection / editing
  const [activeCell, setActiveCell] = useState(null);
  const [selectedCells, setSelectedCells] = useState([]);
  const [editingCell, setEditingCell] = useState(null);
  const promptEditStartRef = useRef(new Map());
  const [selectedRows, setSelectedRows] = useState(() => new Set());

  // drag state
  const [isDraggingFill, setIsDraggingFill] = useState(false);
  const [fillStartCell, setFillStartCell] = useState(null);
  const [fillEndRow, setFillEndRow] = useState(null);
  const [fillPreviewRows, setFillPreviewRows] = useState([]);
  const [isDraggingSelect, setIsDraggingSelect] = useState(false);
  const [selectStartCell, setSelectStartCell] = useState(null);
  const [dragOverRowIndex, setDragOverRowIndex] = useState(null);
  const selectedCellKeySet = useMemo(
    () => new Set(selectedCells.map((cell) => `${cell.row}:${cell.col}`)),
    [selectedCells],
  );
  const fillPreviewRowSet = useMemo(
    () => new Set(fillPreviewRows),
    [fillPreviewRows],
  );

  // modal state
  const [addRowsModalOpen, setAddRowsModalOpen] = useState(false);
  const [addRowsCount, setAddRowsCount] = useState(5);
  const [batchImportModalOpen, setBatchImportModalOpen] = useState(false);
  const [pendingImportFiles, setPendingImportFiles] = useState([]);
  const [importStartRow, setImportStartRow] = useState(1);
  const [imagesPerRow, setImagesPerRow] = useState(1);
  const [rowGalleryRow, setRowGalleryRow] = useState(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resultsPage, setResultsPage] = useState(1);
  const [resultSelectionMode, setResultSelectionMode] = useState(false);
  const [selectedResultRowIds, setSelectedResultRowIds] = useState(
    () => new Set(),
  );

  // refs
  const fileInputRef = useRef(null);
  const excelInputRef = useRef(null);
  const batchImageInputRef = useRef(null);
  const rowImageInputRef = useRef(null);
  const uploadTargetRowRef = useRef(null);
  const lastCheckedRowRef = useRef(null);
  const lastSelectedRowRef = useRef(null);
  const historyRef = useRef([]);
  const historyIndexRef = useRef(-1);
  const isUndoRedoRef = useRef(false);
  const skipNextHistoryRef = useRef(false);
  const tableRef = useRef(null);
  const resultsGridRef = useRef(null);
  const selectedGroupRef = useRef(inputs.group || '');
  const selectedModelRef = useRef(inputs.model || '');

  // model/group options
  const modelOptions = useMemo(() => {
    const list = (models || [])
      .map((item) => ({
        value: item.value ?? item.key ?? item.model_code ?? item.code ?? item,
        label: item.label ?? item.name ?? item.value ?? item.key ?? item,
      }))
      .filter((item) => item.value != null);
    return list.length
      ? list
      : inputs.model
        ? [{ value: inputs.model, label: inputs.model }]
        : [];
  }, [models, inputs.model]);
  const groupOptions = useMemo(() => {
    const list = (groups || [])
      .map((item) => ({
        value: item.value ?? item.key ?? item,
        label: item.label ?? item.name ?? item.value ?? item.key ?? item,
      }))
      .filter((item) => item.value != null);
    return list.length
      ? list
      : inputs.group
        ? [{ value: inputs.group, label: inputs.group }]
        : [];
  }, [groups, inputs.group]);

  const effectiveImageModel = resolveLatestOptionValue(
    selectedModelRef.current,
    inputs.model,
    modelOptions,
  );
  const effectiveImageGroup = resolveLatestOptionValue(
    selectedGroupRef.current,
    inputs.group,
    groupOptions,
  );

  const parameterState = useMemo(
    () => getImageParameterState(effectiveImageModel),
    [effectiveImageModel],
  );
  const batchSizeOptions = useMemo(
    () => [
      SIZE_OPTIONS[0],
      ...parameterState.ratioOptions.map((item) => ({
        value: item.value,
        label: item.label,
        width: item.width,
        height: item.height,
      })),
    ],
    [parameterState.ratioOptions],
  );
  const imageQualityOptions = parameterState.qualityOptions;
  const showQuality = parameterState.supportsQuality;

  useEffect(() => {
    selectedModelRef.current = inputs.model || modelOptions[0]?.value || '';
  }, [inputs.model, modelOptions]);

  useEffect(() => {
    selectedGroupRef.current = inputs.group || groupOptions[0]?.value || '';
  }, [inputs.group, groupOptions]);

  useEffect(() => {
    if (!showQuality) return;
    const hasResolution = imageQualityOptions.some(
      (option) => option.value === resolution,
    );
    if (!hasResolution) {
      setResolution(
        parameterState.defaults.quality || DEFAULT_IMAGE_CONFIG.quality,
      );
    }
  }, [
    showQuality,
    imageQualityOptions,
    parameterState.defaults.quality,
    resolution,
  ]);

  useEffect(() => {
    if (!showQuality) return;
    const hasResolution = imageQualityOptions.some(
      (option) => option.value === resolution,
    );
    if (!hasResolution) return;
    saveBatchConfig({ resolution });
  }, [showQuality, imageQualityOptions, resolution]);

  // ────────────────── persistence ──────────────────
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const result = saveBatchRows(rows);
      if (result?.truncated) {
        Toast.warning(t('参考图过大，已暂时不持久化图片数据'));
      }
    }, 300);
    return () => window.clearTimeout(handle);
  }, [rows, t]);

  // ────────────────── undo/redo ──────────────────
  const pushHistory = useCallback((nextRows) => {
    if (isUndoRedoRef.current) {
      isUndoRedoRef.current = false;
      return;
    }
    if (skipNextHistoryRef.current) {
      skipNextHistoryRef.current = false;
      return;
    }
    historyRef.current = historyRef.current.slice(
      0,
      historyIndexRef.current + 1,
    );
    historyRef.current.push(cloneRowsForHistory(nextRows));
    if (historyRef.current.length > HISTORY_LIMIT) {
      historyRef.current.shift();
    } else {
      historyIndexRef.current += 1;
    }
  }, []);

  useEffect(() => {
    pushHistory(rows);
  }, [rows, pushHistory]);

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) {
      Toast.info(t('没有可撤销的操作'));
      return;
    }
    historyIndexRef.current -= 1;
    isUndoRedoRef.current = true;
    setRows(cloneRowsForHistory(historyRef.current[historyIndexRef.current]));
    setEditingCell(null);
  }, [t]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) {
      Toast.info(t('没有可重做的操作'));
      return;
    }
    historyIndexRef.current += 1;
    isUndoRedoRef.current = true;
    setRows(cloneRowsForHistory(historyRef.current[historyIndexRef.current]));
    setEditingCell(null);
  }, [t]);

  // global keyboard
  useEffect(() => {
    const onKey = (e) => {
      if (editingCell) return;
      const target = e.target;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editingCell, undo, redo]);

  // ────────────────── selection helpers ──────────────────
  const selectCell = useCallback((row, col) => {
    setActiveCell({ row, col });
    setSelectedCells([{ row, col }]);
    setEditingCell(null);
  }, []);

  const clearCellSelection = useCallback(() => {
    setActiveCell(null);
    setSelectedCells([]);
    setEditingCell(null);
  }, []);

  const handleCellClick = useCallback(
    (e, row, col) => {
      if (e.shiftKey && activeCell) {
        const minRow = Math.min(activeCell.row, row);
        const maxRow = Math.max(activeCell.row, row);
        setSelectedRows((prev) => {
          const next = new Set(prev);
          for (let r = minRow; r <= maxRow; r += 1) next.add(r);
          return next;
        });
        const next = [];
        for (let r = minRow; r <= maxRow; r += 1) {
          next.push({ row: r, col: activeCell.col });
        }
        setSelectedCells(next);
        lastSelectedRowRef.current = row;
      } else if (e.ctrlKey || e.metaKey) {
        setSelectedCells((prev) => {
          const exists = prev.some((c) => c.row === row && c.col === col);
          if (exists)
            return prev.filter((c) => !(c.row === row && c.col === col));
          return [...prev, { row, col }];
        });
      } else {
        selectCell(row, col);
        lastSelectedRowRef.current = row;
      }
    },
    [activeCell, selectCell],
  );

  const focusCellControl = useCallback((row, col) => {
    window.requestAnimationFrame(() => {
      const selector = `[data-batch-cell-editor="${row}:${col}"], [data-batch-cell-input="${row}:${col}"]`;
      const node = tableRef.current?.querySelector(selector);
      if (!node) return;
      node.focus?.();
      if (col === 'count') {
        if (typeof node.select === 'function') {
          node.select();
          return;
        }
        const selection = window.getSelection?.();
        const range = document.createRange?.();
        if (selection && range) {
          range.selectNodeContents(node);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    });
  }, []);

  // ────────────────── drag fill / drag select ──────────────────
  const startFillDrag = useCallback((row, col) => {
    setIsDraggingSelect(false);
    setSelectStartCell(null);
    setIsDraggingFill(true);
    setFillStartCell({ row, col });
    setFillEndRow(row);
  }, []);

  const startSelectDrag = useCallback(
    (row, col) => {
      if (isDraggingFill) return;
      setIsDraggingSelect(true);
      setSelectStartCell({ row, col });
      setActiveCell({ row, col });
      setSelectedCells([{ row, col }]);
    },
    [isDraggingFill],
  );

  const handleTableMouseMove = useCallback(
    (e) => {
      if (!isDraggingFill && !isDraggingSelect) return;
      const target = e.target;
      const trEl = target?.closest?.('tr[data-row-index]');
      if (!trEl) return;
      const rowIndex = parseInt(trEl.dataset.rowIndex || '-1', 10);
      if (rowIndex < 0) return;
      if (isDraggingFill && fillStartCell) {
        setFillEndRow(rowIndex);
        const start = fillStartCell.row;
        const end = rowIndex;
        const minRow = Math.min(start, end);
        const maxRow = Math.max(start, end);
        const preview = [];
        for (let r = minRow; r <= maxRow; r += 1) {
          if (r !== start) preview.push(r);
        }
        setFillPreviewRows(preview);
      }
      if (isDraggingSelect && selectStartCell) {
        const col = selectStartCell.col;
        const start = selectStartCell.row;
        const end = rowIndex;
        const minRow = Math.min(start, end);
        const maxRow = Math.max(start, end);
        const next = [];
        for (let r = minRow; r <= maxRow; r += 1) {
          next.push({ row: r, col });
        }
        setSelectedCells(next);
      }
    },
    [isDraggingFill, isDraggingSelect, fillStartCell, selectStartCell],
  );

  const handleTableMouseUp = useCallback(() => {
    if (
      isDraggingFill &&
      fillStartCell &&
      fillEndRow !== null &&
      fillEndRow !== fillStartCell.row
    ) {
      const sourceValue = rows[fillStartCell.row]?.[fillStartCell.col];
      const start = fillStartCell.row;
      const end = fillEndRow;
      const minRow = Math.min(start, end);
      const maxRow = Math.max(start, end);
      setRows((prev) => {
        const next = [...prev];
        for (let r = minRow; r <= maxRow; r += 1) {
          if (r === start || !next[r]) continue;
          const value = Array.isArray(sourceValue)
            ? [...sourceValue]
            : sourceValue;
          next[r] = { ...next[r], [fillStartCell.col]: value };
        }
        return next;
      });
      const newSel = [];
      for (let r = minRow; r <= maxRow; r += 1) {
        newSel.push({ row: r, col: fillStartCell.col });
      }
      setSelectedCells(newSel);
      Toast.success(t('已填充 {{count}} 行', { count: Math.abs(end - start) }));
    }
    setIsDraggingFill(false);
    setFillStartCell(null);
    setFillEndRow(null);
    setFillPreviewRows([]);
    setIsDraggingSelect(false);
    setSelectStartCell(null);
  }, [isDraggingFill, fillStartCell, fillEndRow, rows, t]);

  // ────────────────── row ops ──────────────────
  const updateCellValue = useCallback((rowIndex, col, value) => {
    setRows((prev) =>
      prev[rowIndex]?.[col] === value
        ? prev
        : updateRowAt(prev, rowIndex, { [col]: value }),
    );
  }, []);

  const addRows = useCallback(
    (count) => {
      if (rows.length + count > BATCH_TABLE_MAX_ROWS) {
        Toast.warning(t('最多 {{count}} 行', { count: BATCH_TABLE_MAX_ROWS }));
        return;
      }
      const newRows = Array(count)
        .fill(0)
        .map(() => createBatchRow());
      setRows((prev) => [...prev, ...newRows]);
    },
    [rows.length, t],
  );

  const deleteSelectedRows = useCallback(() => {
    if (selectedRows.size === 0) {
      Toast.info(t('请先勾选要删除的行'));
      return;
    }
    const removedTaskIds = [...selectedRows].flatMap(
      (index) => rows[index]?.taskIds || [],
    );
    if (removedTaskIds.length) {
      onDeleteTasks?.(removedTaskIds);
    }
    const removedRowIds = [...selectedRows].map((index) => rows[index]?.id);
    setRows((prev) => removeRowsAt(prev, selectedRows));
    setRowGalleryRow((current) =>
      removedRowIds.includes(current) ? null : current,
    );
    setSelectedRows(new Set());
    setSelectedCells([]);
    setActiveCell(null);
  }, [onDeleteTasks, rows, selectedRows, t]);

  const fillColumn = useCallback(
    (colName) => {
      if (!activeCell) {
        Toast.info(t('请先选中要填充的单元格'));
        return;
      }
      const sourceValue = rows[activeCell.row]?.[colName];
      const isEmpty =
        sourceValue == null ||
        (typeof sourceValue === 'string' && sourceValue.trim() === '') ||
        (Array.isArray(sourceValue) && sourceValue.length === 0);
      if (isEmpty) {
        Toast.info(t('选中的单元格没有数据'));
        return;
      }
      setRows((prev) =>
        prev.map((row) => ({
          ...row,
          [colName]: Array.isArray(sourceValue)
            ? [...sourceValue]
            : sourceValue,
        })),
      );
      Toast.success(t('填充完成'));
    },
    [activeCell, rows, t],
  );

  // ────────────────── checkbox row ops ──────────────────
  const toggleRowSelection = useCallback((rowIndex, shiftKey = false) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastCheckedRowRef.current != null) {
        const start = Math.min(lastCheckedRowRef.current, rowIndex);
        const end = Math.max(lastCheckedRowRef.current, rowIndex);
        for (let i = start; i <= end; i += 1) next.add(i);
      } else if (next.has(rowIndex)) {
        next.delete(rowIndex);
      } else {
        next.add(rowIndex);
      }
      return next;
    });
    lastCheckedRowRef.current = rowIndex;
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedRows((prev) => {
      if (prev.size === rows.length && rows.length > 0) return new Set();
      const next = new Set();
      rows.forEach((_, idx) => next.add(idx));
      return next;
    });
  }, [rows]);

  const invertSelection = useCallback(() => {
    setSelectedRows((prev) => {
      const next = new Set();
      rows.forEach((_, idx) => {
        if (!prev.has(idx)) next.add(idx);
      });
      return next;
    });
  }, [rows]);

  // ────────────────── reference image cell ──────────────────
  const addImageToRow = useCallback((rowIndex, imageUrl) => {
    setRows((prev) => {
      const row = prev[rowIndex];
      if (!row) return prev;
      if (row.images.includes(imageUrl)) return prev;
      return updateRowAt(prev, rowIndex, {
        images: [...row.images, imageUrl],
      });
    });
  }, []);

  const removeImageFromRow = useCallback((rowIndex, imageUrl) => {
    setRows((prev) => {
      const row = prev[rowIndex];
      if (!row) return prev;
      return updateRowAt(prev, rowIndex, {
        images: row.images.filter((url) => url !== imageUrl),
      });
    });
  }, []);

  const triggerRowImageUpload = useCallback((rowIndex) => {
    uploadTargetRowRef.current = rowIndex;
    rowImageInputRef.current?.click();
  }, []);

  const handleRowImageUpload = useCallback(
    async (e) => {
      const files = e.target.files;
      const targetRow = uploadTargetRowRef.current;
      if (!files || !files.length || targetRow == null) return;
      const imgs = Array.from(files).filter((f) =>
        f.type?.startsWith('image/'),
      );
      try {
        for (const file of imgs) {
          const dataUrl = await readImageFileAsDataUrl(file);
          addImageToRow(targetRow, dataUrl);
        }
      } catch {
        Toast.error(t('读取图片失败'));
      } finally {
        if (rowImageInputRef.current) rowImageInputRef.current.value = '';
        uploadTargetRowRef.current = null;
      }
    },
    [addImageToRow, t],
  );

  const handleRowDragOver = useCallback((e, rowIndex) => {
    if (
      !Array.from(e.dataTransfer.items || []).some(
        (item) => item.kind === 'file',
      )
    )
      return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOverRowIndex(rowIndex);
  }, []);

  const handleRowDragLeave = useCallback((e) => {
    const related = e.relatedTarget;
    if (!related || !e.currentTarget.contains(related)) {
      setDragOverRowIndex(null);
    }
  }, []);

  const handleRowDrop = useCallback(
    async (e, rowIndex) => {
      e.preventDefault();
      setDragOverRowIndex(null);
      const files = Array.from(e.dataTransfer.files || []).filter((f) =>
        f.type?.startsWith('image/'),
      );
      if (!files.length) return;
      try {
        for (const file of files) {
          const dataUrl = await readImageFileAsDataUrl(file);
          addImageToRow(rowIndex, dataUrl);
        }
        Toast.success(
          t('已添加 {{count}} 张图片到第 {{row}} 行', {
            count: files.length,
            row: rowIndex + 1,
          }),
        );
      } catch {
        Toast.error(t('读取图片失败'));
      }
    },
    [addImageToRow, t],
  );

  // ────────────────── batch import images ──────────────────
  const previewUrls = useMemo(
    () =>
      pendingImportFiles.slice(0, 12).map((file) => URL.createObjectURL(file)),
    [pendingImportFiles],
  );
  useEffect(
    () => () => {
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
    },
    [previewUrls],
  );

  const handleBatchImportSelect = useCallback(
    (e) => {
      const files = Array.from(e.target.files || []).filter((f) =>
        f.type?.startsWith('image/'),
      );
      if (!files.length) {
        Toast.warning(t('请选择图片文件'));
        return;
      }
      setPendingImportFiles(files);
      const defaultStart = activeCell ? activeCell.row + 1 : 1;
      setImportStartRow(Math.min(defaultStart, rows.length));
      setBatchImportModalOpen(true);
      if (batchImageInputRef.current) batchImageInputRef.current.value = '';
    },
    [activeCell, rows.length, t],
  );

  const executeBatchImport = useCallback(async () => {
    if (!pendingImportFiles.length) {
      setBatchImportModalOpen(false);
      return;
    }
    const perRow = imagesPerRow;
    const rowsNeeded = Math.ceil(pendingImportFiles.length / perRow);
    const startIdx = importStartRow - 1;

    try {
      const dataUrls = await Promise.all(
        pendingImportFiles.map((file) => readImageFileAsDataUrl(file)),
      );

      setRows((prev) => {
        const next = [...prev];
        let imgIdx = 0;
        for (let i = 0; i < rowsNeeded; i += 1) {
          const targetIdx = startIdx + i;
          const rowImages = [];
          for (let j = 0; j < perRow && imgIdx < dataUrls.length; j += 1) {
            rowImages.push(dataUrls[imgIdx]);
            imgIdx += 1;
          }
          if (next[targetIdx]) {
            next[targetIdx] = {
              ...next[targetIdx],
              images: [...next[targetIdx].images, ...rowImages],
            };
          } else {
            next.push(createBatchRow({ images: rowImages }));
          }
        }
        return next.slice(0, BATCH_TABLE_MAX_ROWS);
      });

      Toast.success(
        t('已选择 {{count}} 张图片', { count: pendingImportFiles.length }),
      );
    } catch {
      Toast.error(t('导入失败'));
    } finally {
      setPendingImportFiles([]);
      setBatchImportModalOpen(false);
    }
  }, [pendingImportFiles, imagesPerRow, importStartRow, t]);

  // ────────────────── excel import / export ──────────────────
  const handleExcelImport = useCallback(
    async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const imported = await parseSpreadsheetFile(file);
        if (!imported.length) {
          Toast.info(t('文件中没有可用提示词'));
          return;
        }
        setRows((prev) => {
          const trimmed = prev.filter((row) => row.prompt && row.prompt.trim());
          const next = [...trimmed, ...imported];
          return next.slice(0, BATCH_TABLE_MAX_ROWS);
        });
        Toast.success(t('已导入 {{count}} 行', { count: imported.length }));
      } catch (error) {
        console.error(error);
        Toast.error(t('文件解析失败'));
      } finally {
        if (excelInputRef.current) excelInputRef.current.value = '';
      }
    },
    [t],
  );

  // ────────────────── preview status derivation ──────────────────
  const taskById = useMemo(() => {
    const map = new Map();
    (tasks || []).forEach((task) => map.set(task.id, task));
    return map;
  }, [tasks]);

  const getRowTasksInfo = useCallback(
    (row) => {
      if (!row.taskIds?.length) {
        return {
          status: 'idle',
          tasks: [],
          completedItems: [],
          completedUrls: [],
          completedCount: 0,
          failedCount: 0,
          cancelledCount: 0,
          processingCount: 0,
        };
      }
      const related = row.taskIds.map((id) => taskById.get(id)).filter(Boolean);
      const completed = related.filter(
        (task) => task.status === TASK_STATUS.SUCCESS,
      );
      const cancelled = related.filter(isCreationTaskCancelled);
      const failed = related.filter(
        (task) =>
          task.status === TASK_STATUS.ERROR && !isCreationTaskCancelled(task),
      );
      const processing = related.filter(isCreationTaskActive);
      let status = 'idle';
      if (processing.length > 0) status = 'generating';
      else if (failed.length > 0 && completed.length > 0) status = 'partial';
      else if (failed.length > 0) status = 'failed';
      else if (cancelled.length > 0 && completed.length === 0)
        status = 'cancelled';
      else if (cancelled.length > 0 && completed.length > 0) status = 'partial';
      else if (completed.length > 0) status = 'completed';
      const completedItems = completed.map((task) => ({
        id: task.id,
        url: task.url,
        remoteUrl: task.remoteUrl,
        aspectRatio: getImageAspectRatio(task, getImageAspectRatio(row)),
        task,
      }));
      return {
        status,
        tasks: related,
        failedTasks: failed,
        cancelledTasks: cancelled,
        completedItems,
        completedUrls: completedItems
          .map(getTaskImageSourceUrl)
          .filter(Boolean),
        completedCount: completed.length,
        failedCount: failed.length,
        cancelledCount: cancelled.length,
        processingCount: processing.length,
        firstErrorTask: failed.find((task) => task.error) || failed[0] || null,
        firstError:
          failed.find((task) => task.error)?.error || failed[0]?.error || '',
      };
    },
    [taskById],
  );

  // ────────────────── select failed rows ──────────────────
  const selectFailedRows = useCallback(() => {
    const failed = [];
    rows.forEach((row, idx) => {
      const info = getRowTasksInfo(row);
      if (info.status === 'failed' || info.status === 'partial') {
        failed.push(idx);
      }
    });
    if (!failed.length) {
      Toast.info(t('没有失败的行'));
      return;
    }
    setSelectedRows(new Set(failed));
    Toast.success(t('已选中 {{count}} 个失败行', { count: failed.length }));
  }, [rows, getRowTasksInfo, t]);

  // ────────────────── submit ──────────────────
  const submitSelected = useCallback(async () => {
    if (!inputs.model) {
      Toast.warning(t('请先选择模型'));
      return;
    }
    const selectedIndices = [...selectedRows].sort((a, b) => a - b);
    if (!selectedIndices.length) {
      Toast.warning(t('请先勾选要生成的行'));
      return;
    }
    const validRows = selectedIndices
      .map((idx) => ({ row: rows[idx], idx }))
      .filter(({ row }) => row && row.prompt && row.prompt.trim());
    if (!validRows.length) {
      Toast.warning(t('选中的行没有可用提示词'));
      return;
    }
    const totalTasks = validRows.reduce(
      (sum, { row }) => sum + (Number(row.count) || 1),
      0,
    );
    const generatingRows = validRows.filter(
      ({ row }) => getRowTasksInfo(row).status === 'generating',
    );
    if (totalTasks >= 100 || generatingRows.length > 0) {
      const ok = await new Promise((resolve) => {
        Modal.confirm({
          title: t('确认提交'),
          content: (
            <div>
              {generatingRows.length > 0 && (
                <p>
                  {t('有 {{count}} 行正在生成中', {
                    count: generatingRows.length,
                  })}
                </p>
              )}
              {totalTasks >= 100 && (
                <p>
                  {t('即将生成 {{count}} 个任务，这可能需要较长时间', {
                    count: totalTasks,
                  })}
                </p>
              )}
              <p>{t('是否继续')}</p>
            </div>
          ),
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!ok) return;
    }

    setIsSubmitting(true);
    try {
      const allNewTasks = [];
      const newTaskIdsByRow = new Map();
      const obsoleteTaskIds = validRows.flatMap(({ row }) => row.taskIds || []);
      if (obsoleteTaskIds.length) {
        onDeleteTasks?.(obsoleteTaskIds);
      }
      for (const { row, idx } of validRows) {
        const imageParams = createBatchRowImageParams(row, {
          quality: resolution,
          model: selectedModelRef.current || effectiveImageModel,
          group: selectedGroupRef.current || effectiveImageGroup,
          source: IMAGE_TASK_SOURCE.BATCH,
          batchRowIndex: idx,
        });
        const queued = createImageBatchQueueItems({
          count: imageParams.count,
          prompts: [imageParams.prompt],
          ratio: imageParams.ratio,
          size: imageParams.size,
          quality: imageParams.quality,
          model: imageParams.model,
          group: imageParams.group,
          width: imageParams.width,
          height: imageParams.height,
          referenceImages: imageParams.referenceImages,
          source: imageParams.source,
          batchRowId: imageParams.batchRowId,
          batchRowIndex: imageParams.batchRowIndex,
        });
        allNewTasks.push(...queued);
        newTaskIdsByRow.set(
          idx,
          queued.map((task) => task.id),
        );
      }
      setRows((prev) =>
        prev.map((row, idx) => {
          const ids = newTaskIdsByRow.get(idx);
          if (!ids) return row;
          return { ...row, taskIds: ids };
        }),
      );
      onEnqueue?.(allNewTasks, concurrency);
      Toast.success(
        t('已提交 {{count}} 个任务，并发数 {{concurrency}}', {
          count: allNewTasks.length,
          concurrency,
        }),
      );
    } catch (error) {
      console.error(error);
      Toast.error(t('提交失败'));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    effectiveImageModel,
    effectiveImageGroup,
    selectedRows,
    rows,
    resolution,
    concurrency,
    getRowTasksInfo,
    onEnqueue,
    onDeleteTasks,
    t,
  ]);

  // ────────────────── download selected ──────────────────
  const downloadSelectedImages = useCallback(async () => {
    const indices = [...selectedRows].sort((a, b) => a - b);
    if (!indices.length) {
      Toast.warning(t('请先勾选要下载的行'));
      return;
    }
    const targets = [];
    indices.forEach((rowIdx) => {
      const row = rows[rowIdx];
      if (!row) return;
      const info = getRowTasksInfo(row);
      info.completedItems.forEach((item, idx) => {
        const safePrompt = (row.prompt || '')
          .slice(0, 24)
          .replace(/[^\w\u4e00-\u9fa5]+/g, '_');
        targets.push({
          item,
          url: getTaskImageSourceUrl(item),
          name: `row${rowIdx + 1}_${idx + 1}_${safePrompt || 'image'}.png`,
        });
      });
    });
    if (!targets.length) {
      Toast.warning(t('选中的行没有已生成的图片'));
      return;
    }
    Toast.info(t('开始下载 {{count}} 个图片', { count: targets.length }));
    for (const item of targets) {
      try {
        const resolved = await resolveCachedImageUrl(
          item.item?.id,
          getTaskImageSourceUrl(item.item) || item.url,
        ).catch(() => ({ url: item.url, fromCache: false }));
        const downloadUrl = resolved.url || item.url;
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = item.name;
        link.target = '_blank';
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch (error) {
        console.warn('download failed', error);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    Toast.success(t('下载完成'));
  }, [selectedRows, rows, getRowTasksInfo, t]);

  const downloadResultRow = useCallback(
    async (row, rowIndex, info) => {
      const items = info.completedItems || [];
      if (!items.length) {
        Toast.warning(t('当前结果没有可下载图片'));
        return;
      }
      const safePrompt = (row.prompt || '')
        .slice(0, 24)
        .replace(/[^\w\u4e00-\u9fa5]+/g, '_');
      Toast.info(t('开始下载 {{count}} 个图片', { count: items.length }));
      for (const [idx, item] of items.entries()) {
        const resolved = await resolveCachedImageUrl(
          item.id,
          getTaskImageSourceUrl(item),
        ).catch(() => ({ url: getTaskImageSourceUrl(item), fromCache: false }));
        const downloadUrl = resolved.url || getTaskImageSourceUrl(item);
        // eslint-disable-next-line no-await-in-loop
        await downloadBatchAssetUrl(
          downloadUrl,
          `row${rowIndex + 1}_${idx + 1}_${safePrompt || 'image'}.png`,
        );
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => window.setTimeout(resolve, 160));
      }
      Toast.success(t('下载完成'));
    },
    [t],
  );

  // ────────────────── export excel ──────────────────
  const downloadResultItem = useCallback(
    async (row, rowIndex, item, itemIndex) => {
      if (!item) return;
      const safePrompt = (row?.prompt || '')
        .slice(0, 24)
        .replace(/[^\w\u4e00-\u9fa5]+/g, '_');
      const resolved = await resolveCachedImageUrl(
        item.id,
        getTaskImageSourceUrl(item),
      ).catch(() => ({ url: getTaskImageSourceUrl(item), fromCache: false }));
      const downloadUrl = resolved.url || getTaskImageSourceUrl(item);
      if (!downloadUrl) {
        Toast.warning(t('当前结果没有可下载图片'));
        return;
      }
      await downloadBatchAssetUrl(
        downloadUrl,
        `row${rowIndex + 1}_${itemIndex + 1}_${safePrompt || 'image'}.png`,
      );
    },
    [t],
  );

  const exportToExcel = useCallback(async () => {
    try {
      const previewByRow = {};
      const statusByRow = {};
      rows.forEach((row) => {
        const info = getRowTasksInfo(row);
        previewByRow[row.id] = info.completedUrls;
        const map = {
          idle: t('空闲'),
          generating: t('生成中'),
          completed: t('已完成'),
          failed: t('失败'),
          partial: t('部分完成'),
        };
        statusByRow[row.id] = map[info.status] || '';
      });
      await exportBatchRowsToExcel(rows, { previewByRow, statusByRow });
      Toast.success(t('已导出 {{count}} 行', { count: rows.length }));
    } catch (error) {
      console.error(error);
      Toast.error(t('导出失败'));
    }
  }, [rows, getRowTasksInfo, t]);

  const handleDownloadTemplate = useCallback(async () => {
    try {
      await downloadBatchTemplate();
      Toast.success(t('模板下载成功'));
    } catch (error) {
      console.error(error);
      Toast.error(t('下载失败'));
    }
  }, [t]);

  const batchListColumns = useMemo(
    () => [
      {
        key: 'prompt',
        label: t('提示词'),
        type: 'text',
        width: '38%',
        onFill: fillColumn,
      },
      {
        key: 'size',
        label: t('尺寸'),
        type: 'select',
        width: 100,
        options: batchSizeOptions,
        onFill: fillColumn,
      },
      {
        key: 'images',
        label: t('参考图'),
        type: 'images',
        width: 170,
        onFill: fillColumn,
        onPreviewImage: (url) =>
          onPreview?.({ url, type: 'image', title: t('参考图') }),
        onRemoveImage: removeImageFromRow,
        onAddImage: triggerRowImageUpload,
      },
      {
        key: 'count',
        label: t('数量'),
        type: 'number',
        width: 70,
        defaultValue: 1,
        normalize: normalizeBatchCount,
        onFill: fillColumn,
      },
      {
        key: 'preview',
        label: t('预览'),
        type: 'preview',
        width: 200,
        fillable: false,
        getInfo: getRowTasksInfo,
        renderThumb: (item, idx) => (
          <CachedPreviewThumb
            key={`${item.id || item.url}-${idx}`}
            item={item}
            onPreview={onPreview}
            t={t}
          />
        ),
        onMore: (row) => setRowGalleryRow(row.id),
        onFailedClick: (rowIndex) => {
          if (!selectedRows.has(rowIndex)) toggleRowSelection(rowIndex);
        },
      },
    ],
    [
      batchSizeOptions,
      fillColumn,
      getRowTasksInfo,
      onPreview,
      removeImageFromRow,
      selectedRows,
      t,
      toggleRowSelection,
      triggerRowImageUpload,
    ],
  );

  const galleryRow =
    rowGalleryRow != null ? rows.find((row) => row.id === rowGalleryRow) : null;
  const galleryRowIndex = galleryRow
    ? rows.findIndex((row) => row.id === galleryRow.id)
    : -1;
  const galleryInfo = galleryRow ? getRowTasksInfo(galleryRow) : null;
  const renderGroupThumb = useCallback(
    (item) => <CachedResultImage item={item} />,
    [],
  );

  // Rows that have triggered any generation, for the folder grid below
  const resultRows = useMemo(() => {
    return rows
      .map((row, idx) => ({ row, idx, info: getRowTasksInfo(row) }))
      .filter(({ info }) => info.tasks.length > 0);
  }, [rows, getRowTasksInfo]);

  const resultsPageSize = useBatchFolderPageSize(
    resultsGridRef,
    `image:${resultRows.length}`,
    {
      minCardWidth: 220,
      gap: 12,
      desktopRows: 2,
      mobileRows: 2,
    },
  );
  const resultsPageCount = getPageCount(resultRows.length, resultsPageSize);

  useEffect(() => {
    setResultsPage((page) => clampNumber(page, 1, resultsPageCount));
  }, [resultsPageCount]);

  const resultsStart = (resultsPage - 1) * resultsPageSize;
  const pagedResultRows = useMemo(
    () => resultRows.slice(resultsStart, resultsStart + resultsPageSize),
    [resultRows, resultsPageSize, resultsStart],
  );
  const failedResultTaskCount = resultRows.reduce(
    (sum, { info }) => sum + info.failedCount,
    0,
  );
  const settledResultTaskCount = resultRows.reduce(
    (sum, { info }) =>
      sum +
      (info.tasks || []).filter(
        (task) =>
          task.status === TASK_STATUS.SUCCESS || isCreationTaskCancelled(task),
      ).length,
    0,
  );
  const retryableResultTaskCount = resultRows.reduce(
    (sum, { info }) => sum + info.failedCount + info.cancelledCount,
    0,
  );
  const activeResultTaskCount = resultRows.reduce(
    (sum, { info }) => sum + info.processingCount,
    0,
  );

  useEffect(() => {
    const validIds = new Set(resultRows.map(({ row }) => row.id));
    setSelectedResultRowIds((prev) => {
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [resultRows]);

  useEffect(() => {
    if (!resultSelectionMode) {
      setSelectedResultRowIds(new Set());
    }
  }, [resultSelectionMode]);

  const toggleResultSelection = useCallback((rowId) => {
    setSelectedResultRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }, []);

  const selectVisibleResults = useCallback(() => {
    setSelectedResultRowIds(new Set(pagedResultRows.map(({ row }) => row.id)));
  }, [pagedResultRows]);

  const selectedResultRows = useMemo(
    () => resultRows.filter(({ row }) => selectedResultRowIds.has(row.id)),
    [resultRows, selectedResultRowIds],
  );
  const retryableSelectedResultTaskCount = selectedResultRows.reduce(
    (sum, { info }) => sum + info.failedCount + info.cancelledCount,
    0,
  );
  const downloadableSelectedResultTaskCount = selectedResultRows.reduce(
    (sum, { info }) => sum + info.completedCount,
    0,
  );
  const activeSelectedResultTaskCount = selectedResultRows.reduce(
    (sum, { info }) => sum + info.processingCount,
    0,
  );

  const downloadAllResults = useCallback(async () => {
    for (const { row, idx, info } of resultRows) {
      if (info.completedCount > 0) {
        await downloadResultRow(row, idx, info);
      }
    }
  }, [downloadResultRow, resultRows]);

  const downloadSelectedResultRows = useCallback(async () => {
    const downloadableRows = selectedResultRows.filter(
      ({ info }) => info.completedCount > 0,
    );
    if (!downloadableRows.length) {
      Toast.warning(t('选中项中没有可下载结果'));
      return;
    }
    for (const { row, idx, info } of downloadableRows) {
      // eslint-disable-next-line no-await-in-loop
      await downloadResultRow(row, idx, info);
    }
  }, [downloadResultRow, selectedResultRows, t]);

  const deleteResultRows = useCallback(
    (items) => {
      const taskIds = items.flatMap(({ item, info }) => {
        if (item?.task?.id) return [item.task.id];
        return (info.tasks || []).map((task) => task.id);
      });
      if (!taskIds.length) return;
      onDeleteTasks?.(taskIds);
      setSelectedResultRowIds(new Set());
      setResultSelectionMode(false);
    },
    [onDeleteTasks],
  );

  const cancelResultRows = useCallback(
    (items) => {
      const taskIds = items.flatMap(({ info }) =>
        (info.tasks || []).filter(isCreationTaskActive).map((task) => task.id),
      );
      if (!taskIds.length) return;
      onCancelTasks?.(taskIds);
      setSelectedResultRowIds(new Set());
      setResultSelectionMode(false);
    },
    [onCancelTasks],
  );

  const cancelAllActiveResults = useCallback(() => {
    cancelResultRows(resultRows);
  }, [cancelResultRows, resultRows]);

  const retryResultRows = useCallback(
    (items) => {
      const retryTasks = items.flatMap(({ info }) => [
        ...(info.failedTasks || []),
        ...(info.cancelledTasks || []),
      ]);
      if (!retryTasks.length) {
        Toast.warning(t('选中项中没有可重试任务'));
        return;
      }
      retryTasks.forEach((task) => onRetryTask?.(task));
      setSelectedResultRowIds(new Set());
      setResultSelectionMode(false);
    },
    [onRetryTask, t],
  );

  const retrySelectedResultRows = useCallback(() => {
    retryResultRows(selectedResultRows);
  }, [retryResultRows, selectedResultRows]);

  const retryAllFailedResultRows = useCallback(() => {
    retryResultRows(resultRows);
  }, [retryResultRows, resultRows]);

  const showResultError = useCallback(
    (info) => {
      const task = info.firstErrorTask || info.failedTasks?.[0];
      if (!task || !onShowError) return;
      const summary = t('当前结果组 {{count}} 个任务失败', {
        count: info.failedCount,
      });
      onShowError({
        ...task,
        error: task.error ? `${summary}\n${task.error}` : summary,
      });
    },
    [onShowError, t],
  );

  const deleteFailedResults = useCallback(() => {
    const taskIds = resultRows.flatMap(({ info }) =>
      (info.tasks || [])
        .filter(
          (task) =>
            task.status === TASK_STATUS.ERROR && !isCreationTaskCancelled(task),
        )
        .map((task) => task.id),
    );
    if (!taskIds.length) {
      Toast.info(t('没有失败的行'));
      return;
    }
    onDeleteTasks?.(taskIds);
    setSelectedResultRowIds(new Set());
    setResultSelectionMode(false);
  }, [onDeleteTasks, resultRows, t]);

  const clearSettledResults = useCallback(() => {
    const taskIds = resultRows.flatMap(({ info }) =>
      (info.tasks || [])
        .filter(
          (task) =>
            task.status === TASK_STATUS.SUCCESS ||
            isCreationTaskCancelled(task),
        )
        .map((task) => task.id),
    );
    if (!taskIds.length) {
      Toast.info(t('没有已完成或已停止的任务'));
      return;
    }
    onDeleteTasks?.(taskIds);
    setSelectedResultRowIds(new Set());
    setResultSelectionMode(false);
  }, [onDeleteTasks, resultRows, t]);

  // ────────────────── render ──────────────────
  const batchResultLabels = useMemo(
    () => ({
      open: t('打开结果'),
      select: t('选择'),
      download: t('下载'),
      delete: t('删除'),
      stop: t('停止'),
      retry: t('重试'),
      error: t('查看错误'),
      failed: t('失败'),
      failedSuffix: t(' 失败'),
      cancelled: t('已停止'),
      generating: t('生成中'),
      partial: t('部分完成'),
      empty: t('暂无结果'),
      justNow: t('刚刚'),
      untitledPrompt: t('未命名提示词'),
    }),
    [t],
  );

  const batchResultGalleryStyle = useMemo(
    () => getBatchResultGalleryStyle('image'),
    [],
  );

  return (
    <>
      <BatchExcelShell>
        <input
          ref={excelInputRef}
          type='file'
          accept='.xlsx,.xls,.csv'
          className='hidden'
          style={{ display: 'none' }}
          onChange={handleExcelImport}
        />
        <input
          ref={batchImageInputRef}
          type='file'
          accept='image/*'
          multiple
          className='hidden'
          style={{ display: 'none' }}
          onChange={handleBatchImportSelect}
        />
        <input
          ref={rowImageInputRef}
          type='file'
          accept='image/*'
          multiple
          className='hidden'
          style={{ display: 'none' }}
          onChange={handleRowImageUpload}
        />

        <section className='ai-batch-listview__table-card'>
          <BatchExcelToolbar
            left={
              <>
                <Tooltip content={t('导出Excel')}>
                  <Button
                    type='tertiary'
                    icon={<Download size={14} />}
                    onClick={exportToExcel}
                  />
                </Tooltip>
                <Tooltip content={t('导入Excel')}>
                  <Button
                    type='tertiary'
                    icon={<Upload size={14} />}
                    onClick={() => excelInputRef.current?.click()}
                  />
                </Tooltip>
                <Tooltip content={t('批量导入图片')}>
                  <Button
                    type='tertiary'
                    icon={<ImageIcon size={14} />}
                    onClick={() => batchImageInputRef.current?.click()}
                  />
                </Tooltip>
                <Tooltip content={t('添加行')}>
                  <Button
                    type='tertiary'
                    icon={<Plus size={14} />}
                    onClick={() => setAddRowsModalOpen(true)}
                  />
                </Tooltip>
                <Tooltip content={t('下载模板')}>
                  <Button
                    type='tertiary'
                    icon={<FileDown size={14} />}
                    onClick={handleDownloadTemplate}
                  />
                </Tooltip>
                <span className='toolbar-divider' />
                <Tooltip content={t('填充完成')}>
                  <Button
                    type='tertiary'
                    theme='borderless'
                    icon={<Sparkles size={14} />}
                    onClick={selectFailedRows}
                  />
                </Tooltip>
                <Tooltip content={t('反选')}>
                  <Button
                    type='tertiary'
                    theme='borderless'
                    icon={<Repeat size={14} />}
                    onClick={invertSelection}
                  />
                </Tooltip>
                <span className='toolbar-divider' />
                <Button
                  type='tertiary'
                  theme='borderless'
                  icon={<Trash2 size={14} />}
                  onClick={deleteSelectedRows}
                >
                  {t('删除选中')}
                </Button>
                <span className='toolbar-divider' />
                <Button
                  type='tertiary'
                  icon={<Download size={14} />}
                  onClick={downloadSelectedImages}
                >
                  {t('下载选中')}
                </Button>
              </>
            }
            right={
              <>
                <ComposerSelect
                  value={effectiveImageGroup}
                  options={groupOptions}
                  onChange={(value) => {
                    selectedGroupRef.current = value;
                    handleInputChange('group', value);
                  }}
                />
                <ComposerSelect
                  value={effectiveImageModel}
                  options={modelOptions}
                  onChange={(value) => {
                    selectedModelRef.current = value;
                    handleInputChange('model', value);
                  }}
                  wide
                />
                {showQuality && (
                  <ComposerSelect
                    value={resolution}
                    options={imageQualityOptions.map((item) => ({
                      value: item.value,
                      label: item.label,
                    }))}
                    onChange={setResolution}
                  />
                )}
                <ComposerSelect
                  value={String(concurrency)}
                  options={CONCURRENCY_OPTIONS.map((n) => ({
                    value: String(n),
                    label: t('并发 {{n}}', { n }),
                  }))}
                  onChange={(v) => setConcurrency(clampCreationConcurrency(v))}
                />
                <Button
                  type='primary'
                  theme='solid'
                  className='batch-excel-generate-btn'
                  loading={isSubmitting}
                  disabled={!rows.length}
                  onClick={submitSelected}
                >
                  {t('生成选中')}
                </Button>
              </>
            }
          />

          <BatchListView
            variant='image'
            tableRef={tableRef}
            isDraggingFill={isDraggingFill}
            isDraggingSelect={isDraggingSelect}
            onMouseMove={handleTableMouseMove}
            onMouseUp={handleTableMouseUp}
            onMouseLeave={handleTableMouseUp}
            viewportHeight={IMAGE_BATCH_TABLE_VIEWPORT_HEIGHT}
            rowHeight={IMAGE_BATCH_TABLE_ROW_HEIGHT}
            headerHeight={IMAGE_BATCH_TABLE_HEADER_HEIGHT}
            rows={rows}
            columns={batchListColumns}
            activeCell={activeCell}
            selectedRows={selectedRows}
            selectedCellKeySet={selectedCellKeySet}
            dragOverRowIndex={dragOverRowIndex}
            fillPreviewRows={fillPreviewRowSet}
            onRowDragOver={handleRowDragOver}
            onRowDragLeave={handleRowDragLeave}
            onRowDrop={handleRowDrop}
            onToggleSelectAll={toggleSelectAll}
            onToggleRowSelection={toggleRowSelection}
            onCellClick={handleCellClick}
            onSelectCell={selectCell}
            onStartSelectDrag={startSelectDrag}
            onStartFillDrag={startFillDrag}
            onUpdateCellValue={updateCellValue}
            onFocusCellControl={focusCellControl}
            onClearCellSelection={clearCellSelection}
            editStartRef={promptEditStartRef}
            t={t}
          />
        </section>
      </BatchExcelShell>

      {/* Results panel */}
      <BatchResultGallery
        mediaType='image'
        title={t('我的作品')}
        meta={t('按批量任务展示生成的图片作品')}
        style={batchResultGalleryStyle}
        actions={
          <BatchResultsActions
            disabled={resultRows.length === 0}
            selectionMode={resultSelectionMode}
            selectedCount={selectedResultRowIds.size}
            onEnterSelection={() => setResultSelectionMode(true)}
            onExitSelection={() => setResultSelectionMode(false)}
            onSelectVisible={selectVisibleResults}
            onDownloadSelected={downloadSelectedResultRows}
            onRetrySelected={onRetryTask ? retrySelectedResultRows : undefined}
            onCancelSelected={
              onCancelTasks
                ? () => cancelResultRows(selectedResultRows)
                : undefined
            }
            onDeleteSelected={
              onDeleteTasks
                ? () => deleteResultRows(selectedResultRows)
                : undefined
            }
            onDownloadAll={downloadAllResults}
            onRetryFailed={onRetryTask ? retryAllFailedResultRows : undefined}
            onCancelActive={onCancelTasks ? cancelAllActiveResults : undefined}
            activeCount={activeResultTaskCount}
            activeSelectedCount={activeSelectedResultTaskCount}
            downloadableSelectedCount={downloadableSelectedResultTaskCount}
            retryableSelectedCount={retryableSelectedResultTaskCount}
            retryableCount={retryableResultTaskCount}
            onClearSettled={onDeleteTasks ? clearSettledResults : undefined}
            settledCount={settledResultTaskCount}
            onDeleteFailed={onDeleteTasks ? deleteFailedResults : undefined}
            failedCount={failedResultTaskCount}
            onDeleteAll={
              onDeleteTasks ? () => deleteResultRows(resultRows) : undefined
            }
            t={t}
          />
        }
        gridRef={resultsGridRef}
        isEmpty={pagedResultRows.length === 0}
        emptyState={
          <CreationGalleryEmptyState icon={<ImageIcon size={22} />}>
            <span>{t('暂无作品')}</span>
          </CreationGalleryEmptyState>
        }
        pagination={
          <BatchPagination
            total={resultRows.length}
            pageSize={resultsPageSize}
            currentPage={resultsPage}
            onPageChange={setResultsPage}
            className='ai-creation-pagination-bar'
            countClassName='ai-creation-pagination-count'
            showQuickJumper
            t={t}
          />
        }
      >
        {pagedResultRows.map(({ row, idx, info }) => (
          <BatchResultFolderCard
            key={row.id}
            mediaType='image'
            rowId={row.id}
            title={row.prompt || batchResultLabels.untitledPrompt}
            timeLabel={
              formatBatchResultTimeLabel(info.tasks[0]?.created_at) ||
              batchResultLabels.justNow
            }
            status={info.status}
            mediaItems={info.completedItems}
            totalCount={info.tasks.length}
            completedCount={info.completedCount}
            processingCount={info.processingCount}
            failedCount={info.failedCount}
            cancelledCount={info.cancelledCount}
            errorMessage={info.firstError}
            selectionMode={resultSelectionMode}
            selected={selectedResultRowIds.has(row.id)}
            onToggleSelect={toggleResultSelection}
            onOpen={() => {
              if (info.tasks.length === 1 && info.completedCount === 1) {
                openCachedImagePreview(
                  info.completedItems[0],
                  onPreview,
                  t('我的作品'),
                );
              } else if (info.tasks.length > 1 || info.completedCount > 1) {
                setRowGalleryRow(row.id);
              }
            }}
            onDownload={() => downloadResultRow(row, idx, info)}
            onCancel={
              onCancelTasks && info.processingCount > 0
                ? () => cancelResultRows([{ row, idx, info }])
                : undefined
            }
            onRetry={
              onRetryTask && (info.failedCount > 0 || info.cancelledCount > 0)
                ? () => retryResultRows([{ row, idx, info }])
                : undefined
            }
            onShowError={
              onShowError && info.failedCount > 0
                ? () => showResultError(info)
                : undefined
            }
            onDelete={
              onDeleteTasks && info.tasks.length
                ? () => onDeleteTasks(info.tasks.map((task) => task.id))
                : undefined
            }
            renderMedia={(item) => <BatchImageResultTile item={item} />}
            labels={batchResultLabels}
          />
        ))}
      </BatchResultGallery>
      <Modal
        title={t('添加行')}
        visible={addRowsModalOpen}
        onCancel={() => setAddRowsModalOpen(false)}
        onOk={() => {
          addRows(addRowsCount);
          setAddRowsModalOpen(false);
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>{t('添加行数：')}</span>
          <InputNumber
            min={1}
            max={100}
            value={addRowsCount}
            onChange={(value) => setAddRowsCount(Number(value) || 1)}
            style={{ width: 120 }}
            autoFocus
          />
        </div>
      </Modal>

      {/* Batch import images modal */}
      <Modal
        title={t('批量导入图片')}
        visible={batchImportModalOpen}
        onCancel={() => {
          setPendingImportFiles([]);
          setBatchImportModalOpen(false);
        }}
        onOk={executeBatchImport}
        okText={t('确认导入')}
        cancelText={t('取消')}
        width={520}
      >
        <p style={{ color: '#666', marginBottom: 12 }}>
          {t('已选择 {{count}} 张图片', {
            count: pendingImportFiles.length,
          })}
        </p>
        <div className='batch-excel-import-settings'>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
            }}
          >
            <span>{t('从第几行开始：')}</span>
            <InputNumber
              min={1}
              max={
                rows.length +
                Math.ceil(pendingImportFiles.length / Math.max(1, imagesPerRow))
              }
              value={importStartRow}
              onChange={(v) => setImportStartRow(Math.max(1, Number(v) || 1))}
              style={{ width: 90 }}
            />
          </label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
            }}
          >
            <span>{t('每行图片数：')}</span>
            <div className='per-row-options'>
              {[1, 2, 3, 4, 5].map((num) => (
                <button
                  key={num}
                  type='button'
                  className={clsx(
                    'per-row-btn',
                    imagesPerRow === num && 'active',
                  )}
                  onClick={() => setImagesPerRow(num)}
                >
                  {num}
                </button>
              ))}
            </div>
          </label>
        </div>
        <p style={{ color: '#888', fontSize: 12, marginTop: 12 }}>
          {t('从第 {{row}} 行开始，填充 {{rows}} 行，每行 {{per}} 张图片', {
            row: importStartRow,
            rows: Math.ceil(
              pendingImportFiles.length / Math.max(1, imagesPerRow),
            ),
            per: imagesPerRow,
          })}
        </p>
        <div className='batch-excel-image-preview-grid'>
          {previewUrls.map((url, idx) => (
            <div key={idx} className='preview-item'>
              <img src={url} alt='' />
            </div>
          ))}
          {pendingImportFiles.length > 12 && (
            <div className='preview-more-tile'>
              +{pendingImportFiles.length - 12}
            </div>
          )}
        </div>
      </Modal>

      <CreationResultGroupModalContainer
        mediaType='image'
        visible={!!galleryRow}
        onClose={() => setRowGalleryRow(null)}
        row={galleryRow}
        rowIndex={galleryRowIndex}
        info={galleryInfo}
        promptFallback={batchResultLabels.untitledPrompt}
        onPreviewItem={(item) =>
          openCachedImagePreview(item, onPreview, t('我的作品'))
        }
        onDownloadItem={(item, index, row, rowIndex) =>
          downloadResultItem(row, rowIndex, item, index)
        }
        onDownloadAll={(row, rowIndex, info) =>
          downloadResultRow(row, rowIndex, info)
        }
        onRetryFailed={
          onRetryTask
            ? (row, idx, info) => retryResultRows([{ row, idx, info }])
            : undefined
        }
        onCancelActive={
          onCancelTasks
            ? (row, idx, info) => cancelResultRows([{ row, idx, info }])
            : undefined
        }
        onDeleteItem={
          onDeleteTasks
            ? (item) => {
                const taskId = item?.task?.id || item?.id;
                if (taskId) onDeleteTasks([taskId]);
              }
            : undefined
        }
        onShowErrorItem={
          onShowError
            ? (item) => {
                const task = item?.task || item;
                if (task) onShowError(task);
              }
            : undefined
        }
        renderThumb={renderGroupThumb}
      />
    </>
  );
}
