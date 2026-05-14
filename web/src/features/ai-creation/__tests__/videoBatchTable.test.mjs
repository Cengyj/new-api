import assert from 'node:assert/strict';

import {
  DURATION_LABELS,
  RATIO_LABELS,
  RESOLUTION_LABELS,
  VIDEO_DURATION_OPTIONS,
  VIDEO_RATIO_TABLE_OPTIONS,
  VIDEO_RESOLUTION_TABLE_OPTIONS,
  createVideoBatchRow,
  getVideoBatchDurationOptions,
  getVideoBatchLabels,
  getVideoBatchResolutionOptions,
  getVideoBatchRowDefaults,
  getVideoBatchRatioOptions,
  makeVideoOptionLabels,
  videoRowsFromMatrix,
} from '../videoBatchTable.js';
import { GROK_VIDEO_MODEL } from '../constants.js';

assert.deepEqual(
  getVideoBatchRatioOptions(GROK_VIDEO_MODEL).map((option) => option.value),
  ['16:9', '9:16', '1:1'],
);
assert.deepEqual(
  getVideoBatchDurationOptions(GROK_VIDEO_MODEL).map((option) => option.value),
  ['6s', '10s', '12s', '16s', '20s'],
);
assert.deepEqual(
  getVideoBatchResolutionOptions(GROK_VIDEO_MODEL).map(
    (option) => option.value,
  ),
  ['480p', '720p'],
);

assert.deepEqual(VIDEO_RATIO_TABLE_OPTIONS, getVideoBatchRatioOptions());
assert.deepEqual(VIDEO_DURATION_OPTIONS, getVideoBatchDurationOptions());
assert.deepEqual(
  VIDEO_RESOLUTION_TABLE_OPTIONS,
  getVideoBatchResolutionOptions(),
);

assert.equal(RATIO_LABELS['16:9'], '16:9');
assert.equal(DURATION_LABELS['10s'], '10s');
assert.equal(RESOLUTION_LABELS['720p'], '720p');
assert.deepEqual(makeVideoOptionLabels([{ value: 'x', label: 'X' }]), {
  x: 'X',
});

const labelGroups = getVideoBatchLabels(GROK_VIDEO_MODEL);
assert.equal(labelGroups.ratio['9:16'], '9:16');
assert.equal(labelGroups.duration['20s'], '20s');
assert.equal(labelGroups.resolution['480p'], '480p');

const defaults = getVideoBatchRowDefaults(GROK_VIDEO_MODEL);
assert.equal(defaults.ratio, '16:9');
assert.equal(defaults.duration, '6s');
assert.equal(defaults.resolution, '720p');
assert.equal(defaults.maxReferenceImages, 7);

const numericDurationRow = createVideoBatchRow(
  {
    prompt: 'move',
    ratio: '9:16',
    duration: 10,
    resolution: '480p',
    count: 30,
    images: Array.from({ length: 10 }, (_, index) => `image-${index}`),
  },
  GROK_VIDEO_MODEL,
);
assert.equal(numericDurationRow.duration, '10s');
assert.equal(numericDurationRow.count, 20);
assert.equal(numericDurationRow.images.length, 7);

const fallbackRow = createVideoBatchRow(
  {
    prompt: 'move',
    ratio: '21:9',
    duration: '99s',
    resolution: '1080p',
    count: 0,
  },
  GROK_VIDEO_MODEL,
);
assert.equal(fallbackRow.ratio, defaults.ratio);
assert.equal(fallbackRow.duration, defaults.duration);
assert.equal(fallbackRow.resolution, defaults.resolution);
assert.equal(fallbackRow.count, defaults.count);

const rows = videoRowsFromMatrix(
  [
    ['prompt', 'ratio', 'duration', 'resolution', 'count', 'images'],
    ['cinematic cat', '1:1', '12', '480p', 2, 'a.png;b.png'],
  ],
  GROK_VIDEO_MODEL,
);
assert.equal(rows.length, 1);
assert.equal(rows[0].prompt, 'cinematic cat');
assert.equal(rows[0].ratio, '1:1');
assert.equal(rows[0].duration, '12s');
assert.equal(rows[0].resolution, '480p');
assert.equal(rows[0].count, 2);
assert.deepEqual(rows[0].images, ['a.png', 'b.png']);

console.log('video batch table regression checks passed');
