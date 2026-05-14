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

import { getTimestampId } from './utils.js';
import { parseImageBatchPrompts } from './imageBatchQueue.js';
import {
  DEFAULT_IMAGE_CONFIG,
  IMAGE_MODEL_CONFIGS,
  IMAGE_RATIO_OPTIONS,
} from './constants.js';

export const BATCH_TABLE_STORAGE_KEY = 'ai_creation_batch_table_rows';
export const BATCH_TABLE_MAX_ROWS = 200;
export const BATCH_TABLE_INITIAL_ROWS = 5;

export const SIZE_AUTO = 'auto';

const getAllImageRatioOptions = () => {
  const map = new Map();
  IMAGE_RATIO_OPTIONS.forEach((item) => map.set(item.value, item));
  Object.values(IMAGE_MODEL_CONFIGS || {}).forEach((spec) => {
    (spec.capabilities?.ratioOptions || []).forEach((item) => {
      if (!map.has(item.value)) map.set(item.value, item);
    });
  });
  return [...map.values()];
};

export const SIZE_OPTIONS = [
  { value: SIZE_AUTO, label: '自动' },
  ...getAllImageRatioOptions().map((item) => ({
    value: item.value,
    label: item.label,
    width: item.width,
    height: item.height,
  })),
];

export const SIZE_LABELS = SIZE_OPTIONS.reduce((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, {});

const SIZE_VALUES = new Set(SIZE_OPTIONS.map((item) => item.value));

export const BATCH_ROW_DEFAULTS = Object.freeze({
  prompt: '',
  ratio: DEFAULT_IMAGE_CONFIG.ratio,
  size: DEFAULT_IMAGE_CONFIG.ratio,
  count: 1,
  images: [],
  taskIds: [],
});

const sanitizeSize = (value) => {
  const str = String(value ?? '').trim();
  if (SIZE_VALUES.has(str)) return str;
  return BATCH_ROW_DEFAULTS.size;
};

const sanitizeCount = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1) return BATCH_ROW_DEFAULTS.count;
  return Math.min(Math.floor(num), 99);
};

const sanitizePrompt = (value) =>
  typeof value === 'string' ? value : value == null ? '' : String(value);

const sanitizeStringArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : ''))
    .filter((item) => item && item.length > 0);
};

const sanitizeRowSizePair = (overrides = {}) => {
  const size = sanitizeSize(
    overrides.size ?? overrides.ratio ?? BATCH_ROW_DEFAULTS.size,
  );
  return {
    ratio: size === SIZE_AUTO ? '' : size,
    size,
  };
};

export const createBatchRow = (overrides = {}) => ({
  id:
    typeof overrides.id === 'string' && overrides.id
      ? overrides.id
      : getTimestampId('batch-row'),
  prompt: sanitizePrompt(overrides.prompt ?? BATCH_ROW_DEFAULTS.prompt),
  ...sanitizeRowSizePair(overrides),
  count: sanitizeCount(overrides.count ?? BATCH_ROW_DEFAULTS.count),
  images: sanitizeStringArray(overrides.images),
  taskIds: sanitizeStringArray(overrides.taskIds),
});

export const createEmptyBatchRow = () => createBatchRow();

export const createInitialBatchRows = (count = BATCH_TABLE_INITIAL_ROWS) =>
  Array(Math.max(1, count))
    .fill(0)
    .map(() => createEmptyBatchRow());

export const migrateLegacyRow = (raw) => {
  if (!raw || typeof raw !== 'object') return createEmptyBatchRow();
  const sizeSource = raw.size ?? raw.ratio;
  return createBatchRow({
    id: raw.id,
    prompt: raw.prompt,
    ratio: sizeSource,
    size: sizeSource,
    count: raw.count,
    images: raw.images,
    taskIds: raw.taskIds,
  });
};

export const normalizeBatchRow = migrateLegacyRow;

export const insertRowAfter = (rows, anchorId, newRow) => {
  const index = rows.findIndex((row) => row.id === anchorId);
  if (index < 0) return [...rows, newRow];
  return [...rows.slice(0, index + 1), newRow, ...rows.slice(index + 1)];
};

export const updateRow = (rows, rowId, patch) =>
  rows.map((row) =>
    row.id === rowId ? migrateLegacyRow({ ...row, ...patch }) : row,
  );

export const updateRowAt = (rows, index, patch) =>
  rows.map((row, idx) =>
    idx === index ? migrateLegacyRow({ ...row, ...patch }) : row,
  );

export const removeRow = (rows, rowId) => {
  const next = rows.filter((row) => row.id !== rowId);
  return next.length > 0 ? next : [createEmptyBatchRow()];
};

export const removeRowsAt = (rows, indexSet) => {
  const next = rows.filter((_, index) => !indexSet.has(index));
  return next.length > 0 ? next : [createEmptyBatchRow()];
};

export const summarizeBatchRows = (rows = []) => {
  const validRows = rows.filter((row) => row.prompt && row.prompt.trim());
  const totalImages = validRows.reduce(
    (sum, row) => sum + sanitizeCount(row.count),
    0,
  );
  return {
    rowCount: rows.length,
    validRowCount: validRows.length,
    totalImages,
  };
};

const getStorage = () => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
};

const STORAGE_QUOTA_BYTES = 4 * 1024 * 1024;

const stripImagesForFallback = (rows) =>
  rows.map((row) => ({ ...row, images: [] }));

export const loadBatchRows = () => {
  const storage = getStorage();
  if (!storage) return createInitialBatchRows();
  try {
    const raw = storage.getItem(BATCH_TABLE_STORAGE_KEY);
    if (!raw) return createInitialBatchRows();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return createInitialBatchRows();
    }
    return parsed.slice(0, BATCH_TABLE_MAX_ROWS).map(migrateLegacyRow);
  } catch {
    return createInitialBatchRows();
  }
};

export const saveBatchRows = (rows, options = {}) => {
  const storage = getStorage();
  if (!storage) return { ok: false, reason: 'no-storage' };
  const trimmed = (Array.isArray(rows) ? rows : [])
    .slice(0, BATCH_TABLE_MAX_ROWS)
    .map(migrateLegacyRow);
  let payload = JSON.stringify(trimmed);
  let truncated = false;

  if (payload.length > STORAGE_QUOTA_BYTES) {
    payload = JSON.stringify(stripImagesForFallback(trimmed));
    truncated = true;
  }

  try {
    storage.setItem(BATCH_TABLE_STORAGE_KEY, payload);
    return { ok: true, truncated };
  } catch (error) {
    if (!truncated) {
      try {
        storage.setItem(
          BATCH_TABLE_STORAGE_KEY,
          JSON.stringify(stripImagesForFallback(trimmed)),
        );
        return { ok: true, truncated: true };
      } catch (fallbackError) {
        if (options.onError) options.onError(fallbackError);
        return { ok: false, reason: 'quota-exceeded' };
      }
    }
    if (options.onError) options.onError(error);
    return { ok: false, reason: 'quota-exceeded' };
  }
};

const PROMPT_HEADER_KEYWORDS = ['prompt', '提示', '描述', 'description', 'text'];
const SIZE_HEADER_KEYWORDS = ['size', 'ratio', '比例', 'aspect', '尺寸'];
const COUNT_HEADER_KEYWORDS = ['count', '数量', 'n', 'qty', 'quantity', '张数'];
const IMAGES_HEADER_KEYWORDS = ['image', 'images', '参考图', '参考', 'reference'];

const matchHeader = (cell, keywords) => {
  const normalized = String(cell || '').trim().toLowerCase();
  if (!normalized) return false;
  return keywords.some((kw) => normalized.includes(kw));
};

const findHeaderColumn = (headerRow, keywords) => {
  if (!Array.isArray(headerRow)) return -1;
  return headerRow.findIndex((cell) => matchHeader(cell, keywords));
};

const sniffHeaderColumns = (headerRow) => ({
  prompt: findHeaderColumn(headerRow, PROMPT_HEADER_KEYWORDS),
  size: findHeaderColumn(headerRow, SIZE_HEADER_KEYWORDS),
  count: findHeaderColumn(headerRow, COUNT_HEADER_KEYWORDS),
  images: findHeaderColumn(headerRow, IMAGES_HEADER_KEYWORDS),
});

const parseImagesCell = (raw) => {
  if (!raw && raw !== 0) return [];
  return String(raw)
    .split(/\r?\n|;|,/)
    .map((item) => item.trim())
    .filter(
      (item) =>
        item.length > 0 && !(item.startsWith('[') && item.endsWith(']')),
    );
};

export const rowsFromMatrix = (matrix) => {
  if (!Array.isArray(matrix) || matrix.length === 0) return [];

  const header = matrix[0];
  const cols = sniffHeaderColumns(header);
  const hasHeader = cols.prompt >= 0;
  const dataRows = hasHeader ? matrix.slice(1) : matrix;

  return dataRows
    .map((row) => {
      if (!Array.isArray(row)) return null;
      const promptCell = hasHeader ? row[cols.prompt] : row[0];
      const prompt = sanitizePrompt(promptCell).trim();
      if (!prompt) return null;
      const size = hasHeader && cols.size >= 0 ? row[cols.size] : undefined;
      const count = hasHeader && cols.count >= 0 ? row[cols.count] : undefined;
      const images =
        hasHeader && cols.images >= 0 ? parseImagesCell(row[cols.images]) : [];
      return createBatchRow({ prompt, size, count, images });
    })
    .filter(Boolean);
};

export const rowsFromTextLines = (text) => {
  const prompts = parseImageBatchPrompts(text);
  return prompts.map((prompt) => createBatchRow({ prompt }));
};

const readFileAsArrayBuffer = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });

const readFileAsText = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

export const parseSpreadsheetFile = async (file) => {
  if (!file) return [];
  const name = String(file.name || '').toLowerCase();
  const isExcel = /\.(xlsx|xls)$/.test(name);

  if (isExcel) {
    const XLSX = await import('xlsx');
    const buffer = await readFileAsArrayBuffer(file);
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];
    const sheet = workbook.Sheets[firstSheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
    });
    return rowsFromMatrix(matrix);
  }

  const text = await readFileAsText(file);
  const isCsv = /\.csv$/.test(name);
  if (isCsv) {
    const prompts = parseImageBatchPrompts(text, { fileName: name });
    return prompts.map((prompt) => createBatchRow({ prompt }));
  }
  return rowsFromTextLines(text);
};

const formatImagesForExport = (images) => {
  if (!Array.isArray(images) || images.length === 0) return '';
  const MAX_LEN = 32000;
  const result = images
    .map((url, idx) => {
      if (typeof url !== 'string') return '';
      if (url.startsWith('data:')) return `[本地图片${idx + 1}]`;
      return url;
    })
    .filter(Boolean)
    .join('\n');
  return result.length > MAX_LEN
    ? `${result.slice(0, MAX_LEN - 20)}\n...[已截断]`
    : result;
};

export const exportBatchRowsToExcel = async (rows, options = {}) => {
  const XLSX = await import('xlsx');
  const data = (rows || []).map((row) => ({
    提示词: row.prompt || '',
    尺寸: row.size || BATCH_ROW_DEFAULTS.size,
    数量: sanitizeCount(row.count),
    参考图: formatImagesForExport(row.images),
    预览图: formatImagesForExport(options.previewByRow?.[row.id] || []),
    状态: options.statusByRow?.[row.id] || '',
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [
    { wch: 60 },
    { wch: 12 },
    { wch: 8 },
    { wch: 80 },
    { wch: 80 },
    { wch: 12 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, '批量出图数据');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const filename =
    options.filename ||
    `batch-image-export_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
      now.getDate(),
    )}_${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`;
  XLSX.writeFile(wb, filename);
};

export const downloadBatchTemplate = async () => {
  const XLSX = await import('xlsx');
  const data = [
    { 提示词: '一只可爱的橘猫在阳光下睡觉', 尺寸: '1:1', 数量: 1, 参考图: '' },
    { 提示词: '未来城市的夜景，霓虹灯闪烁', 尺寸: '16:9', 数量: 2, 参考图: '' },
    { 提示词: '古风美女，水墨画风格', 尺寸: '3:4', 数量: 1, 参考图: '' },
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 60 }, { wch: 12 }, { wch: 8 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws, '批量出图模板');
  XLSX.writeFile(wb, 'batch-image-template.xlsx');
};
