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

import { generateVideo } from './services.js';
import {
  cancelVideoBatchTasks,
  clearSettledVideoBatchTasks,
  loadVideoBatchTasks,
  removeVideoBatchTask,
  retryVideoBatchTask,
  reviveStaleActiveVideoTasks,
  runVideoBatchQueue,
  saveVideoBatchTasks,
  upsertVideoBatchTasks,
} from './videoBatchQueue.js';
import {
  clearAllCachedBlobs,
  deleteCachedBlob,
  deleteCachedBlobs,
  warmVideoBlobCache,
} from './videoCache.js';
import { TASK_STATUS } from './constants.js';
import { isCreationTaskActive } from './creationTaskUtils.js';

const loadInitialTasks = () => {
  const persisted = loadVideoBatchTasks();
  return reviveStaleActiveVideoTasks(persisted);
};

let tasks = loadInitialTasks();
const listeners = new Set();
const deletedTaskIds = new Set();
const cancelledTaskIds = new Set();
const taskAttemptTokens = new Map();
let processing = Promise.resolve();

const notify = () => {
  saveVideoBatchTasks(tasks);
  listeners.forEach((listener) => {
    try {
      listener(tasks);
    } catch (error) {
      console.error('video creation listener error:', error);
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
      await runVideoBatchQueue({
        tasks: queuedTasks,
        generate: async (params) => generateVideo(params),
        onUpdate: (nextTask) => {
          if (
            deletedTaskIds.has(nextTask.id) ||
            cancelledTaskIds.has(nextTask.id) ||
            taskAttemptTokens.get(nextTask.id) !== attemptTokens.get(nextTask.id)
          ) {
            return;
          }
          setTasks((prev) => upsertVideoBatchTasks(prev, nextTask));
          // When a task succeeds, download and cache the video blob in the background.
          if (
            nextTask.status === TASK_STATUS.SUCCESS &&
            nextTask.url &&
            !nextTask.url.startsWith('blob:')
          ) {
            warmVideoBlobCache(nextTask.id, nextTask.url).catch(() => {});
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
      console.error('video batch queue failed:', error);
    });
};

export const getVideoTasks = () => tasks;

export const subscribeVideoTasks = (listener) => {
  listeners.add(listener);
  listener(tasks);
  return () => {
    listeners.delete(listener);
  };
};

export const enqueueVideoTasks = (queuedTasks, concurrency) => {
  if (!queuedTasks?.length) return;
  queuedTasks.forEach((task) => deletedTaskIds.delete(task.id));
  queuedTasks.forEach((task) => cancelledTaskIds.delete(task.id));
  setTasks((prev) => [...queuedTasks, ...prev]);
  enqueueProcessing(queuedTasks, concurrency);
};

export const retryVideoTask = (task) => {
  const retryItem = retryVideoBatchTask(task);
  deletedTaskIds.delete(task.id);
  cancelledTaskIds.delete(task.id);
  setTasks((prev) => upsertVideoBatchTasks(prev, retryItem));
  enqueueProcessing([retryItem]);
};

export const cancelVideoTasks = (taskIds) => {
  if (!taskIds?.length) return;
  const activeIds = (tasks || [])
    .filter((task) => taskIds.includes(task.id) && isCreationTaskActive(task))
    .map((task) => task.id);
  if (!activeIds.length) return;
  activeIds.forEach((id) => cancelledTaskIds.add(id));
  setTasks((prev) => cancelVideoBatchTasks(prev, activeIds));
};

export const cancelVideoTask = (taskId) => {
  cancelVideoTasks([taskId]);
};

export const cancelActiveVideoTasks = () => {
  cancelVideoTasks((tasks || []).filter(isCreationTaskActive).map((task) => task.id));
};

export const deleteVideoTask = (taskId) => {
  deletedTaskIds.add(taskId);
  cancelledTaskIds.add(taskId);
  setTasks((prev) => removeVideoBatchTask(prev, taskId));
  deleteCachedBlob(taskId).catch(() => {});
};

export const deleteVideoTasks = (taskIds) => {
  if (!taskIds?.length) return;
  const idSet = new Set(taskIds);
  idSet.forEach((id) => deletedTaskIds.add(id));
  idSet.forEach((id) => cancelledTaskIds.add(id));
  setTasks((prev) => (prev || []).filter((task) => !idSet.has(task.id)));
  deleteCachedBlobs([...idSet]).catch(() => {});
};

export const clearAllVideoTasks = () => {
  tasks.forEach((task) => deletedTaskIds.add(task.id));
  tasks.forEach((task) => cancelledTaskIds.add(task.id));
  setTasks([]);
  clearAllCachedBlobs().catch(() => {});
};

export const clearSettledVideoTasks = () => {
  const removed = (tasks || []).filter(
    (t) =>
      t.status === TASK_STATUS.SUCCESS ||
      t.status === TASK_STATUS.ERROR ||
      t.batchStatus === 'cancelled',
  );
  setTasks((prev) => clearSettledVideoBatchTasks(prev));
  if (removed.length) deleteCachedBlobs(removed.map((t) => t.id)).catch(() => {});
};

export const clearFailedVideoTasks = () => {
  const removed = (tasks || []).filter((t) => t.batchStatus === 'error');
  setTasks((prev) => (prev || []).filter((task) => task.batchStatus !== 'error'));
  if (removed.length) deleteCachedBlobs(removed.map((t) => t.id)).catch(() => {});
};

export const replaceVideoTasks = (next) => {
  setTasks(next);
};
