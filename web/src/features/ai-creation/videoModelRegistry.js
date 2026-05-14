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

export const GROK_VIDEO_MODEL = 'grok-imagine-video';

export const VIDEO_PROVIDERS = Object.freeze({
  GROK: 'grok',
});

export const VIDEO_ADAPTERS = Object.freeze({
  GROK: 'grok',
});

export const VIDEO_TRANSPORTS = Object.freeze({
  MULTIPART: 'multipart',
  JSON: 'json',
});

export const VIDEO_RATIO_OPTIONS = Object.freeze([
  Object.freeze({ label: '16:9', value: '16:9' }),
  Object.freeze({ label: '9:16', value: '9:16' }),
  Object.freeze({ label: '1:1', value: '1:1' }),
]);

export const VIDEO_RESOLUTION_OPTIONS = Object.freeze([
  Object.freeze({ label: '480p', value: '480p' }),
  Object.freeze({ label: '720p', value: '720p' }),
]);

const GROK_VIDEO_DURATION_OPTIONS = Object.freeze([
  Object.freeze({ label: '6s', value: '6s' }),
  Object.freeze({ label: '10s', value: '10s' }),
  Object.freeze({ label: '12s', value: '12s' }),
  Object.freeze({ label: '16s', value: '16s' }),
  Object.freeze({ label: '20s', value: '20s' }),
]);

const GROK_VIDEO_DEFAULTS = Object.freeze({
  ratio: '16:9',
  duration: '6s',
  resolution: '720p',
  preset: 'normal',
});

const DEFAULT_VIDEO_PARAM_SCHEMA = Object.freeze({
  prompt: Object.freeze({ required: true }),
  ratio: Object.freeze({ source: 'ratioOptions' }),
  duration: Object.freeze({ source: 'durationOptions' }),
  seconds: Object.freeze({ derivedFrom: 'duration' }),
  resolution: Object.freeze({ source: 'resolutionOptions' }),
  resolution_name: Object.freeze({ derivedFrom: 'resolution' }),
  size: Object.freeze({ derivedFrom: 'ratio+resolution' }),
  preset: Object.freeze({ source: 'capabilities.supportedPresets' }),
  referenceImages: Object.freeze({ source: 'capabilities.maxReferenceImages' }),
});

const DEFAULT_VIDEO_POLLING_SPEC = Object.freeze({
  intervalMs: 2000,
  minTimeoutMs: 10 * 60 * 1000,
  maxTimeoutMs: 30 * 60 * 1000,
  timeoutPerSecondMs: 30 * 1000,
});

const GROK_VIDEO_RESPONSE_SPEC = Object.freeze({
  payloadField: 'data',
  successCode: 'success',
  contentUrlTemplate: '/v1/videos/{id}/content',
  idFields: Object.freeze(['task_id', 'id', 'data.task_id', 'data.id']),
  statusFields: Object.freeze(['data.status', 'status']),
  urlFields: Object.freeze([
    'url',
    'result_url',
    'metadata.url',
    'metadata.video_url',
    'video_url',
    'data.url',
    'data.result_url',
    'data.video_url',
    'data.metadata.url',
    'data.metadata.video_url',
  ]),
  progressFields: Object.freeze([
    'progress',
    'metadata.progress',
    'data.progress',
    'data.metadata.progress',
  ]),
  errorFields: Object.freeze([
    'error.message',
    'error',
    'fail_reason',
    'message',
    'data.error.message',
    'data.error',
    'data.fail_reason',
    'data.message',
  ]),
});

const GROK_VIDEO_SIZE_MAP = Object.freeze({
  '16:9': Object.freeze({
    '480p': '1280x720',
    '720p': '1792x1024',
  }),
  '9:16': Object.freeze({
    '480p': '720x1280',
    '720p': '1024x1792',
  }),
  '1:1': Object.freeze({
    '480p': '1024x1024',
    '720p': '1024x1024',
  }),
});

const defineVideoModelSpec = ({
  modelCode,
  provider,
  adapter = provider,
  label,
  defaults = GROK_VIDEO_DEFAULTS,
  capabilities,
  request,
  response = GROK_VIDEO_RESPONSE_SPEC,
  paramSchema = DEFAULT_VIDEO_PARAM_SCHEMA,
  polling = DEFAULT_VIDEO_POLLING_SPEC,
  sizeMap = Object.freeze({}),
}) =>
  Object.freeze({
    modelCode,
    provider,
    adapter,
    label,
    defaults,
    capabilities: Object.freeze(capabilities),
    request: Object.freeze(request),
    response,
    paramSchema,
    polling,
    sizeMap,
  });

const grokVideoCapabilities = Object.freeze({
  ratioOptions: VIDEO_RATIO_OPTIONS,
  durationOptions: GROK_VIDEO_DURATION_OPTIONS,
  resolutionOptions: VIDEO_RESOLUTION_OPTIONS,
  supportedSeconds: Object.freeze([6, 10, 12, 16, 20]),
  supportedPresets: Object.freeze(['fun', 'normal', 'spicy', 'custom']),
  supportsReferenceImages: true,
  maxReferenceImages: 7,
});

const grokVideoRequest = Object.freeze({
  transport: VIDEO_TRANSPORTS.MULTIPART,
  endpoint: '/pg/videos',
  pollEndpoint: '/pg/videos',
  referenceFieldName: 'input_reference[]',
});

export const VIDEO_MODEL_SPECS = Object.freeze({
  [GROK_VIDEO_MODEL]: defineVideoModelSpec({
    modelCode: GROK_VIDEO_MODEL,
    provider: VIDEO_PROVIDERS.GROK,
    adapter: VIDEO_ADAPTERS.GROK,
    label: 'Grok Imagine Video',
    defaults: GROK_VIDEO_DEFAULTS,
    capabilities: grokVideoCapabilities,
    request: grokVideoRequest,
    response: GROK_VIDEO_RESPONSE_SPEC,
    paramSchema: DEFAULT_VIDEO_PARAM_SCHEMA,
    polling: DEFAULT_VIDEO_POLLING_SPEC,
    sizeMap: GROK_VIDEO_SIZE_MAP,
  }),
});

export const DEFAULT_VIDEO_MODEL = GROK_VIDEO_MODEL;
export const DEFAULT_VIDEO_MODEL_SPEC = VIDEO_MODEL_SPECS[DEFAULT_VIDEO_MODEL];

const EMPTY_VIDEO_CAPABILITIES = Object.freeze({
  ratioOptions: Object.freeze([]),
  durationOptions: Object.freeze([]),
  resolutionOptions: Object.freeze([]),
  supportedSeconds: Object.freeze([]),
  supportedPresets: Object.freeze([]),
  supportsReferenceImages: false,
  maxReferenceImages: 0,
});

const trim = (value) => String(value || '').trim();

const getVideoSecondsFromParams = (params = {}) => {
  const raw = params.seconds ?? params.duration;
  const seconds = Number(String(raw ?? '').replace(/s$/i, ''));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export const getDefaultVideoModelCode = () => DEFAULT_VIDEO_MODEL;

export const listVideoModelCodes = () => Object.keys(VIDEO_MODEL_SPECS);

export const isSupportedVideoModel = (modelCode) =>
  Object.prototype.hasOwnProperty.call(VIDEO_MODEL_SPECS, trim(modelCode));

export const getVideoModelSpec = (modelCode) => {
  const key = trim(modelCode);
  return VIDEO_MODEL_SPECS[key] || DEFAULT_VIDEO_MODEL_SPEC;
};

export const getVideoCapabilitiesForModel = (modelCode) =>
  getVideoModelSpec(modelCode).capabilities || EMPTY_VIDEO_CAPABILITIES;

export const getVideoRequestSpecForModel = (modelCode) => {
  const spec = getVideoModelSpec(modelCode);
  const request = spec.request || {};
  return {
    transport: request.transport || VIDEO_TRANSPORTS.MULTIPART,
    endpoint: request.endpoint || '',
    pollEndpoint: request.pollEndpoint || request.endpoint || '',
    referenceFieldName: request.referenceFieldName || '',
  };
};

export const getVideoResponseSpecForModel = (modelCode) =>
  getVideoModelSpec(modelCode).response || GROK_VIDEO_RESPONSE_SPEC;

export const getVideoAdapterKeyForModel = (modelCode) => {
  const spec = getVideoModelSpec(modelCode);
  return spec.adapter || spec.provider || VIDEO_ADAPTERS.GROK;
};

export const getVideoParamSchemaForModel = (modelCode) =>
  getVideoModelSpec(modelCode).paramSchema || DEFAULT_VIDEO_PARAM_SCHEMA;

export const getVideoPollingSpecForModel = (modelCode) =>
  getVideoModelSpec(modelCode).polling || DEFAULT_VIDEO_POLLING_SPEC;

export const getVideoPollingTimeoutForModel = (modelCode, params = {}) => {
  const spec = getVideoPollingSpecForModel(modelCode);
  const seconds = getVideoSecondsFromParams(params);
  const computed = seconds
    ? seconds * (spec.timeoutPerSecondMs || DEFAULT_VIDEO_POLLING_SPEC.timeoutPerSecondMs)
    : spec.minTimeoutMs;
  return clamp(
    computed,
    spec.minTimeoutMs || DEFAULT_VIDEO_POLLING_SPEC.minTimeoutMs,
    spec.maxTimeoutMs || DEFAULT_VIDEO_POLLING_SPEC.maxTimeoutMs,
  );
};

export const getVideoModelDefaults = (modelCode) => {
  const spec = getVideoModelSpec(modelCode);
  const defaults = spec.defaults || GROK_VIDEO_DEFAULTS;
  const capabilities = spec.capabilities || EMPTY_VIDEO_CAPABILITIES;
  const request = spec.request || {};
  return {
    duration: defaults.duration || GROK_VIDEO_DEFAULTS.duration,
    ratio: defaults.ratio || GROK_VIDEO_DEFAULTS.ratio,
    resolution: defaults.resolution || GROK_VIDEO_DEFAULTS.resolution,
    preset: defaults.preset || GROK_VIDEO_DEFAULTS.preset,
    maxReferenceImages:
      capabilities.maxReferenceImages ??
      EMPTY_VIDEO_CAPABILITIES.maxReferenceImages,
    referenceFieldName: request.referenceFieldName || '',
    size: defaults.size || '',
  };
};

export const getVideoRatioOptionsForModel = (modelCode) =>
  getVideoCapabilitiesForModel(modelCode).ratioOptions || [];

export const getVideoDurationOptionsForModel = (modelCode) =>
  getVideoCapabilitiesForModel(modelCode).durationOptions || [];

export const getVideoResolutionOptionsForModel = (modelCode) =>
  getVideoCapabilitiesForModel(modelCode).resolutionOptions || [];

export const getVideoResolutionNameForModel = (modelCode, resolution) => {
  const defaults = getVideoModelDefaults(modelCode);
  const resolutionOptions = getVideoResolutionOptionsForModel(modelCode);
  const normalized = trim(resolution).toLowerCase();
  if (!resolutionOptions.length) {
    return normalized || defaults.resolution;
  }
  return resolutionOptions.some((option) => option.value === normalized)
    ? normalized
    : defaults.resolution;
};

export const getVideoSizeForModel = (
  modelCode,
  { ratio, resolution, size } = {},
) => {
  const explicitSize = trim(size);
  if (explicitSize) return explicitSize;
  const spec = getVideoModelSpec(modelCode);
  const defaults = getVideoModelDefaults(modelCode);
  const normalizedRatio = trim(ratio) || defaults.ratio;
  const normalizedResolution = getVideoResolutionNameForModel(
    modelCode,
    resolution,
  );
  const sizeMap = spec.sizeMap || {};
  const ratioMap = sizeMap[normalizedRatio] || sizeMap[defaults.ratio] || {};
  return (
    ratioMap?.[normalizedResolution] ||
    ratioMap?.[defaults.resolution] ||
    defaults.size ||
    ''
  );
};

export const getVideoReferenceFieldNameForModel = (modelCode) =>
  getVideoRequestSpecForModel(modelCode).referenceFieldName;

export const getVideoParameterStateForModel = (modelCode) => {
  const model = trim(modelCode) || DEFAULT_VIDEO_MODEL;
  const defaults = getVideoModelDefaults(model);
  const capabilities = getVideoCapabilitiesForModel(model);
  return {
    model: getVideoModelSpec(model).modelCode,
    provider: getVideoModelSpec(model).provider,
    adapter: getVideoAdapterKeyForModel(model),
    defaults,
    capabilities,
    schema: getVideoParamSchemaForModel(model),
    ratioOptions: getVideoRatioOptionsForModel(model),
    durationOptions: getVideoDurationOptionsForModel(model),
    resolutionOptions: getVideoResolutionOptionsForModel(model),
    polling: getVideoPollingSpecForModel(model),
    supportsReferenceImages: Boolean(capabilities.supportsReferenceImages),
    maxReferenceImages: capabilities.maxReferenceImages || 0,
  };
};
