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

export const CREATION_RESULT_GROUP_INITIAL_COUNT = 24;
export const CREATION_RESULT_GROUP_BATCH_SIZE = 24;

function getResultItemKey(item) {
  return item?.task?.id || item?.id;
}

export function createCreationResultGroupItems(info = {}) {
  const completedItems = info.completedItems || [];
  const tasks = info.tasks || [];
  const completedByTaskId = new Map();
  completedItems.forEach((item) => {
    const key = getResultItemKey(item);
    if (key) {
      completedByTaskId.set(key, item);
    }
  });
  const failedIds = new Set((info.failedTasks || []).map((task) => task.id));
  const cancelledIds = new Set(
    (info.cancelledTasks || []).map((task) => task.id),
  );
  const taskIds = new Set(tasks.map((task) => task.id).filter(Boolean));

  const taskItems = tasks.map((task, index) => {
    const completedItem = completedByTaskId.get(task.id);
    if (completedItem) {
      return {
        ...completedItem,
        task,
        status: 'success',
        resultIndex: index,
      };
    }

    return {
      id: task.id,
      task,
      status: failedIds.has(task.id)
        ? 'failed'
        : cancelledIds.has(task.id)
          ? 'cancelled'
          : 'processing',
      error: task.error || '',
      resultIndex: index,
    };
  });

  const orphanCompletedItems = completedItems
    .filter((item) => {
      const key = getResultItemKey(item);
      return !key || !taskIds.has(key);
    })
    .map((item, index) => ({
      ...item,
      status: 'success',
      resultIndex: taskItems.length + index,
    }));

  return [...taskItems, ...orphanCompletedItems];
}

export function createCreationResultGroupStats(info = {}) {
  return {
    completed: info.completedCount,
    failed: info.failedCount,
    processing: info.processingCount,
    cancelled: info.cancelledCount,
    total: info.tasks?.length,
  };
}

export function normalizeCreationResultGroupStats(stats = {}, items = []) {
  const inferred = items.reduce(
    (acc, item) => {
      const status = item?.status || 'success';
      if (status === 'success') acc.completed += 1;
      else if (status === 'failed') acc.failed += 1;
      else if (status === 'cancelled') acc.cancelled += 1;
      else acc.processing += 1;
      return acc;
    },
    { completed: 0, failed: 0, processing: 0, cancelled: 0 },
  );

  const completed = Number(stats.completed ?? stats.completedCount);
  const failed = Number(stats.failed ?? stats.failedCount);
  const processing = Number(stats.processing ?? stats.processingCount);
  const cancelled = Number(stats.cancelled ?? stats.cancelledCount);

  return {
    completed: Number.isFinite(completed) ? completed : inferred.completed,
    failed: Number.isFinite(failed) ? failed : inferred.failed,
    processing: Number.isFinite(processing) ? processing : inferred.processing,
    cancelled: Number.isFinite(cancelled) ? cancelled : inferred.cancelled,
    total:
      Number(stats.total ?? stats.totalCount) ||
      items.length ||
      inferred.completed +
        inferred.failed +
        inferred.processing +
        inferred.cancelled,
  };
}

export function isCreationResultGroupRetryable(stats = {}) {
  return (stats.failed || 0) > 0 || (stats.cancelled || 0) > 0;
}
