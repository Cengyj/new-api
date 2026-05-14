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

export const MAX_CREATION_CONCURRENCY = 10;
export const CREATION_CONCURRENCY_OPTIONS = [1, 2, 3, 5, 8, 10];

const ACTIVE_BATCH_STATUSES = new Set(['queued', 'processing']);
const CANCELLED_BATCH_STATUSES = new Set(['cancelled']);

export const clampCreationConcurrency = (value) => {
  const parsed = Math.floor(Number(value) || 1);
  return Math.max(1, Math.min(MAX_CREATION_CONCURRENCY, parsed));
};

export const getCreationTaskBatchStatus = (taskOrStatus) => {
  if (!taskOrStatus) return '';
  if (typeof taskOrStatus === 'string') return taskOrStatus;
  return taskOrStatus.batchStatus || taskOrStatus.status || '';
};

export const isCreationTaskActive = (taskOrStatus) => {
  if (!taskOrStatus) return false;
  const batchStatus = getCreationTaskBatchStatus(taskOrStatus);
  const status =
    typeof taskOrStatus === 'object' ? taskOrStatus.status : taskOrStatus;
  return (
    ACTIVE_BATCH_STATUSES.has(batchStatus) ||
    status === TASK_STATUS.LOADING ||
    status === TASK_STATUS.GENERATING
  );
};

export const isCreationTaskCancelled = (taskOrStatus) =>
  CANCELLED_BATCH_STATUSES.has(getCreationTaskBatchStatus(taskOrStatus));

export const getCreationTaskStatusLabel = (taskOrStatus, t = (value) => value) => {
  if (isCreationTaskCancelled(taskOrStatus)) return t('已停止');
  const batchStatus = getCreationTaskBatchStatus(taskOrStatus);
  const status =
    typeof taskOrStatus === 'object' ? taskOrStatus.status : taskOrStatus;

  if (status === TASK_STATUS.SUCCESS || batchStatus === 'success') {
    return t('已完成');
  }
  if (status === TASK_STATUS.ERROR || batchStatus === 'error') {
    return t('失败');
  }
  if (batchStatus === 'queued') return t('排队中');
  if (
    batchStatus === 'processing' ||
    status === TASK_STATUS.LOADING ||
    status === TASK_STATUS.GENERATING
  ) {
    return t('生成中');
  }
  return t('排队中');
};
