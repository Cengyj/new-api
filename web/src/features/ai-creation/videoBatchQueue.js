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
import { getTimestampId } from './utils.js';
import { normalizeVideoGenerationParams } from './videoParams.js';

export const VIDEO_BATCH_STORAGE_KEY = 'ai_creation_video_batch_tasks';

export const VIDEO_TASK_SOURCE = {
  SINGLE: 'single',
  BATCH: 'batch',
};

export const VIDEO_BATCH_STATUS = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  ERROR: 'error',
  CANCELLED: 'cancelled',
};

const ACTIVE_BATCH_STATUSES = new Set([
  VIDEO_BATCH_STATUS.QUEUED,
  VIDEO_BATCH_STATUS.PROCESSING,
]);
const SETTLED_BATCH_STATUSES = new Set([
  VIDEO_BATCH_STATUS.SUCCESS,
  VIDEO_BATCH_STATUS.ERROR,
  VIDEO_BATCH_STATUS.CANCELLED,
]);

const nowSeconds = () => Date.now() / 1000;

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
  if (batchStatus === VIDEO_BATCH_STATUS.SUCCESS) return TASK_STATUS.SUCCESS;
  if (
    batchStatus === VIDEO_BATCH_STATUS.ERROR ||
    batchStatus === VIDEO_BATCH_STATUS.CANCELLED
  ) {
    return TASK_STATUS.ERROR;
  }
  return TASK_STATUS.GENERATING;
};

const batchStatusFromStatus = (status) => {
  if (status === TASK_STATUS.SUCCESS) return VIDEO_BATCH_STATUS.SUCCESS;
  if (status === TASK_STATUS.ERROR) return VIDEO_BATCH_STATUS.ERROR;
  return VIDEO_BATCH_STATUS.QUEUED;
};

const normalizeVideoTaskSource = (task, params) => {
  const source = task.source || params.source;
  if (
    source === VIDEO_TASK_SOURCE.BATCH ||
    task.batchRowId ||
    params.batchRowId
  ) {
    return VIDEO_TASK_SOURCE.BATCH;
  }
  return VIDEO_TASK_SOURCE.SINGLE;
};

const normalizeVideoBatchRowIndex = (task, params) => {
  const value = task.batchRowIndex ?? params.batchRowIndex;
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const isSessionBlobUrl = (url) =>
  typeof url === 'string' && url.startsWith('blob:');

const isDataUrl = (url) =>
  typeof url === 'string' && url.startsWith('data:');

const isVolatileReferenceUrl = (url) =>
  isDataUrl(url) || isSessionBlobUrl(url);

const compactStoredReferenceImages = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : ''))
    .filter((item) => item && !isVolatileReferenceUrl(item));
};

const compactVideoTaskForStorage = (task) => {
  const normalized = normalizeVideoBatchTask(task);
  if (!normalized) return null;
  const params =
    normalized.params && typeof normalized.params === 'object'
      ? { ...normalized.params }
      : {};
  const storedReferenceImages = compactStoredReferenceImages(
    params.referenceImages,
  );

  if (storedReferenceImages.length > 0) {
    params.referenceImages = storedReferenceImages;
    params.referenceImage = storedReferenceImages[0];
  } else {
    delete params.referenceImages;
    delete params.referenceImage;
  }
  delete params.input_reference;
  delete params['input_reference[]'];

  const compactTask = {
    ...normalized,
    params,
  };
  delete compactTask.referenceImage;
  delete compactTask.referenceImages;
  delete compactTask.input_reference;
  delete compactTask['input_reference[]'];
  return compactTask;
};

export const normalizeVideoBatchTask = (task) => {
  if (!task || typeof task !== 'object') return null;
  const params =
    task.params && typeof task.params === 'object' ? task.params : {};
  const modelCode = task.model || params.model || '';
  const videoParams = normalizeVideoGenerationParams({
    ...params,
    prompt: task.prompt || params.prompt || '',
    ratio: task.ratio ?? params.ratio,
    duration: task.duration ?? params.duration,
    resolution: task.resolution ?? params.resolution,
    size: task.size ?? params.size,
    preset: task.preset ?? params.preset,
    model: modelCode || params.model,
    group: task.group || params.group || '',
  });
  const batchStatus = Object.values(VIDEO_BATCH_STATUS).includes(
    task.batchStatus,
  )
    ? task.batchStatus
    : batchStatusFromStatus(task.status);
  const source = normalizeVideoTaskSource(task, params);
  const batchRowId = String(task.batchRowId || params.batchRowId || '');
  const batchRowIndex = normalizeVideoBatchRowIndex(task, params);
  const rawUrl = String(task.url || '');
  const remoteUrl = String(
    task.remoteUrl || params.remoteUrl || (isSessionBlobUrl(rawUrl) ? '' : rawUrl),
  );

  return {
    ...task,
    id: String(task.id || getTimestampId('video-task')),
    batchId: String(task.batchId || task.id || getTimestampId('video-batch')),
    kind: 'video',
    source,
    batchRowId,
    batchRowIndex,
    status: Object.values(TASK_STATUS).includes(task.status)
      ? task.status
      : statusFromBatchStatus(batchStatus),
    batchStatus,
    prompt: videoParams.prompt,
    ratio: videoParams.ratio,
    duration: videoParams.duration,
    seconds: videoParams.seconds,
    resolution: videoParams.resolution,
    size: videoParams.size,
    preset: videoParams.preset,
    model: videoParams.model,
    group: videoParams.group,
    url: isSessionBlobUrl(rawUrl) ? remoteUrl : rawUrl,
    remoteUrl,
    error: task.error || '',
    errorDetail: task.errorDetail || null,
    progress: Number(task.progress || 0),
    retryCount: Number(task.retryCount || 0),
    referenceCount:
      Number(task.referenceCount) ||
      videoParams.referenceCount,
    created_at: Number(task.created_at || task.createdAt || nowSeconds()),
    updated_at: Number(task.updated_at || task.updatedAt || nowSeconds()),
    params: {
      ...params,
      ...videoParams,
      source,
      ...(batchRowId ? { batchRowId } : {}),
      ...(batchRowIndex !== null ? { batchRowIndex } : {}),
      ...(remoteUrl ? { remoteUrl } : {}),
      count: 1,
    },
  };
};

export const createVideoBatchTasks = ({
  count,
  source = VIDEO_TASK_SOURCE.SINGLE,
  prompt,
  prompts,
  ratio,
  duration,
  resolution,
  size,
  preset,
  model,
  group,
  referenceImage,
  referenceImages = [],
  batchRowId,
  batchRowIndex,
}) => {
  const promptList = Array.isArray(prompts)
    ? prompts.map((p) => String(p || '').trim()).filter(Boolean)
    : prompt
      ? [String(prompt).trim()]
      : [];
  const batchId = getTimestampId('video-batch');
  const createdAt = nowSeconds();
  const taskCount = Math.max(1, Number(count) || 1);
  const sharedParams = normalizeVideoGenerationParams({
    ratio,
    duration,
    resolution,
    size,
    preset,
    model,
    group,
    referenceImage,
    referenceImages,
  });
  const cleanReferenceImages = sharedParams.referenceImages;
  const primaryReferenceImage = sharedParams.referenceImage;
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
          ...sharedParams,
          prompt: taskPrompt,
          referenceImage: primaryReferenceImage,
          referenceImages: cleanReferenceImages,
          ...taskMetadata,
          count: 1,
        };
        return normalizeVideoBatchTask({
          id:
            visiblePrompts.length === 1
              ? `${batchId}-${copyIndex + 1}`
              : `${batchId}-${promptIndex + 1}-${copyIndex + 1}`,
          batchId,
          ...taskMetadata,
          status: TASK_STATUS.GENERATING,
          batchStatus: VIDEO_BATCH_STATUS.QUEUED,
          prompt: taskPrompt,
          ratio: sharedParams.ratio,
          duration: sharedParams.duration,
          seconds: sharedParams.seconds,
          resolution: sharedParams.resolution,
          size: sharedParams.size,
          preset: sharedParams.preset,
          model: sharedParams.model,
          group: sharedParams.group,
          referenceCount: sharedParams.referenceCount,
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

export const createVideoBatchQueueItems = createVideoBatchTasks;

export const summarizeVideoBatchTasks = (tasks = []) =>
  tasks.reduce(
    (summary, task) => {
      const batchStatus =
        task.batchStatus || batchStatusFromStatus(task.status);
      summary.total += 1;
      if (ACTIVE_BATCH_STATUSES.has(batchStatus)) {
        summary.active += 1;
        summary.running += 1;
      }
      if (batchStatus === VIDEO_BATCH_STATUS.QUEUED) summary.queued += 1;
      if (batchStatus === VIDEO_BATCH_STATUS.PROCESSING) summary.processing += 1;
      if (batchStatus === VIDEO_BATCH_STATUS.SUCCESS) summary.success += 1;
      if (batchStatus === VIDEO_BATCH_STATUS.ERROR) summary.error += 1;
      if (batchStatus === VIDEO_BATCH_STATUS.CANCELLED) summary.cancelled += 1;
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

export const loadVideoBatchTasks = () => {
  const storage = getStorage();
  if (!storage) return [];
  const parsed = safeParse(storage.getItem(VIDEO_BATCH_STORAGE_KEY), []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((task) => normalizeVideoBatchTask(task)).filter(Boolean);
};

export const reviveStaleActiveVideoTasks = (tasks) =>
  (tasks || []).map((task) =>
    task.status === TASK_STATUS.LOADING ||
    task.status === TASK_STATUS.GENERATING ||
    ACTIVE_BATCH_STATUSES.has(task.batchStatus)
      ? {
          ...task,
          status: TASK_STATUS.ERROR,
          batchStatus: VIDEO_BATCH_STATUS.ERROR,
          error: task.error || '页面刷新后任务已暂停，请重试',
        }
      : task,
  );

export const saveVideoBatchTasks = (tasks) => {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(
      VIDEO_BATCH_STORAGE_KEY,
      JSON.stringify(
        (tasks || [])
          .slice(0, 80)
          .map((task) => compactVideoTaskForStorage(task))
          .filter(Boolean),
      ),
    );
  } catch (error) {
    console.error('保存视频任务队列失败:', error);
  }
};

export const upsertVideoBatchTasks = (tasks, updates) => {
  const updateRows = Array.isArray(updates) ? updates : [updates];
  const updateMap = new Map(
    updateRows
      .filter(Boolean)
      .map((task) => [task.id, normalizeVideoBatchTask(task)]),
  );
  return (tasks || []).map((task) => updateMap.get(task.id) || task);
};

export const clearSettledVideoBatchTasks = (tasks) =>
  (tasks || []).filter((task) => !SETTLED_BATCH_STATUSES.has(task.batchStatus));

export const isVideoBatchGeneratedTask = (task, batchTaskIds) => {
  if (!task) return false;
  return (
    task.source === VIDEO_TASK_SOURCE.BATCH ||
    task.params?.source === VIDEO_TASK_SOURCE.BATCH ||
    Boolean(task.batchRowId || task.params?.batchRowId) ||
    Boolean(batchTaskIds?.has?.(task.id))
  );
};

export const removeVideoBatchTask = (tasks, taskId) =>
  (tasks || []).filter((task) => task.id !== taskId);

export const cancelVideoBatchTasks = (tasks, taskIds) => {
  const idSet = new Set(Array.isArray(taskIds) ? taskIds : [taskIds]);
  const cancelledAt = nowSeconds();
  return (tasks || []).map((task) => {
    if (!idSet.has(task.id)) return task;
    const batchStatus = task.batchStatus || batchStatusFromStatus(task.status);
    if (!ACTIVE_BATCH_STATUSES.has(batchStatus)) return task;
    return normalizeVideoBatchTask({
      ...task,
      status: TASK_STATUS.ERROR,
      batchStatus: VIDEO_BATCH_STATUS.CANCELLED,
      error: task.error || '\u5df2\u505c\u6b62',
      progress: 0,
      updated_at: cancelledAt,
    });
  });
};

export const retryVideoBatchTask = (task) =>
  normalizeVideoBatchTask({
    ...task,
    status: TASK_STATUS.GENERATING,
    batchStatus: VIDEO_BATCH_STATUS.QUEUED,
    error: '',
    url: '',
    progress: 0,
    retryCount: Number(task.retryCount || 0) + 1,
    updated_at: nowSeconds(),
  });

const processVideoBatchTask = async (
  task,
  { generate, onUpdate, shouldContinue },
) => {
  if (!shouldContinue(task)) return null;
  if (
    (task.batchStatus || VIDEO_BATCH_STATUS.QUEUED) !==
    VIDEO_BATCH_STATUS.QUEUED
  ) {
    return null;
  }

  const processingTask = normalizeVideoBatchTask({
    ...task,
    status: TASK_STATUS.GENERATING,
    batchStatus: VIDEO_BATCH_STATUS.PROCESSING,
    error: '',
    updated_at: nowSeconds(),
  });
  onUpdate?.(processingTask);

  try {
    const result = await generate(processingTask.params);
    const finalStatus =
      result?.status === TASK_STATUS.ERROR
        ? TASK_STATUS.ERROR
        : TASK_STATUS.SUCCESS;
    const successTask = normalizeVideoBatchTask({
      ...processingTask,
      ...result,
      id: processingTask.id,
      batchId: processingTask.batchId,
      kind: 'video',
      status: finalStatus,
      batchStatus:
        finalStatus === TASK_STATUS.ERROR
          ? VIDEO_BATCH_STATUS.ERROR
          : VIDEO_BATCH_STATUS.SUCCESS,
      source: processingTask.source,
      batchRowId: processingTask.batchRowId,
      batchRowIndex: processingTask.batchRowIndex,
      model: processingTask.model,
      group: processingTask.group,
      ratio: processingTask.ratio,
      duration: processingTask.duration,
      seconds: processingTask.seconds,
      resolution: processingTask.resolution,
      size: processingTask.size,
      preset: processingTask.preset,
      referenceCount: processingTask.referenceCount,
      params: processingTask.params,
      created_at: processingTask.created_at,
      updated_at: nowSeconds(),
    });
    onUpdate?.(successTask);
    return successTask;
  } catch (error) {
    const errorTask = normalizeVideoBatchTask({
      ...processingTask,
      status: TASK_STATUS.ERROR,
      batchStatus: VIDEO_BATCH_STATUS.ERROR,
      error: error?.message || 'video generation failed',
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

export const runVideoBatchQueue = async ({
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
      const result = await processVideoBatchTask(task, ctx);
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
