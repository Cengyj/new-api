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

import { API } from '../../helpers/api';
import { TASK_STATUS } from './constants.js';
import {
  DEFAULT_VIDEO_ENDPOINT,
  buildImageSubmitRequest,
  buildVideoSubmitRequest,
  normalizeImageGenerationResponse,
  normalizeVideoTaskResponse,
} from './adapters.js';
import { getVideoPollTimeout } from './utils.js';

const VIDEO_GENERATION_ENDPOINT = DEFAULT_VIDEO_ENDPOINT;
const VIDEO_POLL_INTERVAL = 2000;

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

// Extract a richer error description from an axios-style error / generic error.
// We carry the raw upstream body so the UI can show "details" to the user.
const enrichApiError = (error, fallbackMessage) => {
  const responseData = error?.response?.data;
  const upstreamMessage =
    responseData?.error?.message ||
    responseData?.message ||
    (typeof responseData?.error === 'string' ? responseData.error : '') ||
    error?.message ||
    fallbackMessage ||
    'request failed';
  const status = error?.response?.status;
  const headline = status
    ? `[HTTP ${status}] ${upstreamMessage}`
    : upstreamMessage;
  const enriched = new Error(headline);
  enriched.cause = error;
  enriched.status = status;
  enriched.rawBody = responseData;
  enriched.detail = {
    message: upstreamMessage,
    status,
    body: responseData,
  };
  return enriched;
};

const callImageEndpoint = async (endpoint, payload, params, fallback) => {
  try {
    const response = await API.post(endpoint, payload);
    return normalizeImageGenerationResponse(response, params);
  } catch (error) {
    throw enrichApiError(error, fallback);
  }
};

export const generateImages = async (params) => {
  const submitRequest = await buildImageSubmitRequest(params);
  return callImageEndpoint(
    submitRequest.endpoint,
    submitRequest.body,
    submitRequest.params,
    submitRequest.fallback,
  );
};

export const pollVideoGeneration = async (taskId, params, options = {}) => {
  const startedAt = Date.now();
  const polling = options.polling || {};
  const timeoutMs = Number(polling.timeoutMs || options.timeoutMs) || getVideoPollTimeout(params);
  const pollIntervalMs =
    Number(polling.intervalMs || options.pollIntervalMs) || VIDEO_POLL_INTERVAL;
  const endpoint = options.pollEndpoint || VIDEO_GENERATION_ENDPOINT;
  const normalize =
    options.normalizeTaskResponse || normalizeVideoTaskResponse;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);
    const response = await API.get(`${endpoint}/${taskId}`);
    const task = normalize(response, params);

    if (
      task.status === TASK_STATUS.SUCCESS ||
      task.status === TASK_STATUS.ERROR
    ) {
      return task;
    }
  }

  throw new Error(
    `video generation polling timeout after ${Math.round(timeoutMs / 1000)}s`,
  );
};

export const generateVideo = async (params) => {
  let response;
  let submitRequest;
  try {
    submitRequest = await buildVideoSubmitRequest(params);
    const requestConfig = submitRequest.headers
      ? { headers: submitRequest.headers }
      : undefined;
    response = requestConfig
      ? await API.post(submitRequest.endpoint, submitRequest.body, requestConfig)
      : await API.post(submitRequest.endpoint, submitRequest.body);
  } catch (error) {
    throw enrichApiError(error, 'video generation failed');
  }
  const normalize =
    submitRequest?.normalizeTaskResponse || normalizeVideoTaskResponse;
  const videoParams = submitRequest?.params || params;
  const task = normalize(response, videoParams);

  if (
    task.status === TASK_STATUS.SUCCESS ||
    task.status === TASK_STATUS.ERROR
  ) {
    return task;
  }

  try {
    return await pollVideoGeneration(task.id, videoParams, {
      pollEndpoint: submitRequest?.pollEndpoint,
      polling: submitRequest?.polling,
      normalizeTaskResponse: normalize,
    });
  } catch (error) {
    throw enrichApiError(error, 'video generation polling failed');
  }
};
