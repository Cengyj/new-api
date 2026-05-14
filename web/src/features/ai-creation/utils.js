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

import { CREATION_TABS, TASK_STATUS } from './constants.js';

let timestampIdCounter = 0;
const VIDEO_POLL_MIN_TIMEOUT = 10 * 60 * 1000;
const VIDEO_POLL_MAX_TIMEOUT = 30 * 60 * 1000;
const VIDEO_POLL_TIMEOUT_PER_SECOND = 30 * 1000;

export const getTimestampId = (prefix, index) => {
  const randomId =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : null;
  if (randomId) {
    const suffix = typeof index === 'number' ? `-${index}` : '';
    return `${prefix}-${randomId}${suffix}`;
  }

  timestampIdCounter = (timestampIdCounter + 1) % Number.MAX_SAFE_INTEGER;
  const suffix = typeof index === 'number' ? `-${index}` : '';
  return `${prefix}-${Date.now()}-${timestampIdCounter}${suffix}`;
};

export const resolveCreationTab = (tab) =>
  CREATION_TABS.includes(tab) ? tab : CREATION_TABS[0];

export const createImagePlaceholders = ({
  count,
  prompt,
  ratio,
  quality,
  referenceCount = 0,
}) =>
  Array(count)
    .fill(0)
    .map((_, index) => ({
      id: getTimestampId('image-pending', index),
      status: TASK_STATUS.LOADING,
      prompt,
      ratio,
      quality,
      referenceCount,
    }));

export const createVideoTask = ({ prompt, ratio, duration, resolution }) => ({
  id: getTimestampId('video-task'),
  status: TASK_STATUS.GENERATING,
  prompt,
  ratio,
  duration,
  resolution,
  progress: 0,
});

export const getVideoDurationSeconds = (params = {}) =>
  Number(String(params.duration ?? params.seconds ?? '').replace(/s$/i, '')) ||
  0;

export const getVideoPollTimeout = (params = {}) => {
  const seconds = getVideoDurationSeconds(params);
  if (!seconds) {
    return VIDEO_POLL_MIN_TIMEOUT;
  }
  return Math.min(
    VIDEO_POLL_MAX_TIMEOUT,
    Math.max(VIDEO_POLL_MIN_TIMEOUT, seconds * VIDEO_POLL_TIMEOUT_PER_SECOND),
  );
};

export const replaceTasksById = (tasks, placeholders, results) =>
  tasks.map((task) => {
    const index = placeholders.findIndex((item) => item.id === task.id);
    return index >= 0 ? results[index] || task : task;
  });

export const markTasksAsError = (tasks, targetTasks) =>
  tasks.map((task) =>
    targetTasks.some((item) => item.id === task.id)
      ? { ...task, status: TASK_STATUS.ERROR }
      : task,
  );

export const clampProgress = (progress, increment = 8, max = 92) =>
  Math.min(Number(progress || 0) + increment, max);

export const parseAspectRatio = (value, fallback = '') => {
  const text = String(value || '').trim();
  if (!text) return fallback;

  const match = text.match(/^(\d+(?:\.\d+)?)\s*(?::|\/|x|X)\s*(\d+(?:\.\d+)?)$/);
  if (!match) return fallback;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return fallback;
  }

  return `${width} / ${height}`;
};

export const getImageAspectRatio = (source = {}, fallback = '1 / 1') => {
  const width = source.width || source.params?.width;
  const height = source.height || source.params?.height;
  if (width && height) {
    return parseAspectRatio(`${width}x${height}`, fallback);
  }

  return (
    parseAspectRatio(source.ratio, '') ||
    parseAspectRatio(source.size, '') ||
    parseAspectRatio(source.params?.ratio, '') ||
    parseAspectRatio(source.params?.size, '') ||
    fallback
  );
};

export const readFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export const readImageFileAsDataUrl = (file) => {
  if (!file?.type?.startsWith('image/')) {
    return Promise.reject(new Error('unsupported image file'));
  }

  return readFileAsDataUrl(file);
};
