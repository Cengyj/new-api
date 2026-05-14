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
import { getImageFilename, referenceImageToBlob } from './mediaFiles.js';
import { getTimestampId } from './utils.js';
import {
  GROK_VIDEO_MODEL,
  getVideoAdapterKeyForModel,
  getVideoModelSpec,
  getVideoPollingSpecForModel,
  getVideoPollingTimeoutForModel,
  getVideoResponseSpecForModel,
} from './videoModelRegistry.js';
import {
  getVideoReferenceImages,
  getVideoSeconds,
  normalizeVideoGenerationParams,
} from './videoParams.js';

export const DEFAULT_VIDEO_ENDPOINT = '/pg/videos';

const VIDEO_STATUS_MAP = {
  not_start: TASK_STATUS.GENERATING,
  submitted: TASK_STATUS.GENERATING,
  queued: TASK_STATUS.GENERATING,
  pending: TASK_STATUS.GENERATING,
  running: TASK_STATUS.GENERATING,
  in_progress: TASK_STATUS.GENERATING,
  processing: TASK_STATUS.GENERATING,
  succeeded: TASK_STATUS.SUCCESS,
  completed: TASK_STATUS.SUCCESS,
  success: TASK_STATUS.SUCCESS,
  failure: TASK_STATUS.ERROR,
  failed: TASK_STATUS.ERROR,
  error: TASK_STATUS.ERROR,
  cancelled: TASK_STATUS.ERROR,
  expired: TASK_STATUS.ERROR,
};

const VIDEO_CONTENT_PATH_PATTERN = /^\/v1\/videos\/[^/]+\/content$/;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

const unwrapResponseData = (response) => {
  const body = response?.data ?? response;
  if (
    body?.success === true &&
    Object.prototype.hasOwnProperty.call(body, 'data')
  ) {
    return body.data;
  }
  return body;
};

const isObject = (value) => value && typeof value === 'object';

const isLoopbackHostname = (hostname) =>
  LOOPBACK_HOSTNAMES.has(String(hostname || '').replace(/^\[|\]$/g, ''));

const trimWwwPrefix = (hostname) =>
  String(hostname || '').toLowerCase().replace(/^www\./, '');

const isSameSiteHostname = (left, right) => {
  const normalizedLeft = trimWwwPrefix(left);
  const normalizedRight = trimWwwPrefix(right);
  return normalizedLeft && normalizedLeft === normalizedRight;
};

const getSubmitEndpoint = (config) =>
  config?.request?.endpoint || DEFAULT_VIDEO_ENDPOINT;

const getPollEndpoint = (config) =>
  config?.request?.pollEndpoint ||
  config?.request?.endpoint ||
  DEFAULT_VIDEO_ENDPOINT;

const getFieldValue = (source, path) => {
  if (!isObject(source) || !path) return undefined;
  return String(path)
    .split('.')
    .reduce((value, key) => (isObject(value) ? value[key] : undefined), source);
};

const getFirstFieldValue = (source, fields = []) => {
  for (const field of fields) {
    const value = getFieldValue(source, field);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

const renderContentUrl = (template, id) =>
  template && id ? template.replace('{id}', encodeURIComponent(id)) : '';

export const normalizeVideoContentUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    return value;
  }
  const url = value.trim();
  if (url.startsWith('/')) {
    return url;
  }

  const currentOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : '';
  try {
    const parsed = new URL(url);
    if (!VIDEO_CONTENT_PATH_PATTERN.test(parsed.pathname)) {
      return url;
    }
    if (!currentOrigin) {
      return isLoopbackHostname(parsed.hostname)
        ? `${parsed.pathname}${parsed.search}${parsed.hash}`
        : url;
    }

    const current = new URL(currentOrigin);
    const sameOrigin = parsed.origin === current.origin;
    const sameSite =
      parsed.protocol === current.protocol &&
      isSameSiteHostname(parsed.hostname, current.hostname);
    const sameLocalServer =
      isLoopbackHostname(parsed.hostname) &&
      isLoopbackHostname(current.hostname) &&
      parsed.port === current.port &&
      parsed.protocol === current.protocol;

    return sameOrigin || sameSite || sameLocalServer
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : url;
  } catch {
    return url;
  }
};

export { getVideoSeconds };

export const getVideoReferences = (params = {}) =>
  getVideoReferenceImages(params, getVideoModelSpec(params.model).capabilities);

export const buildGrokVideoFormDataWithConfig = async (params = {}) => {
  const videoParams = normalizeVideoGenerationParams({
    ...params,
    model: params.model || GROK_VIDEO_MODEL,
  });

  const formData = new FormData();
  formData.append('model', videoParams.model);
  formData.append('prompt', videoParams.prompt);
  if (videoParams.seconds) {
    formData.append('seconds', String(videoParams.seconds));
  }
  formData.append('size', videoParams.size);
  formData.append('resolution_name', videoParams.resolution);
  formData.append('preset', videoParams.preset);
  if (videoParams.group) {
    formData.append('group', videoParams.group);
  }

  for (const [index, image] of videoParams.referenceImages.entries()) {
    const blob = await referenceImageToBlob(image);
    formData.append(
      videoParams.referenceFieldName,
      blob,
      getImageFilename(image, index, blob.type),
    );
  }

  return formData;
};

const unwrapVideoTaskBody = (responseData, responseSpec = {}) => {
  const body = unwrapResponseData(responseData);
  return body?.code === responseSpec.successCode && body?.data ? body.data : body;
};

const mapVideoTaskStatus = (taskBody, responseSpec) => {
  const status = String(
    getFirstFieldValue(taskBody, responseSpec.statusFields) || '',
  ).toLowerCase();
  return VIDEO_STATUS_MAP[status] || TASK_STATUS.GENERATING;
};

const extractVideoTaskId = (taskBody, responseSpec) =>
  getFirstFieldValue(taskBody, responseSpec.idFields) || '';

const extractVideoTaskUrl = (taskBody, responseSpec) =>
  getFirstFieldValue(taskBody, responseSpec.urlFields) || '';

const extractVideoTaskProgress = (taskBody, responseSpec, mappedStatus) => {
  if (mappedStatus === TASK_STATUS.SUCCESS) return 100;
  return (
    Number.parseInt(
      String(getFirstFieldValue(taskBody, responseSpec.progressFields) || 0),
      10,
    ) || 0
  );
};

const extractVideoTaskError = (taskBody, responseSpec) => {
  const error = getFirstFieldValue(taskBody, responseSpec.errorFields);
  if (typeof error === 'string') return error;
  return error?.message || undefined;
};

const createFallbackVideoTaskId = () => getTimestampId('vid');

const normalizeGenericVideoTaskResponse = (
  responseData,
  params = {},
  config,
) => {
  const responseSpec =
    config?.response || getVideoResponseSpecForModel(params.model || GROK_VIDEO_MODEL);
  const taskBody = unwrapVideoTaskBody(responseData, responseSpec);
  const mappedStatus = mapVideoTaskStatus(taskBody, responseSpec);
  const id = extractVideoTaskId(taskBody, responseSpec);
  const normalizedUrl = normalizeVideoContentUrl(
    extractVideoTaskUrl(taskBody, responseSpec),
  );

  return {
    id: id || createFallbackVideoTaskId(),
    url:
      normalizedUrl ||
      (mappedStatus === TASK_STATUS.SUCCESS && id
        ? renderContentUrl(responseSpec.contentUrlTemplate, id)
        : ''),
    status: mappedStatus,
    prompt:
      getFirstFieldValue(taskBody, ['prompt', 'data.prompt']) || params.prompt,
    ratio: params.ratio,
    duration: params.duration,
    resolution: params.resolution,
    progress: extractVideoTaskProgress(taskBody, responseSpec, mappedStatus),
    error: extractVideoTaskError(taskBody, responseSpec),
  };
};

const makePollingRuntime = (model, params = {}) => {
  const spec = getVideoPollingSpecForModel(model);
  return {
    ...spec,
    timeoutMs: getVideoPollingTimeoutForModel(model, params),
  };
};

export const GROK_VIDEO_ADAPTER = Object.freeze({
  provider: 'grok',
  adapter: 'grok',
  endpoint: DEFAULT_VIDEO_ENDPOINT,
  pollEndpoint: DEFAULT_VIDEO_ENDPOINT,
  buildSubmitRequest: async (params = {}, config) => {
    const endpoint = getSubmitEndpoint(config);
    const normalizedParams = normalizeVideoGenerationParams(params);
    return {
      endpoint,
      pollEndpoint: getPollEndpoint(config),
      body: await buildGrokVideoFormDataWithConfig(normalizedParams),
      params: normalizedParams,
      polling: makePollingRuntime(normalizedParams.model, normalizedParams),
    };
  },
  buildFormData: buildGrokVideoFormDataWithConfig,
  normalizeTaskResponse: normalizeGenericVideoTaskResponse,
});

export const VIDEO_PROVIDER_ADAPTERS = Object.freeze({
  grok: GROK_VIDEO_ADAPTER,
});

export const getVideoProviderAdapter = (modelCode) => {
  const adapterKey = getVideoAdapterKeyForModel(modelCode);
  return VIDEO_PROVIDER_ADAPTERS[adapterKey] || VIDEO_PROVIDER_ADAPTERS.grok;
};

export const buildVideoSubmitRequest = async (params = {}) => {
  const model = params.model || GROK_VIDEO_MODEL;
  const config = getVideoModelSpec(model);
  const adapter = getVideoProviderAdapter(model);
  const request = await adapter.buildSubmitRequest(params, config);
  const normalizedParams = request.params || normalizeVideoGenerationParams(params);
  const polling = request.polling || makePollingRuntime(normalizedParams.model, normalizedParams);

  return {
    endpoint: request.endpoint || adapter.endpoint || DEFAULT_VIDEO_ENDPOINT,
    pollEndpoint:
      request.pollEndpoint ||
      adapter.pollEndpoint ||
      request.endpoint ||
      adapter.endpoint ||
      DEFAULT_VIDEO_ENDPOINT,
    body: request.body,
    headers: request.headers,
    params: normalizedParams,
    polling,
    normalizeTaskResponse:
      request.normalizeTaskResponse ||
      adapter.normalizeTaskResponse ||
      normalizeGenericVideoTaskResponse,
    model: normalizedParams.model,
    provider: normalizedParams.provider || config.provider,
    adapter: getVideoAdapterKeyForModel(normalizedParams.model),
  };
};

export const buildVideoFormData = async (params = {}) =>
  (await buildVideoSubmitRequest(params)).body;

export const buildGrokVideoFormData = async (params = {}) =>
  buildGrokVideoFormDataWithConfig({
    ...params,
    model: params.model || GROK_VIDEO_MODEL,
  });

export const normalizeVideoTaskResponse = (responseData, params = {}) => {
  const model = params.model || GROK_VIDEO_MODEL;
  const adapter = getVideoProviderAdapter(model);
  return (adapter.normalizeTaskResponse || normalizeGenericVideoTaskResponse)(
    responseData,
    params,
    getVideoModelSpec(model),
  );
};
