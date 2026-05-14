import assert from 'node:assert/strict';

import { GROK_VIDEO_MODEL } from '../constants.js';
import {
  createBatchRowVideoParams,
  createSingleVideoParams,
  getVideoParameterState,
  getVideoReferenceImages,
  getVideoSeconds,
  normalizeVideoGenerationParams,
} from '../videoParams.js';

assert.equal(getVideoSeconds('10s'), 10);
assert.equal(getVideoSeconds('6'), 6);
assert.equal(getVideoSeconds('bad'), undefined);

const normalized = normalizeVideoGenerationParams({
  model: GROK_VIDEO_MODEL,
  prompt: 'move',
  ratio: '9:16',
  duration: '10s',
  resolution: '480p',
  preset: 'normal',
  referenceImages: ['ref-a', 'ref-b'],
});
assert.equal(normalized.model, GROK_VIDEO_MODEL);
assert.equal(normalized.provider, 'grok');
assert.equal(normalized.ratio, '9:16');
assert.equal(normalized.duration, '10s');
assert.equal(normalized.seconds, 10);
assert.equal(normalized.resolution, '480p');
assert.equal(normalized.resolution_name, '480p');
assert.equal(normalized.size, '720x1280');
assert.equal(normalized.preset, 'normal');
assert.equal(normalized.referenceFieldName, 'input_reference[]');
assert.equal(normalized.referenceCount, 2);
assert.deepEqual(normalized.referenceImages, ['ref-a', 'ref-b']);

const fallback = normalizeVideoGenerationParams({
  model: 'unknown-video-model',
  prompt: 'move',
  ratio: '21:9',
  duration: '99s',
  resolution: '1080p',
  preset: 'unknown',
});
assert.equal(fallback.model, GROK_VIDEO_MODEL);
assert.equal(fallback.ratio, '16:9');
assert.equal(fallback.duration, '6s');
assert.equal(fallback.seconds, 6);
assert.equal(fallback.resolution, '720p');
assert.equal(fallback.size, '1792x1024');
assert.equal(fallback.preset, 'normal');

const explicitSize = normalizeVideoGenerationParams({
  model: GROK_VIDEO_MODEL,
  ratio: '16:9',
  resolution: '720p',
  size: 'custom-size',
});
assert.equal(explicitSize.size, 'custom-size');

assert.deepEqual(
  getVideoReferenceImages(
    { 'input_reference[]': ['legacy-a', '', 'legacy-b'] },
    { supportsReferenceImages: true, maxReferenceImages: 7 },
  ),
  ['legacy-a', 'legacy-b'],
);
assert.equal(
  normalizeVideoGenerationParams({
    referenceImages: Array.from({ length: 10 }, (_, index) => `ref-${index}`),
  }).referenceImages.length,
  7,
);

const parameterState = getVideoParameterState(GROK_VIDEO_MODEL);
assert.equal(parameterState.adapter, 'grok');
assert.equal(parameterState.maxReferenceImages, 7);

const singleParams = createSingleVideoParams({
  model: GROK_VIDEO_MODEL,
  group: 'default',
  prompt: '  single move  ',
  ratio: '1:1',
  duration: 12,
  resolution: '480p',
  referenceImages: ['ref-a'],
});
assert.equal(singleParams.prompt, 'single move');
assert.equal(singleParams.count, 1);
assert.equal(singleParams.duration, '12s');
assert.equal(singleParams.size, '1024x1024');
assert.deepEqual(singleParams.referenceImages, ['ref-a']);

const batchParams = createBatchRowVideoParams(
  {
    id: 'row-1',
    prompt: '  batch move  ',
    ratio: '9:16',
    duration: '10s',
    resolution: '480p',
    count: 3,
    images: ['ref-1', 'ref-2'],
  },
  {
    model: GROK_VIDEO_MODEL,
    group: 'default',
    source: 'batch',
    batchRowIndex: 2,
  },
);
assert.equal(batchParams.prompt, 'batch move');
assert.equal(batchParams.count, 3);
assert.equal(batchParams.source, 'batch');
assert.equal(batchParams.batchRowId, 'row-1');
assert.equal(batchParams.batchRowIndex, 2);
assert.equal(batchParams.size, '720x1280');
assert.deepEqual(batchParams.referenceImages, ['ref-1', 'ref-2']);

console.log('video params regression checks passed');
