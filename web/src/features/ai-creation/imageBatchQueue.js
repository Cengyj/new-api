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

import { TASK_STATUS } from './constants.js';
import { clampCreationConcurrency } from './creationTaskUtils.js';
import { createImageGenerationParams } from './imageModelRegistry.js';
import { getTimestampId } from './utils.js';

export const IMAGE_BATCH_STORAGE_KEY = 'ai_creation_image_batch_tasks';

export const IMAGE_BATCH_STATUS = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  ERROR: 'error',
  CANCELLED: 'cancelled',
};

export const IMAGE_TASK_SOURCE = {
  SINGLE: 'single',
  BATCH: 'batch',
};

const ACTIVE_BATCH_STATUSES = new Set([
  IMAGE_BATCH_STATUS.QUEUED,
  IMAGE_BATCH_STATUS.PROCESSING,
]);
const SETTLED_BATCH_STATUSES = new Set([
  IMAGE_BATCH_STATUS.SUCCESS,
  IMAGE_BATCH_STATUS.ERROR,
  IMAGE_BATCH_STATUS.CANCELLED,
]);

const nowSeconds = () => Date.now() / 1000;

const PROMPT_HEADER_NAMES = new Set([
  'prompt',
  'prompts',
  'text',
  'description',
  '提示词',
  '提示',
  '描述',
]);

const normalizePromptText = (value) =>
  String(value || '')
    .replace(/^\uFEFF/, '')
    .trim();

const parseCsvRows = (raw) => {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const nextChar = raw[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);

  return rows.filter((cells) =>
    cells.some((value) => normalizePromptText(value)),
  );
};

const getPromptHeaderIndex = (row = []) =>
  row.findIndex((value) =>
    PROMPT_HEADER_NAMES.has(normalizePromptText(value).toLowerCase()),
  );

const firstNonEmptyCell = (row = []) =>
  normalizePromptText(row.find((value) => normalizePromptText(value)) || '');

export const parseImageBatchPrompts = (input, options = {}) => {
  if (Array.isArray(input)) {
    return input.map((value) => normalizePromptText(value)).filter(Boolean);
  }

  const raw = String(input || '');
  if (!raw.trim()) return [];

  const isCsv =
    options.format === 'csv' ||
    options.type === 'csv' ||
    /\.csv$/i.test(String(options.fileName || options.name || ''));

  if (!isCsv) {
    return raw
      .split(/\r?\n/)
      .map((line) => normalizePromptText(line))
      .filter(Boolean);
  }

  const rows = parseCsvRows(raw);
  if (!rows.length) return [];

  const headerIndex = getPromptHeaderIndex(rows[0]);
  const dataRows = headerIndex >= 0 ? rows.slice(1) : rows;

  return dataRows
    .map((row) =>
      headerIndex >= 0
        ? normalizePromptText(row[headerIndex])
        : firstNonEmptyCell(row),
    )
    .filter(Boolean);
};

const safeParse = (raw, fallback) => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const getStorage = () => {
  if (typeof window === 'undefined') return null;
  return window.localStorage || null;
};

const statusFromBatchStatus = (batchStatus) => {
  if (batchStatus === IMAGE_BATCH_STATUS.SUCCESS) return TASK_STATUS.SUCCESS;
  if (
    batchStatus === IMAGE_BATCH_STATUS.ERROR ||
    batchStatus === IMAGE_BATCH_STATUS.CANCELLED
  ) {
    return TASK_STATUS.ERROR;
  }
  return TASK_STATUS.LOADING;
};

const batchStatusFromStatus = (status) => {
  if (status === TASK_STATUS.SUCCESS) return IMAGE_BATCH_STATUS.SUCCESS;
  if (status === TASK_STATUS.ERROR) return IMAGE_BATCH_STATUS.ERROR;
  return IMAGE_BATCH_STATUS.QUEUED;
};

const normalizeTaskSource = (task, params) => {
  const source = task.source || params.source;
  if (
    source === IMAGE_TASK_SOURCE.BATCH ||
    task.batchRowId ||
    params.batchRowId
  ) {
    return IMAGE_TASK_SOURCE.BATCH;
  }
  return IMAGE_TASK_SOURCE.SINGLE;
};

const normalizeBatchRowIndex = (task, params) => {
  const value = task.batchRowIndex ?? params.batchRowIndex;
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const isSessionBlobUrl = (url) =>
  typeof url === 'string' && url.startsWith('blob:');

const normalizeStoredUrl = (task) => {
  const rawUrl = typeof task.url === 'string' ? task.url : '';
  const rawRemoteUrl =
    typeof task.remoteUrl === 'string' ? task.remoteUrl : '';
  const remoteUrl = isSessionBlobUrl(rawRemoteUrl) ? '' : rawRemoteUrl;
  if (isSessionBlobUrl(rawUrl)) {
    return { url: remoteUrl, remoteUrl };
  }
  if (rawUrl) {
    return { url: rawUrl, remoteUrl: rawUrl };
  }

  return { url: '', remoteUrl };
};

export const normalizeImageBatchTask = (task) => {
  if (!task || typeof task !== 'object') return null;
  const params =
    task.params && typeof task.params === 'object' ? task.params : {};
  const imageParams = createImageGenerationParams({
    ...params,
    prompt: task.prompt || params.prompt,
    ratio: task.ratio || params.ratio,
    size: task.size || params.size,
    width: task.width || params.width,
    height: task.height || params.height,
    quality: task.quality || params.quality,
    model: task.model || params.model,
    group: task.group || params.group,
  });
  const batchStatus = Object.values(IMAGE_BATCH_STATUS).includes(
    task.batchStatus,
  )
    ? task.batchStatus
    : batchStatusFromStatus(task.status);

  const source = normalizeTaskSource(task, params);
  const batchRowId = String(task.batchRowId || params.batchRowId || '');
  const batchRowIndex = normalizeBatchRowIndex(task, params);
  const storedUrl = normalizeStoredUrl(task);

  return {
    ...task,
    id: String(task.id || getTimestampId('image-task')),
    batchId: String(task.batchId || task.id || getTimestampId('image-batch')),
    kind: 'image',
    source,
    batchRowId,
    batchRowIndex,
    status: Object.values(TASK_STATUS).includes(task.status)
      ? task.status
      : statusFromBatchStatus(batchStatus),
    batchStatus,
    prompt: imageParams.prompt,
    ratio: imageParams.ratio,
    size: imageParams.size,
    width: imageParams.width,
    height: imageParams.height,
    quality: imageParams.quality,
    model: imageParams.model,
    group: imageParams.group,
    url: storedUrl.url,
    remoteUrl: storedUrl.remoteUrl,
    error: task.error || '',
    errorDetail: task.errorDetail || null,
    retryCount: Number(task.retryCount || 0),
    referenceCount:
      Number(task.referenceCount) ||
      imageParams.referenceImages.length,
    created_at: Number(task.created_at || task.createdAt || nowSeconds()),
    updated_at: Number(task.updated_at || task.updatedAt || nowSeconds()),
    params: {
      ...params,
      ...imageParams,
      source,
      ...(batchRowId ? { batchRowId } : {}),
      ...(batchRowIndex !== null ? { batchRowIndex } : {}),
      count: 1,
    },
  };
};

export const isImageBatchGeneratedTask = (task, batchTaskIds) => {
  if (!task) return false;
  return (
    task.source === IMAGE_TASK_SOURCE.BATCH ||
    task.params?.source === IMAGE_TASK_SOURCE.BATCH ||
    Boolean(task.batchRowId || task.params?.batchRowId) ||
    Boolean(batchTaskIds?.has?.(task.id))
  );
};

export const createImageBatchTasks = ({
  count,
  prompt,
  prompts,
  ratio,
  size,
  quality,
  model,
  group,
  width,
  height,
  referenceImage,
  referenceImages = [],
  source = IMAGE_TASK_SOURCE.SINGLE,
  batchRowId,
  batchRowIndex,
}) => {
  const imageParams = createImageGenerationParams({
    ratio,
    size,
    quality,
    model,
    group,
    width,
    height,
    referenceImage,
    referenceImages,
  });
  ratio = imageParams.ratio;
  const promptList = parseImageBatchPrompts(
    prompts === undefined ? [prompt] : prompts,
  );
  const batchId = getTimestampId('image-batch');
  const createdAt = nowSeconds();
  const taskCount = Math.max(1, Number(count) || 1);
  const cleanReferenceImages = imageParams.referenceImages;
  const primaryReferenceImage = imageParams.referenceImage;
  const visiblePrompts = promptList.length ? promptList : [''];
  const taskMetadata = {
    source,
    ...(batchRowId ? { batchRowId } : {}),
    ...(batchRowIndex !== undefined && batchRowIndex !== null
      ? { batchRowIndex }
      : {}),
  };

  return visiblePrompts.flatMap((taskPrompt, promptIndex) =>
    Array(taskCount)
      .fill(0)
      .map((_, copyIndex) => {
        const sequence = promptIndex * taskCount + copyIndex;
        const baseParams = {
          prompt: taskPrompt,
          ratio,
          size: imageParams.size,
          width: imageParams.width,
          height: imageParams.height,
          quality: imageParams.quality,
          model: imageParams.model,
          group: imageParams.group,
          referenceImage: primaryReferenceImage,
          referenceImages: cleanReferenceImages,
          ...taskMetadata,
          count: 1,
        };

        return normalizeImageBatchTask({
          id:
            visiblePrompts.length === 1
              ? `${batchId}-${copyIndex + 1}`
              : `${batchId}-${promptIndex + 1}-${copyIndex + 1}`,
          batchId,
          status: TASK_STATUS.LOADING,
          batchStatus: IMAGE_BATCH_STATUS.QUEUED,
          prompt: taskPrompt,
          ratio,
          size: imageParams.size,
          width: imageParams.width,
          height: imageParams.height,
          quality: imageParams.quality,
          model: imageParams.model,
          group: imageParams.group,
          ...taskMetadata,
          referenceCount:
            cleanReferenceImages.length || (primaryReferenceImage ? 1 : 0),
          created_at: createdAt,
          updated_at: createdAt,
          params: {
            ...baseParams,
            index: sequence,
            promptIndex,
            copyIndex,
          },
        });
      }),
  );
};

export const createImageBatchQueueItems = createImageBatchTasks;

export const summarizeImageBatchTasks = (tasks = []) =>
  tasks.reduce(
    (summary, task) => {
      const batchStatus =
        task.batchStatus || batchStatusFromStatus(task.status);
      summary.total += 1;
      if (ACTIVE_BATCH_STATUSES.has(batchStatus)) {
        summary.active += 1;
        summary.running += 1;
      }
      if (batchStatus === IMAGE_BATCH_STATUS.QUEUED) summary.queued += 1;
      if (batchStatus === IMAGE_BATCH_STATUS.PROCESSING)
        summary.processing += 1;
      if (batchStatus === IMAGE_BATCH_STATUS.SUCCESS) summary.success += 1;
      if (batchStatus === IMAGE_BATCH_STATUS.ERROR) summary.error += 1;
      if (batchStatus === IMAGE_BATCH_STATUS.CANCELLED) summary.cancelled += 1;
      return summary;
    },
    {
      total: 0,
      active: 0,
      running: 0,
      queued: 0,
      processing: 0,
      success: 0,
      error: 0,
      cancelled: 0,
    },
  );

export const loadImageBatchTasks = () => {
  const storage = getStorage();
  if (!storage) return [];
  const parsed = safeParse(storage.getItem(IMAGE_BATCH_STORAGE_KEY), []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((task) => normalizeImageBatchTask(task)).filter(Boolean);
};

export const reviveStaleActiveImageTasks = (tasks) =>
  (tasks || []).map((task) =>
    task.status === TASK_STATUS.LOADING ||
    task.status === TASK_STATUS.GENERATING ||
    ACTIVE_BATCH_STATUSES.has(task.batchStatus)
      ? {
          ...task,
          status: TASK_STATUS.ERROR,
          batchStatus: IMAGE_BATCH_STATUS.ERROR,
          error: task.error || '页面刷新后任务已暂停，请重试',
        }
      : task,
  );

export const saveImageBatchTasks = (tasks) => {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(
      IMAGE_BATCH_STORAGE_KEY,
      JSON.stringify(
        (tasks || [])
          .slice(0, 120)
          .map((task) => normalizeImageBatchTask(task))
          .filter(Boolean),
      ),
    );
  } catch (error) {
    console.error('保存图片任务队列失败:', error);
  }
};

export const upsertImageBatchTasks = (tasks, updates) => {
  const updateRows = Array.isArray(updates) ? updates : [updates];
  const updateMap = new Map(
    updateRows
      .filter(Boolean)
      .map((task) => [task.id, normalizeImageBatchTask(task)]),
  );
  return (tasks || []).map((task) => updateMap.get(task.id) || task);
};

export const mergeImageBatchTasks = (tasks, nextTasks) => [
  ...nextTasks,
  ...(tasks || []).filter(
    (task) => !nextTasks.some((nextTask) => nextTask.id === task.id),
  ),
];

export const clearSettledImageBatchTasks = (tasks) =>
  (tasks || []).filter((task) => !SETTLED_BATCH_STATUSES.has(task.batchStatus));

export const removeImageBatchTask = (tasks, taskId) =>
  (tasks || []).filter((task) => task.id !== taskId);

export const cancelImageBatchTasks = (tasks, taskIds) => {
  const idSet = new Set(Array.isArray(taskIds) ? taskIds : [taskIds]);
  const cancelledAt = nowSeconds();
  return (tasks || []).map((task) => {
    if (!idSet.has(task.id)) return task;
    const batchStatus = task.batchStatus || batchStatusFromStatus(task.status);
    if (!ACTIVE_BATCH_STATUSES.has(batchStatus)) return task;
    return normalizeImageBatchTask({
      ...task,
      status: TASK_STATUS.ERROR,
      batchStatus: IMAGE_BATCH_STATUS.CANCELLED,
      error: task.error || '\u5df2\u505c\u6b62',
      updated_at: cancelledAt,
    });
  });
};

export const retryImageBatchTask = (task) =>
  normalizeImageBatchTask({
    ...task,
    status: TASK_STATUS.LOADING,
    batchStatus: IMAGE_BATCH_STATUS.QUEUED,
    error: '',
    url: '',
    remoteUrl: '',
    retryCount: Number(task.retryCount || 0) + 1,
    updated_at: nowSeconds(),
  });

const processImageBatchTask = async (
  task,
  { generate, onUpdate, shouldContinue },
) => {
  if (!shouldContinue(task)) return null;
  if (
    (task.batchStatus || IMAGE_BATCH_STATUS.QUEUED) !==
    IMAGE_BATCH_STATUS.QUEUED
  ) {
    return null;
  }

  const processingTask = normalizeImageBatchTask({
    ...task,
    status: TASK_STATUS.LOADING,
    batchStatus: IMAGE_BATCH_STATUS.PROCESSING,
    error: '',
    updated_at: nowSeconds(),
  });
  onUpdate?.(processingTask);

  try {
    const [result] = await generate(processingTask.params);
    const successTask = normalizeImageBatchTask({
      ...processingTask,
      ...result,
      id: processingTask.id,
      batchId: processingTask.batchId,
      kind: 'image',
      status: TASK_STATUS.SUCCESS,
      batchStatus: IMAGE_BATCH_STATUS.SUCCESS,
      model: processingTask.model,
      group: processingTask.group,
      ratio: processingTask.ratio,
      width: processingTask.width,
      height: processingTask.height,
      quality: processingTask.quality,
      referenceCount: processingTask.referenceCount,
      params: processingTask.params,
      created_at: processingTask.created_at,
      updated_at: nowSeconds(),
    });
    onUpdate?.(successTask);
    return successTask;
  } catch (error) {
    const errorTask = normalizeImageBatchTask({
      ...processingTask,
      status: TASK_STATUS.ERROR,
      batchStatus: IMAGE_BATCH_STATUS.ERROR,
      error: error?.message || 'image generation failed',
      errorDetail: error?.detail
        ? {
            ...error.detail,
            body:
              typeof error.detail.body === 'object'
                ? error.detail.body
                : { value: error.detail.body },
          }
        : null,
      updated_at: nowSeconds(),
    });
    onUpdate?.(errorTask);
    return errorTask;
  }
};

export const runImageBatchQueue = async ({
  tasks,
  generate,
  onUpdate,
  shouldContinue = () => true,
  concurrency = 1,
}) => {
  const queue = Array.isArray(tasks) ? [...tasks] : [];
  const completed = [];
  if (!queue.length) return completed;

  const workerCount = Math.max(
    1,
    Math.min(clampCreationConcurrency(concurrency), queue.length),
  );
  const ctx = { generate, onUpdate, shouldContinue };

  const worker = async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) return;
      // eslint-disable-next-line no-await-in-loop
      const result = await processImageBatchTask(task, ctx);
      if (result) completed.push(result);
    }
  };

  await Promise.all(
    Array(workerCount)
      .fill(0)
      .map(() => worker()),
  );

  return completed;
};
