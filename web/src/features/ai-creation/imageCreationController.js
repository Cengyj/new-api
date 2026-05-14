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

import { generateImages } from './services.js';
import {
  cancelImageBatchTasks,
  clearSettledImageBatchTasks,
  loadImageBatchTasks,
  removeImageBatchTask,
  retryImageBatchTask,
  reviveStaleActiveImageTasks,
  runImageBatchQueue,
  saveImageBatchTasks,
  upsertImageBatchTasks,
} from './imageBatchQueue.js';
import {
  clearAllCachedBlobs,
  deleteCachedBlob,
  deleteCachedBlobs,
  warmImageBlobCache,
} from './imageCache.js';
import { TASK_STATUS } from './constants.js';
import { isCreationTaskActive } from './creationTaskUtils.js';

const loadInitialTasks = () => {
  const persisted = loadImageBatchTasks();
  return reviveStaleActiveImageTasks(persisted);
};

let tasks = loadInitialTasks();
const listeners = new Set();
const deletedTaskIds = new Set();
const cancelledTaskIds = new Set();
const taskAttemptTokens = new Map();
let processing = Promise.resolve();

const notify = () => {
  saveImageBatchTasks(tasks);
  listeners.forEach((listener) => {
    try {
      listener(tasks);
    } catch (error) {
      console.error('image creation listener error:', error);
    }
  });
};

const setTasks = (updater) => {
  const next = typeof updater === 'function' ? updater(tasks) : updater;
  if (next === tasks) return;
  tasks = next;
  notify();
};

const enqueueProcessing = (queuedTasks, concurrency = 1) => {
  const attemptTokens = new Map();
  queuedTasks.forEach((task) => {
    const token = Symbol(task.id);
    taskAttemptTokens.set(task.id, token);
    attemptTokens.set(task.id, token);
  });
  processing = processing
    .then(async () => {
      await runImageBatchQueue({
        tasks: queuedTasks,
        generate: async (params) =>
          generateImages({ ...params, count: 1 }),
        onUpdate: (nextTask) => {
          if (
            deletedTaskIds.has(nextTask.id) ||
            cancelledTaskIds.has(nextTask.id) ||
            taskAttemptTokens.get(nextTask.id) !== attemptTokens.get(nextTask.id)
          ) {
            return;
          }
          setTasks((prev) => upsertImageBatchTasks(prev, nextTask));
          if (
            nextTask.status === TASK_STATUS.SUCCESS &&
            nextTask.url &&
            !nextTask.url.startsWith('blob:') &&
            !nextTask.url.startsWith('data:')
          ) {
            warmImageBlobCache(nextTask.id, nextTask.url).catch(() => {});
          }
        },
        shouldContinue: (task) =>
          !deletedTaskIds.has(task.id) &&
          !cancelledTaskIds.has(task.id) &&
          taskAttemptTokens.get(task.id) === attemptTokens.get(task.id),
        concurrency,
      });
    })
    .catch((error) => {
      console.error('image batch queue failed:', error);
    });
};

export const getImageTasks = () => tasks;

export const subscribeImageTasks = (listener) => {
  listeners.add(listener);
  listener(tasks);
  return () => {
    listeners.delete(listener);
  };
};

export const enqueueImageTasks = (queuedTasks, concurrency) => {
  if (!queuedTasks?.length) return;
  queuedTasks.forEach((task) => deletedTaskIds.delete(task.id));
  queuedTasks.forEach((task) => cancelledTaskIds.delete(task.id));
  setTasks((prev) => [...queuedTasks, ...prev]);
  enqueueProcessing(queuedTasks, concurrency);
};

export const retryImageTask = (task) => {
  const retryItem = retryImageBatchTask(task);
  deletedTaskIds.delete(task.id);
  cancelledTaskIds.delete(task.id);
  setTasks((prev) => upsertImageBatchTasks(prev, retryItem));
  enqueueProcessing([retryItem]);
};

export const cancelImageTasks = (taskIds) => {
  if (!taskIds?.length) return;
  const activeIds = (tasks || [])
    .filter((task) => taskIds.includes(task.id) && isCreationTaskActive(task))
    .map((task) => task.id);
  if (!activeIds.length) return;
  activeIds.forEach((id) => cancelledTaskIds.add(id));
  setTasks((prev) => cancelImageBatchTasks(prev, activeIds));
};

export const cancelImageTask = (taskId) => {
  cancelImageTasks([taskId]);
};

export const cancelActiveImageTasks = () => {
  cancelImageTasks((tasks || []).filter(isCreationTaskActive).map((task) => task.id));
};

export const deleteImageTask = (taskId) => {
  deletedTaskIds.add(taskId);
  cancelledTaskIds.add(taskId);
  setTasks((prev) => removeImageBatchTask(prev, taskId));
  deleteCachedBlob(taskId).catch(() => {});
};

export const deleteImageTasks = (taskIds) => {
  if (!taskIds?.length) return;
  const idSet = new Set(taskIds);
  idSet.forEach((id) => deletedTaskIds.add(id));
  idSet.forEach((id) => cancelledTaskIds.add(id));
  setTasks((prev) => (prev || []).filter((task) => !idSet.has(task.id)));
  deleteCachedBlobs([...idSet]).catch(() => {});
};

export const clearAllImageTasks = () => {
  tasks.forEach((task) => deletedTaskIds.add(task.id));
  tasks.forEach((task) => cancelledTaskIds.add(task.id));
  setTasks([]);
  clearAllCachedBlobs().catch(() => {});
};

export const clearSettledImageTasks = () => {
  const removed = (tasks || []).filter(
    (t) =>
      t.status === TASK_STATUS.SUCCESS ||
      t.status === TASK_STATUS.ERROR ||
      t.batchStatus === 'cancelled',
  );
  setTasks((prev) => clearSettledImageBatchTasks(prev));
  if (removed.length) deleteCachedBlobs(removed.map((t) => t.id)).catch(() => {});
};

export const clearFailedImageTasks = () => {
  const removed = (tasks || []).filter((t) => t.batchStatus === 'error');
  setTasks((prev) => (prev || []).filter((task) => task.batchStatus !== 'error'));
  if (removed.length) deleteCachedBlobs(removed.map((t) => t.id)).catch(() => {});
};

export const replaceImageTasks = (next) => {
  setTasks(next);
};
