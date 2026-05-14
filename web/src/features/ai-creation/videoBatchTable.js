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
  GROK_VIDEO_MODEL,
  getVideoCapabilitiesForModel,
  getVideoModelDefaults,
} from './constants.js';

export const VIDEO_BATCH_TABLE_STORAGE_KEY = 'ai_creation_video_batch_table_rows';
export const VIDEO_BATCH_TABLE_MAX_ROWS = 100;
export const VIDEO_BATCH_TABLE_INITIAL_ROWS = 5;

const cloneTableOptions = (options = []) =>
  (Array.isArray(options) ? options : []).map((item) => ({
    value: item.value,
    label: item.label,
  }));

export const makeVideoOptionLabels = (options = []) =>
  cloneTableOptions(options).reduce((acc, opt) => {
    acc[opt.value] = opt.label;
    return acc;
  }, {});

export const getVideoBatchRatioOptions = (modelCode = GROK_VIDEO_MODEL) =>
  cloneTableOptions(getVideoCapabilitiesForModel(modelCode).ratioOptions);

export const getVideoBatchDurationOptions = (modelCode = GROK_VIDEO_MODEL) =>
  cloneTableOptions(getVideoCapabilitiesForModel(modelCode).durationOptions);

export const getVideoBatchResolutionOptions = (modelCode = GROK_VIDEO_MODEL) =>
  cloneTableOptions(getVideoCapabilitiesForModel(modelCode).resolutionOptions);

export const getVideoBatchLabels = (modelCode = GROK_VIDEO_MODEL) => ({
  ratio: makeVideoOptionLabels(getVideoBatchRatioOptions(modelCode)),
  duration: makeVideoOptionLabels(getVideoBatchDurationOptions(modelCode)),
  resolution: makeVideoOptionLabels(getVideoBatchResolutionOptions(modelCode)),
});

export const VIDEO_RATIO_TABLE_OPTIONS =
  getVideoBatchRatioOptions(GROK_VIDEO_MODEL);

export const VIDEO_DURATION_OPTIONS =
  getVideoBatchDurationOptions(GROK_VIDEO_MODEL);

export const VIDEO_RESOLUTION_TABLE_OPTIONS =
  getVideoBatchResolutionOptions(GROK_VIDEO_MODEL);

export const RATIO_LABELS = makeVideoOptionLabels(VIDEO_RATIO_TABLE_OPTIONS);

export const DURATION_LABELS = makeVideoOptionLabels(VIDEO_DURATION_OPTIONS);

export const RESOLUTION_LABELS = makeVideoOptionLabels(
  VIDEO_RESOLUTION_TABLE_OPTIONS,
);

const makeVideoBatchRowDefaults = (modelCode = GROK_VIDEO_MODEL) => {
  const defaults = getVideoModelDefaults(modelCode);
  return {
    prompt: '',
    ratio: defaults.ratio,
    duration: defaults.duration,
    resolution: defaults.resolution,
    maxReferenceImages: defaults.maxReferenceImages,
    count: 1,
    images: [],
    taskIds: [],
  };
};

export const VIDEO_BATCH_ROW_DEFAULTS = Object.freeze(
  makeVideoBatchRowDefaults(),
);

export const getVideoBatchRowDefaults = (modelCode = GROK_VIDEO_MODEL) =>
  makeVideoBatchRowDefaults(modelCode);

const getVideoBatchSanitizerContext = (modelCode = GROK_VIDEO_MODEL) => {
  const capabilities = getVideoCapabilitiesForModel(modelCode);
  return {
    capabilities,
    ratioValues: new Set(
      (capabilities.ratioOptions || []).map((option) => option.value),
    ),
    durationValues: new Set(
      (capabilities.durationOptions || []).map((option) => option.value),
    ),
    resolutionValues: new Set(
      (capabilities.resolutionOptions || []).map((option) => option.value),
    ),
  };
};

const sanitizeRatio = (v, defaults, ratioValues) => {
  const s = String(v ?? '').trim();
  return ratioValues.has(s) ? s : defaults.ratio;
};

const sanitizeDuration = (v, defaults, durationValues) => {
  const raw = String(v ?? '').trim();
  if (durationValues.has(raw)) return raw;
  const num = parseInt(raw, 10);
  if (Number.isFinite(num)) {
    const candidate = `${num}s`;
    if (durationValues.has(candidate)) return candidate;
  }
  return defaults.duration;
};

const sanitizeResolution = (v, defaults, resolutionValues) => {
  const s = String(v ?? '').trim();
  return resolutionValues.has(s) ? s : defaults.resolution;
};

const sanitizeCount = (value, defaults) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1) return defaults.count;
  return Math.min(Math.floor(num), 20);
};

const sanitizePrompt = (value) =>
  typeof value === 'string' ? value : value == null ? '' : String(value);

const sanitizeStringArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : ''))
    .filter((item) => item && item.length > 0);
};

export const createVideoBatchRow = (
  overrides = {},
  modelCode = GROK_VIDEO_MODEL,
) => {
  const defaults = getVideoBatchRowDefaults(modelCode);
  const { ratioValues, durationValues, resolutionValues } =
    getVideoBatchSanitizerContext(modelCode);

  return {
    id:
      typeof overrides.id === 'string' && overrides.id
        ? overrides.id
        : getTimestampId('video-batch-row'),
    prompt: sanitizePrompt(overrides.prompt ?? defaults.prompt),
    ratio: sanitizeRatio(overrides.ratio ?? defaults.ratio, defaults, ratioValues),
    duration: sanitizeDuration(
      overrides.duration ?? defaults.duration,
      defaults,
      durationValues,
    ),
    resolution: sanitizeResolution(
      overrides.resolution ?? defaults.resolution,
      defaults,
      resolutionValues,
    ),
    count: sanitizeCount(overrides.count ?? defaults.count, defaults),
    images: sanitizeStringArray(overrides.images).slice(
      0,
      defaults.maxReferenceImages,
    ),
    taskIds: sanitizeStringArray(overrides.taskIds),
  };
};

export const createEmptyVideoBatchRow = (modelCode = GROK_VIDEO_MODEL) =>
  createVideoBatchRow({}, modelCode);

export const createInitialVideoBatchRows = (
  count = VIDEO_BATCH_TABLE_INITIAL_ROWS,
  modelCode = GROK_VIDEO_MODEL,
) =>
  Array(Math.max(1, count))
    .fill(0)
    .map(() => createEmptyVideoBatchRow(modelCode));

export const migrateVideoBatchRow = (raw, modelCode = GROK_VIDEO_MODEL) => {
  if (!raw || typeof raw !== 'object') return createEmptyVideoBatchRow(modelCode);
  return createVideoBatchRow(
    {
      id: raw.id,
      prompt: raw.prompt,
      ratio: raw.ratio,
      duration: raw.duration,
      resolution: raw.resolution,
      count: raw.count,
      images: raw.images,
      taskIds: raw.taskIds,
    },
    modelCode,
  );
};

export const updateVideoRowAt = (rows, index, patch, modelCode = GROK_VIDEO_MODEL) =>
  rows.map((row, idx) =>
    idx === index ? migrateVideoBatchRow({ ...row, ...patch }, modelCode) : row,
  );

export const removeVideoRowsAt = (
  rows,
  indexSet,
  modelCode = GROK_VIDEO_MODEL,
) => {
  const next = rows.filter((_, index) => !indexSet.has(index));
  return next.length > 0 ? next : [createEmptyVideoBatchRow(modelCode)];
};

export const summarizeVideoBatchRows = (rows = []) => {
  const validRows = rows.filter((row) => row.prompt && row.prompt.trim());
  const totalVideos = validRows.reduce(
    (sum, row) => sum + sanitizeCount(row.count),
    0,
  );
  return {
    rowCount: rows.length,
    validRowCount: validRows.length,
    totalVideos,
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

export const loadVideoBatchRows = (modelCode = GROK_VIDEO_MODEL) => {
  const storage = getStorage();
  if (!storage) return createInitialVideoBatchRows(undefined, modelCode);
  try {
    const raw = storage.getItem(VIDEO_BATCH_TABLE_STORAGE_KEY);
    if (!raw) return createInitialVideoBatchRows(undefined, modelCode);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return createInitialVideoBatchRows(undefined, modelCode);
    }
    return parsed
      .slice(0, VIDEO_BATCH_TABLE_MAX_ROWS)
      .map((row) => migrateVideoBatchRow(row, modelCode));
  } catch {
    return createInitialVideoBatchRows(undefined, modelCode);
  }
};

export const saveVideoBatchRows = (rows, modelCode = GROK_VIDEO_MODEL) => {
  const storage = getStorage();
  if (!storage) return { ok: false, reason: 'no-storage' };
  const trimmed = (Array.isArray(rows) ? rows : [])
    .slice(0, VIDEO_BATCH_TABLE_MAX_ROWS)
    .map((row) => migrateVideoBatchRow(row, modelCode));
  let payload = JSON.stringify(trimmed);
  let truncated = false;

  if (payload.length > STORAGE_QUOTA_BYTES) {
    payload = JSON.stringify(stripImagesForFallback(trimmed));
    truncated = true;
  }

  try {
    storage.setItem(VIDEO_BATCH_TABLE_STORAGE_KEY, payload);
    return { ok: true, truncated };
  } catch (error) {
    if (!truncated) {
      try {
        storage.setItem(
          VIDEO_BATCH_TABLE_STORAGE_KEY,
          JSON.stringify(stripImagesForFallback(trimmed)),
        );
        return { ok: true, truncated: true };
      } catch {
        return { ok: false, reason: 'quota-exceeded' };
      }
    }
    return { ok: false, reason: 'quota-exceeded' };
  }
};

const PROMPT_HEADER_KEYWORDS = ['prompt', 'description', 'text', '提示', '描述'];
const RATIO_HEADER_KEYWORDS = ['ratio', 'aspect', '比例'];
const DURATION_HEADER_KEYWORDS = ['duration', 'seconds', '时长', '秒'];
const RESOLUTION_HEADER_KEYWORDS = ['resolution', 'quality', '分辨率'];
const COUNT_HEADER_KEYWORDS = ['count', 'n', 'qty', 'quantity', '数量'];
const IMAGES_HEADER_KEYWORDS = ['image', 'images', 'reference', '参考图', '参考'];

const matchHeader = (cell, keywords) => {
  const normalized = String(cell || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return keywords.some((kw) => {
    const normalizedKeyword = String(kw || '').toLowerCase();
    if (normalizedKeyword.length <= 1) {
      return normalized === normalizedKeyword;
    }
    return normalized.includes(normalizedKeyword);
  });
};

const findHeaderColumn = (headerRow, keywords) => {
  if (!Array.isArray(headerRow)) return -1;
  return headerRow.findIndex((cell) => matchHeader(cell, keywords));
};

const sniffHeaderColumns = (headerRow) => ({
  prompt: findHeaderColumn(headerRow, PROMPT_HEADER_KEYWORDS),
  ratio: findHeaderColumn(headerRow, RATIO_HEADER_KEYWORDS),
  duration: findHeaderColumn(headerRow, DURATION_HEADER_KEYWORDS),
  resolution: findHeaderColumn(headerRow, RESOLUTION_HEADER_KEYWORDS),
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

export const videoRowsFromMatrix = (matrix, modelCode = GROK_VIDEO_MODEL) => {
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
      const ratio =
        hasHeader && cols.ratio >= 0 ? row[cols.ratio] : undefined;
      const duration =
        hasHeader && cols.duration >= 0 ? row[cols.duration] : undefined;
      const resolution =
        hasHeader && cols.resolution >= 0 ? row[cols.resolution] : undefined;
      const count =
        hasHeader && cols.count >= 0 ? row[cols.count] : undefined;
      const images =
        hasHeader && cols.images >= 0 ? parseImagesCell(row[cols.images]) : [];
      return createVideoBatchRow({
        prompt,
        ratio,
        duration,
        resolution,
        count,
        images,
      }, modelCode);
    })
    .filter(Boolean);
};

export const videoRowsFromTextLines = (text, modelCode = GROK_VIDEO_MODEL) => {
  const prompts = parseImageBatchPrompts(text);
  return prompts.map((prompt) => createVideoBatchRow({ prompt }, modelCode));
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

export const parseVideoSpreadsheetFile = async (
  file,
  modelCode = GROK_VIDEO_MODEL,
) => {
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
    return videoRowsFromMatrix(matrix, modelCode);
  }

  const text = await readFileAsText(file);
  const isCsv = /\.csv$/.test(name);
  if (isCsv) {
    const prompts = parseImageBatchPrompts(text, { fileName: name });
    return prompts.map((prompt) => createVideoBatchRow({ prompt }, modelCode));
  }
  return videoRowsFromTextLines(text, modelCode);
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

export const exportVideoBatchRowsToExcel = async (rows, options = {}) => {
  const XLSX = await import('xlsx');
  const data = (rows || []).map((row) => ({
    提示词: row.prompt || '',
    比例: row.ratio || '',
    时长: row.duration || '',
    分辨率: row.resolution || '',
    数量: sanitizeCount(row.count),
    参考图: formatImagesForExport(row.images),
    预览视频: formatImagesForExport(options.previewByRow?.[row.id] || []),
    状态: options.statusByRow?.[row.id] || '',
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [
    { wch: 60 },
    { wch: 10 },
    { wch: 10 },
    { wch: 12 },
    { wch: 8 },
    { wch: 80 },
    { wch: 80 },
    { wch: 12 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, '批量视频数据');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const filename =
    options.filename ||
    `batch-video-export_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
      now.getDate(),
    )}_${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`;
  XLSX.writeFile(wb, filename);
};

export const downloadVideoBatchTemplate = async (
  modelCode = GROK_VIDEO_MODEL,
) => {
  const XLSX = await import('xlsx');
  const defaults = getVideoBatchRowDefaults(modelCode);
  const ratioOptions = getVideoBatchRatioOptions(modelCode);
  const durationOptions = getVideoBatchDurationOptions(modelCode);
  const pickValue = (options, index, fallback) =>
    options[index]?.value || fallback;
  const data = [
    {
      提示词: '产品在白色摄影棚中缓慢旋转，柔和高光扫过表面',
      比例: pickValue(ratioOptions, 0, defaults.ratio),
      时长: defaults.duration,
      分辨率: defaults.resolution,
      数量: 1,
      参考图: '',
    },
    {
      提示词: '雨夜街道中人物向前走，低角度跟拍，霓虹反射',
      比例: pickValue(ratioOptions, 1, defaults.ratio),
      时长: pickValue(durationOptions, 1, defaults.duration),
      分辨率: defaults.resolution,
      数量: 1,
      参考图: '',
    },
    {
      提示词: '保持参考图主体一致，背景光影轻微流动',
      比例: pickValue(ratioOptions, 2, defaults.ratio),
      时长: defaults.duration,
      分辨率: defaults.resolution,
      数量: 1,
      参考图: '',
    },
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [
    { wch: 60 },
    { wch: 10 },
    { wch: 10 },
    { wch: 12 },
    { wch: 8 },
    { wch: 60 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, '批量视频模板');
  XLSX.writeFile(wb, 'batch-video-template.xlsx');
};
