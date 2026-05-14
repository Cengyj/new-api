import assert from 'node:assert/strict';

import {
  VIDEO_ADAPTERS,
  getDefaultVideoModelCode,
  getVideoAdapterKeyForModel,
  getVideoCapabilitiesForModel,
  getVideoModelSpec,
  getVideoParamSchemaForModel,
  getVideoParameterStateForModel,
  getVideoPollingSpecForModel,
  getVideoPollingTimeoutForModel,
  getVideoResponseSpecForModel,
  getVideoRequestSpecForModel,
  listVideoModelCodes,
  isSupportedVideoModel,
} from '../videoModelRegistry.js';

assert.deepEqual(listVideoModelCodes(), ['grok-imagine-video']);
assert.equal(getDefaultVideoModelCode(), 'grok-imagine-video');
assert.equal(isSupportedVideoModel('grok-imagine-video'), true);
assert.equal(isSupportedVideoModel('unknown-model'), false);

const grokSpec = getVideoModelSpec('grok-imagine-video');
assert.equal(grokSpec.adapter, VIDEO_ADAPTERS.GROK);
assert.equal(grokSpec.defaults.resolution, '720p');
assert.equal(grokSpec.capabilities.maxReferenceImages, 7);
assert.equal(grokSpec.capabilities.supportsReferenceImages, true);
assert.equal(grokSpec.request.transport, 'multipart');
assert.equal(grokSpec.request.endpoint, '/pg/videos');
assert.equal(grokSpec.request.referenceFieldName, 'input_reference[]');
assert.equal(Object.hasOwn(grokSpec, 'defaultResolution'), false);
assert.equal(Object.hasOwn(grokSpec, 'referenceFieldName'), false);

const capabilities = getVideoCapabilitiesForModel('grok-imagine-video');
assert.equal(capabilities.durationOptions.length, 5);
assert.equal(capabilities.supportedSeconds.includes(20), true);

const requestSpec = getVideoRequestSpecForModel('grok-imagine-video');
assert.equal(requestSpec.pollEndpoint, '/pg/videos');
assert.equal(getVideoAdapterKeyForModel('grok-imagine-video'), 'grok');

const paramSchema = getVideoParamSchemaForModel('grok-imagine-video');
assert.equal(paramSchema.ratio.source, 'ratioOptions');
assert.equal(paramSchema.duration.source, 'durationOptions');
assert.equal(paramSchema.resolution.source, 'resolutionOptions');
assert.equal(paramSchema.referenceImages.source, 'capabilities.maxReferenceImages');

const responseSpec = getVideoResponseSpecForModel('grok-imagine-video');
assert.equal(responseSpec.contentUrlTemplate, '/v1/videos/{id}/content');
assert.equal(responseSpec.idFields.includes('task_id'), true);
assert.equal(responseSpec.urlFields.includes('metadata.url'), true);

const pollingSpec = getVideoPollingSpecForModel('grok-imagine-video');
assert.equal(pollingSpec.intervalMs, 2000);
assert.equal(pollingSpec.minTimeoutMs, 10 * 60 * 1000);
assert.equal(pollingSpec.maxTimeoutMs, 30 * 60 * 1000);
assert.equal(
  getVideoPollingTimeoutForModel('grok-imagine-video', { duration: '20s' }),
  10 * 60 * 1000,
);
assert.equal(
  getVideoPollingTimeoutForModel('grok-imagine-video', { seconds: '60' }),
  30 * 60 * 1000,
);

const parameterState = getVideoParameterStateForModel('grok-imagine-video');
assert.equal(parameterState.model, 'grok-imagine-video');
assert.equal(parameterState.adapter, 'grok');
assert.equal(parameterState.supportsReferenceImages, true);
assert.deepEqual(
  parameterState.resolutionOptions.map((option) => option.value),
  ['480p', '720p'],
);

const fallbackSpec = getVideoModelSpec('unknown-model');
assert.equal(fallbackSpec.modelCode, 'grok-imagine-video');
assert.equal(fallbackSpec.defaults.resolution, '720p');

console.log('video model registry regression checks passed');
